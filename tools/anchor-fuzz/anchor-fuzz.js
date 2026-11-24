#!/usr/bin/env node
'use strict';
// Patch-anchor fuzzer: does each active asar patch still apply — or fail
// loudly — when the code around its anchor is re-spelled the way a new
// minifier or bundler might re-spell it?
//
// For every (variant, patch) pair it:
//   1. rewrites the code around every patch's anchor in a pristine
//      .vite/build with one semantics-preserving variant (lib/variants.js)
//   2. runs the real patch function from scripts/patches/ on a copy
//   3. checks the result structurally (lib/patches.js) and classifies it:
//        OK        every site carries exactly the intended edit
//        FAIL      the patch exited non-zero          (safe: build stops)
//        NOOP      the patch changed nothing          (safe: the build's
//                  retirement tripwire stops on an unchanged bundle)
//        PARTIAL   some sites edited, others silently left as they were
//        MISAPPLY  a site edited into the wrong shape, or bytes changed
//                  outside the sites the patch owns
//        CORRUPT   the patch exited 0 but its output no longer parses
//      PARTIAL, MISAPPLY and CORRUPT ship: they are the dangerous ones.
//
// Usage: node --expose-internals anchor-fuzz.js --build DIR --repo DIR
//          [--patch a,b] [--variant a,b] [--jobs N] [--json FILE]
//          [--markdown FILE] [--keep] [--strict]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { parse, parseError, tokenize } = require('./lib/js');
const { VARIANTS, FILE_VARIANTS } = require('./lib/variants');
const { PATCHES } = require('./lib/patches');

const SAFE = new Set(['OK', 'FAIL', 'NOOP']);
const DANGER = new Set(['PARTIAL', 'MISAPPLY', 'CORRUPT']);
const CELL = { OK: 'ok', FAIL: 'fail', NOOP: 'noop', PARTIAL: 'PARTIAL',
    MISAPPLY: 'MISAPPLY', CORRUPT: 'CORRUPT', ORACLE: '?', NA: '-',
    INVALID: 'inv' };

function usage(code) {
    process.stderr.write(fs.readFileSync(__filename, 'utf8')
        .split('\n').filter((l) => l.startsWith('// Usage') ||
            l.startsWith('//   ')).join('\n') + '\n');
    process.exit(code);
}

function parseArgs(argv) {
    const o = { jobs: 1, keep: false, strict: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const val = () => {
            if (i + 1 >= argv.length) usage(2);
            return argv[++i];
        };
        switch (a) {
        case '--build': o.build = path.resolve(val()); break;
        case '--repo': o.repo = path.resolve(val()); break;
        case '--patch': o.patches = val().split(','); break;
        case '--variant': o.variants = val().split(','); break;
        case '--jobs': o.jobs = Math.max(1, Number(val()) || 1); break;
        case '--json': o.json = path.resolve(val()); break;
        case '--markdown': o.markdown = path.resolve(val()); break;
        case '--emit': o.emit = path.resolve(val()); break;
        case '--tmp': o.tmp = path.resolve(val()); break;
        case '--keep': o.keep = true; break;
        case '--strict': o.strict = true; break;
        case '-h': case '--help': usage(0); break;
        default:
            process.stderr.write(`Unknown argument: ${a}\n`);
            usage(2);
        }
    }
    if (!o.build || !o.repo) usage(2);
    o.patches = o.patches || Object.keys(PATCHES);
    o.variants = o.variants ||
        [...Object.keys(VARIANTS), ...Object.keys(FILE_VARIANTS)];
    for (const p of o.patches) {
        if (!PATCHES[p]) throw new Error(`unknown patch ${p}`);
    }
    for (const v of o.variants) {
        if (!VARIANTS[v] && !FILE_VARIANTS[v]) {
            throw new Error(`unknown variant ${v}`);
        }
    }
    return o;
}

function listFiles(dir, rel = '') {
    const out = [];
    for (const e of fs.readdirSync(path.join(dir, rel),
        { withFileTypes: true })) {
        const r = path.join(rel, e.name);
        if (e.isDirectory()) out.push(...listFiles(dir, r));
        else if (e.isFile()) out.push(r);
    }
    return out.sort();
}

// Merge overlapping [s, e) spans.
function merge(spans) {
    const out = [];
    for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0])) {
        const last = out[out.length - 1];
        if (last && s <= last[1]) last[1] = Math.max(last[1], e);
        else out.push([s, e]);
    }
    return out;
}

// Apply non-overlapping edits back to front. Overlapping edits after the
// first are dropped: two rewrites of one token cannot both hold.
function applyEdits(src, edits) {
    const kept = [];
    let lastEnd = -1;
    for (const e of [...edits].sort((a, b) => a.start - b.start ||
        a.end - b.end)) {
        if (e.start < lastEnd) continue;
        if (e.start === e.end && kept.length &&
            kept[kept.length - 1].start === e.start &&
            kept[kept.length - 1].end === e.end) {
            // two insertions at one point: keep both, in order
            kept[kept.length - 1].text += e.text;
            continue;
        }
        kept.push({ ...e });
        lastEnd = Math.max(lastEnd, e.end);
    }
    let out = src;
    for (const e of kept.reverse()) {
        out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    return { out, count: kept.length };
}

class Bundle {
    constructor(dir) {
        this.dir = dir;
        this.files = listFiles(dir);
        this.raw = new Map(this.files.map((f) =>
            [f, fs.readFileSync(path.join(dir, f))]));
        this.text = new Map();
        this.asts = new Map();
        this.toks = new Map();
    }
    src(f) {
        if (!this.text.has(f)) this.text.set(f, this.raw.get(f).toString());
        return this.text.get(f);
    }
    ast(f) {
        if (!this.asts.has(f)) this.asts.set(f, parse(this.src(f)));
        return this.asts.get(f);
    }
    tokens(f) {
        if (!this.toks.has(f)) this.toks.set(f, tokenize(this.src(f)));
        return this.toks.get(f);
    }
    js() {
        return this.files.filter((f) => f.endsWith('.js'));
    }
}

// Sites per patch per file, from the pristine bundle.
function locate(bundle, patches) {
    const sites = {};
    for (const p of patches) {
        sites[p] = {};
        for (const f of bundle.js()) {
            const s = PATCHES[p].sites(bundle.src(f));
            if (s.length) sites[p][f] = merge(s);
        }
    }
    return sites;
}

function makeCtx(bundle, files) {
    const taken = (n) => files.some((f) => bundle.src(f).includes(n));
    let k = 0;
    return {
        renames: new Map(),
        chains: new Map(),
        fresh(prefixes) {
            for (;;) {
                const n = prefixes[k % prefixes.length] + (k++).toString(36);
                if (!taken(n)) return n;
            }
        },
    };
}

// The variant's copy of every file that holds a site of any patch.
function buildVariant(bundle, sites, variant) {
    const windows = {};
    for (const p of Object.keys(sites)) {
        for (const [f, s] of Object.entries(sites[p])) {
            windows[f] = merge([...(windows[f] || []), ...s]);
        }
    }
    const files = Object.keys(windows).sort();
    const ctx = makeCtx(bundle, files);
    const out = {};
    let total = 0;
    for (const f of files) {
        const src = bundle.src(f);
        let edits = [];
        if (FILE_VARIANTS[variant]) {
            edits = FILE_VARIANTS[variant](src, windows[f]);
        } else {
            const all = bundle.tokens(f);
            for (const [from, to] of windows[f]) {
                const toks = all.filter((t) => t.start >= from &&
                    t.end <= to);
                if (!toks.length) continue;
                const env = { src, toks, from: toks[0].start,
                    to: toks[toks.length - 1].end };
                Object.defineProperty(env, 'ast',
                    { get: () => bundle.ast(f) });
                edits.push(...VARIANTS[variant](env, ctx));
            }
        }
        const { out: text, count } = applyEdits(src, edits);
        total += count;
        out[f] = text;
    }
    return { files: out, edits: total };
}

function runPatch(repo, root, fn) {
    const driver = 'source "$1/scripts/patches/app-asar.sh" || exit 9;' +
        ' for f in "$1"/scripts/patches/*.sh; do' +
        ' [[ $f == */app-asar.sh ]] || source "$f" || exit 9; done;' +
        ' cd "$2" || exit 9; "$3"';
    const r = spawnSync('bash', ['-c', driver, 'anchor-fuzz', repo, root,
        fn], { encoding: 'utf8', timeout: 180000,
        maxBuffer: 16 * 1024 * 1024 });
    const output = ((r.stdout || '') + (r.stderr || '')).trim();
    return { rc: r.status === null ? 124 : r.status, output };
}

// Remove [vNode, oNode] pairs from V and O; the rest must be identical.
function strayCheck(vSrc, oSrc, results, markers) {
    const pairs = results.filter((r) => r.vNode && r.oNode)
        .map((r) => [r.vNode, r.oNode])
        .sort((a, b) => a[0].start - b[0].start);
    const kept = [];
    for (const p of pairs) {
        const last = kept[kept.length - 1];
        if (last && p[0].start < last[0].end) continue; // nested
        kept.push(p);
    }
    const cut = (src, side) => {
        let s = '';
        let at = 0;
        for (const p of kept) {
            s += src.slice(at, p[side].start) + '\u0000';
            at = p[side].end;
        }
        return s + src.slice(at);
    };
    let v = cut(vSrc, 0);
    let o = cut(oSrc, 1);
    for (const m of markers || []) {
        v = v.split(m).join('');
        o = o.split(m).join('');
    }
    if (v === o) return null;
    let i = 0;
    while (i < v.length && v[i] === o[i]) i++;
    // map back to an output offset: each cut site is one NUL in `o`
    const before = o.slice(0, i);
    const line = before.split('\n').length;
    return `bytes outside the patch sites changed (output line ${line}` +
        `${before.includes('/*') && !before.slice(before.lastIndexOf('/*'))
            .includes('*/') ? ', inside a comment' : ''}): ` +
        JSON.stringify(o.slice(Math.max(0, i - 40), i + 60)
            .replace(/\u0000/g, '\u2026'));
}

// The line of patch output that says why it stopped.
function why(output) {
    const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
    const hit = lines.filter((l) => /WARNING|ERROR|Anchor '|matched|expected/
        .test(l));
    return (hit.length ? hit[0] : lines[lines.length - 1] || '')
        .slice(0, 200);
}

function classify(rec) {
    if (rec.rc !== 0) return 'FAIL';
    if (rec.corrupt) return 'CORRUPT';
    if (rec.stray) return 'MISAPPLY';
    const states = rec.sites.map((s) => s.state);
    if (states.includes('wrong')) return 'MISAPPLY';
    if (states.includes('error')) return 'ORACLE';
    if (states.every((s) => s === 'ok')) return 'OK';
    if (states.every((s) => s === 'unpatched')) {
        return rec.changed ? 'MISAPPLY' : 'NOOP';
    }
    return 'PARTIAL';
}

function readTree(root) {
    const m = new Map();
    for (const f of listFiles(root)) {
        m.set(f, fs.readFileSync(path.join(root, f)));
    }
    return m;
}

function fuzzOne(o, bundle, sites, variant, patch, vFiles, vAsts) {
    const spec = PATCHES[patch];
    const rec = { patch, variant, sites: [], notes: [] };
    const tmp = fs.mkdtempSync(path.join(o.tmp, `${variant}-`));
    const build = path.join(tmp, 'app.asar.contents', '.vite', 'build');
    try {
        fs.mkdirSync(path.dirname(build), { recursive: true });
        spawnSync('cp', ['-a', bundle.dir, build]);
        for (const [f, text] of Object.entries(vFiles)) {
            fs.writeFileSync(path.join(build, f), text);
        }
        const run = runPatch(o.repo, tmp, patch);
        rec.rc = run.rc;
        rec.output = run.output.split('\n').slice(-6).join('\n');
        if (run.rc !== 0) {
            rec.reason = why(run.output);
            return rec;
        }

        const after = readTree(build);
        const own = Object.keys(sites[patch]).filter((f) =>
            !spec.needs || spec.needs.test(bundle.src(f)));
        const strays = [];
        const vText = (f) => vFiles[f] !== undefined ? vFiles[f]
            : bundle.src(f);
        for (const f of bundle.files) {
            const now = after.get(f);
            const was = vFiles[f] !== undefined ? Buffer.from(vFiles[f])
                : bundle.raw.get(f);
            if (now && now.equals(was)) continue;
            rec.changed = true;
            if (!own.includes(f)) strays.push(`${f} changed`);
        }
        for (const f of own) {
            const oSrc = after.get(f).toString();
            const vSrc = vText(f);
            const err = oSrc === vSrc ? null : parseError(oSrc);
            if (err) {
                rec.corrupt = `${f}: ${err}`;
                return rec;
            }
            const vAst = vAsts(f);
            const oAst = oSrc === vSrc ? vAst : parse(oSrc);
            const res = spec.oracle(vSrc, oSrc, vAst, oAst);
            for (const r of res) {
                rec.sites.push({ file: f, name: r.name, state: r.state,
                    why: r.why });
            }
            const stray = res.some((r) => r.state === 'wrong') ? null
                : strayCheck(vSrc, oSrc, res, spec.markers);
            if (stray) strays.push(`${f}: ${stray}`);
        }
        if (strays.length) rec.stray = strays.join('; ');

        // Re-run over the patched tree: a correct patch recognises its
        // own output (the build's PATCH_STAGE_RERUN pass).
        if (classify(rec) === 'OK') {
            const again = runPatch(o.repo, tmp, patch);
            const changed = [...readTree(build)].some(([f, b]) =>
                !after.get(f) || !after.get(f).equals(b));
            if (again.rc !== 0 || changed) {
                rec.notes.push(`re-run ${again.rc ? 'failed' : 'changed ' +
                    'the patched bundle'} (not idempotent)`);
            }
        }
        return rec;
    } finally {
        if (!o.keep) fs.rmSync(tmp, { recursive: true, force: true });
        else rec.kept = tmp;
    }
}

function fuzzVariant(o, bundle, sites, variant) {
    const v = buildVariant(bundle, sites, variant);
    const recs = [];
    if (variant !== 'identity' && v.edits === 0) {
        return o.patches.map((patch) => ({ patch, variant, result: 'NA',
            sites: [], notes: ['variant changes nothing at these sites'] }));
    }
    const vAstCache = new Map();
    for (const [f, text] of Object.entries(v.files)) {
        if (text === bundle.src(f)) {
            delete v.files[f];
            continue;
        }
        const err = parseError(text);
        if (err) {
            return o.patches.map((patch) => ({ patch, variant,
                result: 'INVALID', sites: [],
                notes: [`variant output does not parse: ${f}: ${err}`] }));
        }
    }
    const vAsts = (f) => {
        if (v.files[f] === undefined) return bundle.ast(f);
        if (!vAstCache.has(f)) vAstCache.set(f, parse(v.files[f]));
        return vAstCache.get(f);
    };
    for (const patch of o.patches) {
        const touched = Object.keys(sites[patch]).some((f) =>
            v.files[f] !== undefined);
        if (variant !== 'identity' && !touched) {
            recs.push({ patch, variant, result: 'NA', sites: [],
                notes: ['variant changes nothing at this patch\'s sites'] });
            continue;
        }
        const rec = fuzzOne(o, bundle, sites, variant, patch, v.files, vAsts);
        rec.result = classify(rec);
        recs.push(rec);
        process.stderr.write(`  ${variant} × ${patch}: ${rec.result}\n`);
    }
    return recs;
}

function matrix(o, recs) {
    const at = (p, v) => recs.find((r) => r.patch === p && r.variant === v);
    const w = Math.max(...o.patches.map((p) => p.length));
    const cols = o.variants;
    const lines = [];
    lines.push(cols.map((v, i) => ' '.repeat(w + 2) +
        '│ '.repeat(i) + v).join('\n'));
    for (const p of o.patches) {
        lines.push(p.padEnd(w + 2) + cols.map((v) => {
            const r = at(p, v);
            return r ? CELL[r.result] : ' ';
        }).join(' '));
    }
    return lines.join('\n');
}

function markdown(o, recs) {
    const at = (p, v) => recs.find((r) => r.patch === p && r.variant === v);
    const lines = ['| patch | ' + o.variants.join(' | ') + ' |',
        '|---|' + o.variants.map(() => ':-:').join('|') + '|'];
    for (const p of o.patches) {
        lines.push(`| \`${p.replace(/^patch_/, '')}\` | ` + o.variants.map(
            (v) => {
                const r = at(p, v);
                if (!r) return ' ';
                const c = CELL[r.result];
                return DANGER.has(r.result) ? `**${c}**` : c;
            }).join(' | ') + ' |');
    }
    lines.push('', 'ok = applied correctly · fail = patch exited non-zero ' +
        '(safe) · noop = changed nothing (safe, the build tripwire stops) · ' +
        '**PARTIAL / MISAPPLY / CORRUPT** = would ship a wrong bundle · ' +
        '? = oracle could not read the variant · - = variant does not ' +
        'touch this patch · inv = variant did not parse');
    const bad = recs.filter((r) => !SAFE.has(r.result) && r.result !== 'NA');
    if (bad.length) {
        lines.push('', '<details><summary>Details</summary>', '');
        for (const r of bad) lines.push(...detail(r).map((l) => '    ' + l));
        lines.push('', '</details>');
    }
    const noted = notes(recs);
    if (noted.length) {
        lines.push('', '<details><summary>Notes on the unmodified ' +
            'bundle</summary>', '');
        for (const r of noted) {
            lines.push(...detail(r).map((l) => '    ' + l));
        }
        lines.push('', '</details>');
    }
    const safe = recs.filter((r) => r.result === 'FAIL' ||
        r.result === 'NOOP');
    if (safe.length) {
        lines.push('', '<details><summary>Safe stops: which anchor ' +
            'gave up, and why</summary>', '');
        for (const r of safe) {
            lines.push(`    ${CELL[r.result]}: ${r.patch} × ${r.variant} — ` +
                (r.reason || 'changed nothing'));
        }
        lines.push('', '</details>');
    }
    return lines.join('\n') + '\n';
}

// What the oracles noticed about correct results on the real bytes
// (identity only: the same note on every variant is noise).
function notes(recs) {
    return recs.filter((r) => r.variant === 'identity' &&
        r.result === 'OK' &&
        (r.sites.some((x) => x.why) || (r.notes || []).length));
}

function detail(r) {
    const out = [`${r.result}: ${r.patch} × ${r.variant}`];
    if (r.corrupt) out.push(`  output does not parse: ${r.corrupt}`);
    if (r.stray) out.push(`  ${r.stray}`);
    for (const s of r.sites) {
        if (s.state !== 'ok' || s.why) {
            out.push(`  ${s.name} [${s.file}]: ${s.state}` +
                (s.why ? ` — ${s.why}` : ''));
        }
    }
    for (const n of r.notes || []) out.push(`  note: ${n}`);
    return out;
}

async function parallel(o, argv) {
    const queue = [...o.variants];
    const recs = [];
    const worker = async () => {
        while (queue.length) {
            const v = queue.shift();
            const emit = path.join(o.tmp, `emit-${v}.json`);
            const args = ['--expose-internals', __filename, ...argv,
                '--variant', v, '--jobs', '1', '--emit', emit,
                '--tmp', o.tmp];
            await new Promise((res) => {
                const c = spawn(process.execPath, args,
                    { stdio: ['ignore', 'ignore', 'inherit'] });
                c.on('exit', res);
            });
            try {
                recs.push(...JSON.parse(fs.readFileSync(emit, 'utf8')));
            } catch (e) {
                recs.push(...o.patches.map((patch) => ({ patch, variant: v,
                    result: 'ORACLE', sites: [],
                    notes: [`worker died: ${e.message}`] })));
            }
        }
    };
    await Promise.all(Array.from({ length: o.jobs }, worker));
    return recs;
}

async function main() {
    const argv = process.argv.slice(2);
    const o = parseArgs(argv);
    const ownTmp = !o.tmp;
    o.tmp = o.tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-fuzz.'));
    try {
        let recs;
        if (o.jobs > 1 && o.variants.length > 1) {
            const pass = argv.filter((a, i) => !['--variant', '--jobs',
                '--json', '--markdown'].includes(a) && !['--variant',
                '--jobs', '--json', '--markdown'].includes(argv[i - 1]));
            recs = await parallel(o, pass);
        } else {
            const bundle = new Bundle(o.build);
            const sites = locate(bundle, o.patches);
            recs = [];
            for (const v of o.variants) {
                recs.push(...fuzzVariant(o, bundle, sites, v));
            }
        }
        if (o.emit) {
            fs.writeFileSync(o.emit, JSON.stringify(recs));
            return 0;
        }
        const order = (r) => o.variants.indexOf(r.variant);
        recs.sort((a, b) => order(a) - order(b));
        process.stdout.write(matrix(o, recs) + '\n\n');
        for (const r of recs) {
            if (!SAFE.has(r.result) && r.result !== 'NA') {
                process.stdout.write(detail(r).join('\n') + '\n');
            }
        }
        const noted = notes(recs);
        if (noted.length) {
            process.stdout.write('\nNotes on the unmodified bundle:\n' + noted.map(
                (r) => detail(r).join('\n')).join('\n') + '\n');
        }
        const safe = recs.filter((r) => r.result === 'FAIL' ||
            r.result === 'NOOP');
        if (safe.length) {
            process.stdout.write('\nSafe stops (brittle anchors):\n' +
                safe.map((r) => `  ${CELL[r.result]}: ${r.patch} × ` +
                    `${r.variant} — ${r.reason || 'changed nothing'}`)
                    .join('\n') + '\n');
        }
        const counts = {};
        for (const r of recs) counts[r.result] = (counts[r.result] || 0) + 1;
        process.stdout.write('\n' + Object.entries(counts)
            .map(([k, n]) => `${k}=${n}`).join(' ') + '\n');
        if (o.json) fs.writeFileSync(o.json, JSON.stringify(recs, null, 1));
        if (o.markdown) fs.writeFileSync(o.markdown, markdown(o, recs));
        const danger = recs.some((r) => DANGER.has(r.result));
        const broken = recs.some((r) => r.variant === 'identity' &&
            r.result !== 'OK');
        if (broken) {
            process.stderr.write('identity row is not all OK: either a ' +
                'patch mis-applies to the unmodified bundle (a finding: ' +
                'see above) or the site map or an oracle is stale\n');
            return 3;
        }
        return o.strict && danger ? 2 : 0;
    } finally {
        if (ownTmp && !o.keep) fs.rmSync(o.tmp, { recursive: true,
            force: true });
    }
}

if (require.main === module) {
    main().then((rc) => process.exit(rc), (e) => {
        process.stderr.write(`${e.stack || e}\n`);
        process.exit(1);
    });
}

module.exports = { applyEdits, merge, classify, strayCheck, buildVariant,
    locate, Bundle, matrix, markdown };
