'use strict';
// Per-patch fuzz specs: where each active asar patch's anchors sit in
// the official bundle (so variants rewrite the code the patch actually
// reads), and an oracle that checks the patched output structurally.
//
// The oracles state what each patch is FOR, on the parsed AST, so they
// hold across every variant: quote style, whitespace, identifier names
// and boolean spelling all wash out in canon(). Each oracle compares
// the variant input (V) with the patch output (O) and returns one state
// per site:
//   ok         the intended edit, and nothing else, at this site
//   unpatched  the site is exactly as in V
//   wrong      the site changed, but not into the intended shape
//   error      the oracle could not find the site in V (variant or
//              oracle problem, not a patch finding)
// plus the V/O nodes it accounted for, so the runner can check that
// every byte outside them is untouched.

const { canon, strVal, findAll } = require('./js');

const c = (src, n) => canon(src, n.start, n.end);
const cs = (s) => canon(s);
// The member a call goes through, seeing past (0,x.y)( and x?.y(.
const unchain = (n) => n && n.type === 'ChainExpression' ? n.expression : n;
function callee(n) {
    let f = unchain(n).callee;
    if (f.type === 'SequenceExpression' && f.expressions.length === 2 &&
        f.expressions[0].type === 'Literal' && f.expressions[0].value === 0) {
        f = f.expressions[1];
    }
    if (f.type === 'ChainExpression') f = f.expression;
    return f;
}
// A call (not wrapped in a ChainExpression: unchain() the operand of an
// enclosing expression first) through a member named prop.
const isCall = (n, prop, argc) => Boolean(n) && n.type === 'CallExpression' &&
    callee(n).type === 'MemberExpression' && !callee(n).computed &&
    callee(n).property.name === prop &&
    (argc === undefined || n.arguments.length === argc);
const isFn = (n) => Boolean(n) &&
    /^(?:Arrow)?Function(?:Expression|Declaration)$/.test(n.type);

// The quote class the patches' own anchors use.
const Q = '[`"\']';

const KDE = cs('(process.env.XDG_CURRENT_DESKTOP||"").toLowerCase()' +
    '.includes("kde")');
const GATE = cs('process.platform==="linux"&&' +
    'process.env.COWORK_VM_BACKEND==="bwrap"');

// Site windows: [start, end) spans of the pristine source around each
// anchor, widened by `before`/`after` so variants also rewrite the
// context a patch inspects (e.g. virtiofsd's 1200-char gate window).
function spans(src, re, before, after) {
    const out = [];
    const g = new RegExp(re.source, re.flags.replace('g', '') + 'g');
    for (const m of src.matchAll(g)) {
        out.push([Math.max(0, m.index - before),
            Math.min(src.length, m.index + m[0].length + after)]);
    }
    return out;
}

function site(name, state, why, vNode, oNode) {
    return { name, state, why: why || '', vNode, oNode };
}

// canon of src[outer] with the `inner` node replaced by `withNode`.
function canonReplacing(src, outer, inner, withNode) {
    return cs(src.slice(outer.start, inner.start) +
        src.slice(withNode.start, withNode.end) +
        src.slice(inner.end, outer.end));
}

const PATCHES = {};

// cond?"TrayIconLinux-Dark.png":"TrayIconLinux.png" gains the
// CLAUDE_TRAY_USE_DARK_ICON tri-state wrapped around its DE/theme check.
PATCHES.patch_tray_icon_env_override = {
    script: 'tray-icon-selection.sh',
    sites: (src) => spans(src,
        /[`"']TrayIconLinux-Dark\.png[`"']\s*:\s*[`"']TrayIconLinux\.png[`"']/,
        400, 60),
    oracle(vSrc, oSrc, vAst, oAst) {
        const pick = (ast) => findAll(ast, (n) =>
            n.type === 'ConditionalExpression' &&
            strVal(n.consequent) === 'TrayIconLinux-Dark.png' &&
            strVal(n.alternate) === 'TrayIconLinux.png');
        const [cv, cv2] = pick(vAst);
        const [co, co2] = pick(oAst);
        if (!cv || cv2 || !co || co2) {
            return [site('ternary', 'error', 'expected exactly one tray ' +
                'ternary in V and in O')];
        }
        if (c(vSrc, cv.test) === c(oSrc, co.test)) {
            return [site('ternary', 'unpatched', '', cv, co)];
        }
        // Flatten V's ||-chain; the tri-state must wrap the operands
        // from the GNOME comparison on, and leave any before it alone.
        const ors = [];
        (function flat(n) {
            if (n.type === 'LogicalExpression' && n.operator === '||') {
                flat(n.left);
                flat(n.right);
            } else {
                ors.push(n);
            }
        })(cv.test);
        const k = ors.findIndex((n) => c(vSrc, n).includes('"gnome"'));
        if (k === -1) {
            return [site('ternary', 'error', 'no GNOME check in V', cv, co)];
        }
        const env = 'process.env.CLAUDE_TRAY_USE_DARK_ICON';
        const want = cs(vSrc.slice(cv.test.start, ors[k].start) +
            env + '==="1"||' + env + '!=="0"&&(' +
            vSrc.slice(ors[k].start, cv.test.end) + ')');
        if (c(oSrc, co.test) !== want) {
            return [site('ternary', 'wrong', 'condition is ' +
                c(oSrc, co.test).slice(0, 200), cv, co)];
        }
        const note = k ? 'kept in front of the tri-state (wins even when ' +
            'the flag is 0): ' + c(vSrc, ors[0]) : '';
        return [site('ternary', 'ok', note, cv, co)];
    },
};

// switch(process.platform){...;default:return null} gains
// case"linux":return"/etc/claude/org-plugins"; before default.
PATCHES.patch_org_plugins_path = {
    script: 'org-plugins.sh',
    sites: (src) => spans(src,
        /[`"']org-plugins[`"']\)\s*;\s*default\s*:\s*return\s+null/, 300, 40),
    oracle(vSrc, oSrc, vAst, oAst) {
        const pick = (src, ast) => findAll(ast, (n) =>
            n.type === 'SwitchStatement' &&
            c(src, n.discriminant) === 'process.platform' &&
            n.cases.some((k) => strVal(k.test) === 'darwin' &&
                c(src, k).includes(
                    '/Library/Application Support/Claude/org-plugins')));
        const [sv, sv2] = pick(vSrc, vAst);
        const [so, so2] = pick(oSrc, oAst);
        if (!sv || sv2 || !so || so2) {
            return [site('switch', 'error', 'expected exactly one ' +
                'org-plugins platform switch in V and in O')];
        }
        const linux = so.cases.filter((k) => strVal(k.test) === 'linux');
        if (linux.length === 0) {
            return [site('switch', c(vSrc, sv) === c(oSrc, so) ? 'unpatched'
                : 'wrong', 'no linux case', sv, so)];
        }
        const at = so.cases.indexOf(linux[0]);
        const next = so.cases[at + 1];
        const want = cs('case"linux":return"/etc/claude/org-plugins";');
        if (linux.length > 1 || c(oSrc, linux[0]) !== want ||
            !next || next.test !== null) {
            return [site('switch', 'wrong', 'linux case is not exactly ' +
                'case"linux":return"/etc/claude/org-plugins" right ' +
                'before default', sv, so)];
        }
        const without = cs(oSrc.slice(so.start, linux[0].start) +
            oSrc.slice(linux[0].end, so.end));
        if (without !== c(vSrc, sv)) {
            return [site('switch', 'wrong', 'other cases changed', sv, so)];
        }
        return [site('switch', 'ok', '', sv, so)];
    },
};

// return A||(G?F(x,y.constants.X_OK):null) -> return A||F(x,y.constants.X_OK)
PATCHES.patch_virtiofsd_probe = {
    script: 'virtiofsd-probe.sh',
    sites: (src) => spans(src,
        new RegExp(String.raw`\[\s*${Q}/usr/libexec/virtiofsd${Q}\s*,` +
            String.raw`\s*${Q}/usr/bin/virtiofsd${Q}\s*\]`),
        60, 1300),
    oracle(vSrc, oSrc, vAst, oAst) {
        const xok = (src, call) => Boolean(call) &&
            call.type === 'CallExpression' && call.arguments.length === 2 &&
            c(src, call.arguments[1]).endsWith('.constants.X_OK');
        const gated = (src, ast) => findAll(ast, (n) =>
            n.type === 'ReturnStatement' && n.argument &&
            n.argument.type === 'LogicalExpression' &&
            n.argument.operator === '||' &&
            n.argument.right.type === 'ConditionalExpression' &&
            n.argument.right.alternate.type === 'Literal' &&
            n.argument.right.alternate.value === null &&
            xok(src, n.argument.right.consequent));
        const [rv, rv2] = gated(vSrc, vAst);
        if (!rv || rv2) {
            return [site('resolver', 'error', 'expected exactly one gated ' +
                'virtiofsd resolver in V')];
        }
        const left = c(vSrc, rv.argument.left);
        const call = c(vSrc, rv.argument.right.consequent);
        const still = gated(oSrc, oAst).filter((n) =>
            c(oSrc, n.argument.left) === left);
        const ungated = findAll(oAst, (n) => n.type === 'ReturnStatement' &&
            n.argument && n.argument.type === 'LogicalExpression' &&
            n.argument.operator === '||' && xok(oSrc, n.argument.right) &&
            c(oSrc, n.argument.left) === left);
        if (still.length === 1 && ungated.length === 0) {
            return [site('resolver', c(vSrc, rv) === c(oSrc, still[0])
                ? 'unpatched' : 'wrong', '', rv, still[0])];
        }
        if (still.length !== 0 || ungated.length !== 1) {
            return [site('resolver', 'wrong', `gated=${still.length} ` +
                `ungated=${ungated.length} (want 0 and 1)`)];
        }
        const ro = ungated[0];
        if (c(oSrc, ro.argument.right) !== call) {
            return [site('resolver', 'wrong', 'fallback call changed: ' +
                c(oSrc, ro.argument.right), rv, ro)];
        }
        return [site('resolver', 'ok', '', rv, ro)];
    },
};

// ["/usr/share/OVMF/OVMF_CODE_4M.fd","/usr/share/OVMF/OVMF_CODE.fd"]
// gains the two edk2 paths at the end.
PATCHES.patch_cowork_firmware_probe = {
    script: 'cowork-firmware-probe.sh',
    sites: (src) => spans(src,
        /\[\s*[`"']\/usr\/share\/OVMF\/OVMF_CODE_4M\.fd[`"']/, 120, 120),
    oracle(vSrc, oSrc, vAst, oAst) {
        const ovmf = ['/usr/share/OVMF/OVMF_CODE_4M.fd',
            '/usr/share/OVMF/OVMF_CODE.fd'];
        const edk2 = ['/usr/share/edk2/x64/OVMF_CODE.4m.fd',
            '/usr/share/edk2/ovmf/OVMF_CODE.fd'];
        const pick = (ast) => findAll(ast, (n) =>
            n.type === 'ArrayExpression' && n.elements.length >= 2 &&
            strVal(n.elements[0]) === ovmf[0] &&
            strVal(n.elements[1]) === ovmf[1]);
        const [av, av2] = pick(vAst);
        const [ao, ao2] = pick(oAst);
        if (!av || av2 || !ao || ao2 || av.elements.length !== 2) {
            return [site('array', 'error', 'expected exactly one 2-entry ' +
                'OVMF array in V and one in O')];
        }
        const vals = ao.elements.map(strVal);
        if (vals.length === 2) {
            return [site('array', 'unpatched', '', av, ao)];
        }
        if (JSON.stringify(vals) !== JSON.stringify([...ovmf, ...edk2])) {
            return [site('array', 'wrong', JSON.stringify(vals), av, ao)];
        }
        return [site('array', 'ok', '', av, ao)];
    },
};

// Three edits, all gated on COWORK_VM_BACKEND=bwrap:
//   A  function X(){return process.platform,Y()}  -> if(GATE)return{...};
//   B  P(H,["-socket",S()],{stdio:[...]})         -> node daemon when flagged
//   C1 async function X(a,b){...download...}      -> if(GATE){return!1} first
PATCHES.patch_cowork_bwrap = {
    script: 'cowork-bwrap.sh',
    markers: ['/*cowork-bwrap-spawn*/', '/*cowork-bwrap-dl*/'],
    sites: (src) => [
        ...spans(src, /return process\.platform,[\w$]+\(\)\}/, 80, 20),
        ...spans(src, /[`"']-socket[`"']/, 140, 120),
        ...spans(src, /\[downloadVM\] Download already in progress/, 260, 40),
    ],
    oracle(vSrc, oSrc, vAst, oAst) {
        const out = [];
        const isEval = (src, f) => f.type === 'FunctionDeclaration' &&
            f.params.length === 0 && f.body.body.length >= 1 && (() => {
                const r = f.body.body[f.body.body.length - 1];
                return r.type === 'ReturnStatement' && r.argument &&
                    r.argument.type === 'SequenceExpression' &&
                    r.argument.expressions.length === 2 &&
                    c(src, r.argument.expressions[0]) === 'process.platform' &&
                    r.argument.expressions[1].type === 'CallExpression' &&
                    r.argument.expressions[1].arguments.length === 0;
            })();
        const av = findAll(vAst, (n) => isEval(vSrc, n));
        if (av.length !== 1) {
            out.push(site('A', 'error', `V has ${av.length} evaluators`));
        } else {
            const name = av[0].id.name;
            const ao = findAll(oAst, (n) => isEval(oSrc, n) &&
                n.id.name === name);
            if (ao.length !== 1) {
                out.push(site('A', 'wrong', 'evaluator lost or duplicated'));
            } else if (c(vSrc, av[0]) === c(oSrc, ao[0])) {
                out.push(site('A', 'unpatched', '', av[0], ao[0]));
            } else {
                const b = ao[0].body.body;
                const ok = b.length === 2 && b[0].type === 'IfStatement' &&
                    c(oSrc, b[0].test) === GATE &&
                    c(oSrc, b[0].consequent) ===
                        cs('return{status:"supported"};') &&
                    !b[0].alternate &&
                    c(oSrc, b[1]) === c(vSrc, av[0].body.body[0]);
                out.push(site('A', ok ? 'ok' : 'wrong',
                    ok ? '' : c(oSrc, ao[0]).slice(0, 200), av[0], ao[0]));
            }
        }
        const isSpawn = (src, n) => n.type === 'CallExpression' &&
            n.arguments.length === 3 &&
            n.arguments[2].type === 'ObjectExpression' &&
            c(src, n.arguments[2]).includes('stdio:');
        const bv = findAll(vAst, (n) => isSpawn(vSrc, n) &&
            n.arguments[1].type === 'ArrayExpression' &&
            n.arguments[1].elements.length === 2 &&
            strVal(n.arguments[1].elements[0]) === '-socket');
        if (bv.length !== 1) {
            out.push(site('B', 'error', `V has ${bv.length} helper spawns`));
        } else {
            const v = bv[0];
            const sock = c(vSrc, v.arguments[1].elements[1]);
            const bo = findAll(oAst, (n) => isSpawn(oSrc, n) &&
                c(oSrc, n.callee) === c(vSrc, v.callee) &&
                c(oSrc, n).includes(sock));
            if (bo.length !== 1) {
                out.push(site('B', 'wrong',
                    `O has ${bo.length} matching spawns`));
            } else if (c(vSrc, v) === c(oSrc, bo[0])) {
                out.push(site('B', 'unpatched', '', v, bo[0]));
            } else {
                const [a0, a1, a2] = bo[0].arguments;
                const daemon = 'require("path").join(' +
                    'process.resourcesPath,"cowork-vm-service.js")';
                const marker = oSrc.slice(Math.max(0, bo[0].start - 40),
                    bo[0].start).includes('/*cowork-bwrap-spawn*/');
                const ok = marker &&
                    a0.type === 'ConditionalExpression' &&
                    c(oSrc, a0.test) === GATE &&
                    c(oSrc, a0.consequent) ===
                        cs('process.env.COWORK_NODE_PATH||"node"') &&
                    c(oSrc, a0.alternate) === c(vSrc, v.arguments[0]) &&
                    a1.type === 'ConditionalExpression' &&
                    c(oSrc, a1.test) === GATE &&
                    c(oSrc, a1.consequent) ===
                        cs(`[${daemon},"-socket",${sock}]`) &&
                    c(oSrc, a1.alternate) === c(vSrc, v.arguments[1]) &&
                    c(oSrc, a2) === c(vSrc, v.arguments[2]);
                out.push(site('B', ok ? 'ok' : 'wrong', ok ? ''
                    : c(oSrc, bo[0]).slice(0, 240), v, bo[0]));
            }
        }
        const isDl = (src, n) => n.type === 'FunctionDeclaration' &&
            n.async && n.params.length === 2 &&
            c(src, n.body).includes(
                '[downloadVM] Download already in progress');
        const cv = findAll(vAst, (n) => isDl(vSrc, n));
        if (cv.length !== 1) {
            out.push(site('C1', 'error', `V has ${cv.length} download fns`));
        } else {
            const co = findAll(oAst, (n) => isDl(oSrc, n) &&
                n.id.name === cv[0].id.name);
            if (co.length !== 1) {
                out.push(site('C1', 'wrong', 'download function lost'));
            } else if (c(vSrc, cv[0]) === c(oSrc, co[0])) {
                out.push(site('C1', 'unpatched', '', cv[0], co[0]));
            } else {
                const b = co[0].body.body;
                const restO = b.slice(1).map((s) => c(oSrc, s)).join('');
                const restV = cv[0].body.body.map((s) => c(vSrc, s)).join('');
                const ok = Boolean(b[0]) && b[0].type === 'IfStatement' &&
                    c(oSrc, b[0].test) === GATE &&
                    c(oSrc, b[0].consequent) === cs('{return!1}') &&
                    restO === restV &&
                    oSrc.slice(co[0].body.start, b[0].start)
                        .includes('/*cowork-bwrap-dl*/');
                out.push(site('C1', ok ? 'ok' : 'wrong', ok ? ''
                    : c(oSrc, co[0]).slice(0, 240), cv[0], co[0]));
            }
        }
        return out;
    },
};

// The two snippets the terminal DA1 patch injects, as it spells them.
const DA_REPLY = String.raw`"\x1b[?1;2c"`;
function daAnswer(pty, data) {
    const owed = '__cddDa1Owed';
    const tail = '__cddDa1Tail';
    return '{let cddQ=(' + pty + '.' + tail + '??"")+' + data + ',' +
        String.raw`cddN=cddQ.match(/\x1b\[0?c/g)?.length??0;` +
        pty + '.' + tail + '=' +
        String.raw`/\x1b(?:\[0?)?$/.exec(cddQ)?.[0]??"";` +
        'for(let cddI=0;cddI<cddN;cddI++)' +
        pty + '.' + owed + '=(' + pty + '.' + owed + '??0)+1,' +
        pty + '.write(' + DA_REPLY + ')}';
}
function daDrop(key, input) {
    return 'if(' + input + '===' + DA_REPLY + '){' +
        'let cddP=this.shellPtyProcesses.get(' + key + ');' +
        'if(cddP?.__cddDa1Owed>0){cddP.__cddDa1Owed--;return}}';
}

// PTY.onData(W("pty:shell-data",(D=>{...}))) and writeShellPty(K,I,O){...}
// each gain one leading statement.
PATCHES.patch_terminal_da_reply = {
    script: 'terminal-da-reply.sh',
    sites: (src) => [
        ...spans(src, /\.onData\([\w$.]+\(\s*[`"']pty:shell-data/, 120, 200),
        // 2000 after: the patch checks that much of the method body for
        // this.shellPtyProcesses.get(<key>), so a rename of <key> must
        // reach that far or it reads as a patch failure.
        ...spans(src,
            /\bwriteShellPty\(\s*[\w$]+\s*,\s*[\w$]+\s*,\s*[\w$]+\s*\)\s*\{/,
            60, 2000),
    ],
    // Only the chunk with the data handler is the patch's file; other
    // chunks hold IPC forwarders also named writeShellPty.
    needs: /pty:shell-data/,
    oracle(vSrc, oSrc, vAst, oAst) {
        const out = [];
        // the handler W("pty:shell-data",(D=>{...})) wraps
        const handler = (n) => {
            const w = unchain(n.arguments[0]);
            return w.type === 'CallExpression' ? w.arguments[1] : undefined;
        };
        const isData = (n) => isCall(n, 'onData', 1) &&
            unchain(n.arguments[0]).type === 'CallExpression' &&
            strVal(unchain(n.arguments[0]).arguments[0]) === 'pty:shell-data' &&
            isFn(handler(n)) && handler(n).params.length === 1 &&
            handler(n).body.type === 'BlockStatement';
        const dv = findAll(vAst, isData);
        const dO = findAll(oAst, isData);
        if (dv.length !== 1 || dO.length !== 1) {
            out.push(site('onData', 'error',
                `handlers V=${dv.length} O=${dO.length}`));
        } else {
            const fv = handler(dv[0]);
            const fo = handler(dO[0]);
            const pty = c(oSrc, callee(dO[0]).object);
            const data = fo.params[0].name;
            const bv = fv.body.body.map((s) => c(vSrc, s)).join('');
            const bo = fo.body.body.map((s) => c(oSrc, s));
            if (bo.join('') === bv) {
                out.push(site('onData', 'unpatched', '', dv[0], dO[0]));
            } else {
                const ok = pty === c(vSrc, callee(dv[0]).object) &&
                    bo[0] === cs(daAnswer(pty, data)) &&
                    bo.slice(1).join('') === bv;
                out.push(site('onData', ok ? 'ok' : 'wrong', ok ? ''
                    : (bo[0] || '').slice(0, 200), dv[0], dO[0]));
            }
        }
        const isWrite = (n) => (n.type === 'MethodDefinition' ||
            n.type === 'Property') && !n.computed && n.key &&
            n.key.name === 'writeShellPty' && isFn(n.value) &&
            n.value.params.length === 3 &&
            n.value.params.every((p) => p.type === 'Identifier');
        const wv = findAll(vAst, isWrite);
        const wo = findAll(oAst, isWrite);
        if (wv.length !== 1 || wo.length !== 1) {
            out.push(site('writeShellPty', 'error',
                `definitions V=${wv.length} O=${wo.length}`));
        } else {
            const pv = wv[0].value.params.map((p) => p.name);
            const po = wo[0].value.params.map((p) => p.name);
            const bv = wv[0].value.body.body.map((s) => c(vSrc, s)).join('');
            const bo = wo[0].value.body.body.map((s) => c(oSrc, s));
            if (bo.join('') === bv) {
                out.push(site('writeShellPty', 'unpatched', '', wv[0], wo[0]));
            } else {
                const ok = JSON.stringify(pv) === JSON.stringify(po) &&
                    bo[0] === cs(daDrop(po[0], po[1])) &&
                    bo.slice(1).join('') === bv;
                out.push(site('writeShellPty', ok ? 'ok' : 'wrong', ok ? ''
                    : (bo[0] || '').slice(0, 200), wv[0], wo[0]));
            }
        }
        return out;
    },
};

// Two edits: every `||Q.hide()` on the quick window Q gets a KDE-gated
// blur(); and the first `F()||W.show()` after the QuickEntry submit log
// line gets a KDE-gated visibility check.
PATCHES.patch_quick_window = {
    script: 'quick-window.sh',
    sites: (src) => {
        const out = spans(src,
            new RegExp(String.raw`QUICK_ENTRY\)[^;]{0,200}?[\w$]+` +
                String.raw`\.setAlwaysOnTop\(\s*!0\s*,\s*${Q}pop-up-menu${Q}\)`),
            40, 40);
        const m = src.match(
            /([\w$]+)\.setAlwaysOnTop\(\s*!0\s*,\s*[`"']pop-up-menu/);
        if (m) {
            const q = m[1].replace(/\$/g, '\\$');
            out.push(...spans(src, new RegExp(`\\|\\|\\s*${q}\\.hide\\(\\)`),
                80, 20));
        }
        out.push(...spans(src,
            /\[QuickEntry\] Creating new chat with submit_quick_entry/,
            40, 400));
        return out;
    },
    needs: /submit_quick_entry/,
    oracle(vSrc, oSrc, vAst, oAst) {
        const out = [];
        const aot = findAll(vAst, (n) => isCall(n, 'setAlwaysOnTop', 2) &&
            strVal(n.arguments[1]) === 'pop-up-menu' &&
            callee(n).object.type === 'Identifier');
        if (aot.length < 1) {
            return [site('hide', 'error',
                'no setAlwaysOnTop(!0,"pop-up-menu") in V')];
        }
        const q = callee(aot[0]).object.name;
        const bareHide = (n) => n.type === 'LogicalExpression' &&
            n.operator === '||' && isCall(unchain(n.right), 'hide', 0) &&
            callee(n.right).object.type === 'Identifier' &&
            callee(n.right).object.name === q;
        const gatedHide = (src, n) => n.type === 'LogicalExpression' &&
            n.operator === '||' && n.right.type === 'ConditionalExpression' &&
            c(src, n.right.test) === KDE &&
            c(src, n.right.consequent) === cs(`${q}.blur(),${q}.hide()`) &&
            c(src, n.right.alternate) === cs(`${q}.hide()`);
        const hv = findAll(vAst, bareHide);
        const hoBare = findAll(oAst, bareHide);
        const hoGated = findAll(oAst, (n) => gatedHide(oSrc, n));
        if (hv.length === 0) {
            out.push(site('hide', 'error', `no ||${q}.hide() in V`));
        } else if (hoBare.length === hv.length && hoGated.length === 0) {
            hv.forEach((n, i) => out.push(site('hide', 'unpatched', '', n,
                hoBare[i])));
        } else if (hoBare.length === 0 && hoGated.length === hv.length) {
            hv.forEach((n, i) => {
                const same = c(vSrc, n.left) === c(oSrc, hoGated[i].left);
                out.push(site('hide', same ? 'ok' : 'wrong',
                    same ? '' : 'left operand changed', n, hoGated[i]));
            });
        } else {
            out.push(site('hide', 'wrong', `V has ${hv.length} ||${q}.hide();` +
                ` O has ${hoBare.length} bare, ${hoGated.length} gated`));
        }
        const pickShow = (ast, from) => findAll(ast, (n) =>
            n.type === 'LogicalExpression' && n.operator === '||' &&
            isCall(unchain(n.right), 'show', 0) && n.start > from &&
            n.start < from + 1500)[0];
        // The first log string in CODE (not in a comment or a decoy
        // copy): the patch searches from its first indexOf() hit.
        const anchor = 'Creating new chat with submit_quick_entry';
        const hits = (ast) => findAll(ast, (x) =>
            (strVal(x) || '').includes(anchor)).map((x) => x.start);
        const at = (ast) => {
            const h = hits(ast);
            return h.length ? h[0] : -1;
        };
        const sv = pickShow(vAst, at(vAst));
        const so = pickShow(oAst, at(oAst));
        // Later copies of the log line mark further submit paths the
        // patch (first indexOf() only) never reaches: report them.
        const later = hits(oAst).slice(1).map((h) => pickShow(oAst, h))
            .filter((n) => n && unchain(n.left).type === 'CallExpression');
        const laterNote = later.length ? `${later.length} later submit ` +
            `path(s) after another copy of the log line left as ` +
            later.map((n) => c(oSrc, n)).join(', ') : '';
        if (!sv || !so || unchain(sv.left).type !== 'CallExpression') {
            out.push(site('show', 'error',
                'no F()||W.show() after the submit log line'));
        } else if (c(vSrc, sv) === c(oSrc, so)) {
            out.push(site('show', 'unpatched', '', sv, so));
        } else {
            const w = c(vSrc, callee(sv.right).object);
            const ok = so.left.type === 'ConditionalExpression' &&
                c(oSrc, so.left.test) === KDE &&
                c(oSrc, so.left.consequent) ===
                    cs(`!${w}||${w}.isDestroyed()?!1:${w}.isVisible()`) &&
                c(oSrc, so.left.alternate) === c(vSrc, sv.left) &&
                c(oSrc, so.right) === c(vSrc, sv.right);
            out.push(site('show', ok ? 'ok' : 'wrong', ok ? laterNote
                : c(oSrc, so).slice(0, 200), sv, so));
        }
        return out;
    },
};

module.exports = { PATCHES };
