'use strict';
// Semantics-preserving rewrites of the code around a patch anchor.
//
// Each variant is a function (env, ctx) -> edits, where env describes
// one site window of one pristine file:
//   env.src     the whole pristine file
//   env.toks    tokens whose start falls in the window (see js.tokenize)
//   env.ast     the pristine file's AST (lazy getter, parsed once)
//   env.from/to the window bounds
// and ctx is shared by every window of every file in one variant run, so
// a rename is consistent across sites. An edit is {start, end, text} in
// pristine offsets; the runner applies them back to front.
//
// The rewrites are the spellings a minifier, a beautifier or a bundler
// upgrade can legitimately produce for the same program. They need not
// keep the WHOLE program runnable (a rename inside the window does not
// follow its binding outside it) — what matters is that the code a patch
// reads still says the same thing, so a correct patch can still apply.
// A variant whose output does not parse is discarded by the runner.

const SKIP_NAMES = new Set(['process', 'require', 'module', 'exports',
    'globalThis', 'window', 'undefined', 'NaN', 'Infinity', 'arguments',
    'async', 'await', 'of', 'get', 'set', 'let', 'static', 'as', 'from',
    'yield', 'target', 'meta', 'console', 'Promise', 'Symbol', 'Object']);

const isName = (t) => Boolean(t) && t.type === 'name';
const isDot = (t) => Boolean(t) && (t.type === '.' || t.type === '?.');
const WORD = /[\w$]/;

// Gaps that are template text, where whitespace would change a string.
function gapForbidden(toks, i) {
    const t = toks[i];
    const p = toks[i - 1];
    if (!p) return true;
    if (t.type === 'template' || t.type === '${') return true;
    if (t.type === '`' && p.type === 'template') return true;
    if (p.type === '`' && t.type === 'template') return true;
    return false;
}

// Is toks[i] (a name) in object-key position: `{a:` or `,a:` ?
function isKey(toks, i) {
    const p = toks[i - 1];
    const n = toks[i + 1];
    return Boolean(p) && Boolean(n) && n.type === ':' &&
        (p.type === '{' || p.type === ',');
}

// An identifier reference worth renaming: short (minified), not a
// property name, not an object key, not a well-known global.
function renameable(toks, i) {
    const t = toks[i];
    return isName(t) && t.text.length <= 3 && !SKIP_NAMES.has(t.text) &&
        !isDot(toks[i - 1]) && !isKey(toks, i);
}

function renamer(prefixes) {
    return (env, ctx) => {
        const edits = [];
        env.toks.forEach((t, i) => {
            if (!renameable(env.toks, i)) return;
            if (!ctx.renames.has(t.text)) {
                ctx.renames.set(t.text, ctx.fresh(prefixes));
            }
            edits.push({ start: t.start, end: t.end,
                text: ctx.renames.get(t.text) });
        });
        return edits;
    };
}

const QUOTES = { double: '"', single: "'", backtick: '`' };

// Re-spell plain strings (and substitution-free templates) with one
// quote kind. Bodies holding any quote, a line continuation or a newline
// are left alone, as are object keys and `${` bodies for backticks.
function requote(kind) {
    const q = QUOTES[kind];
    return (env) => {
        const edits = [];
        const toks = env.toks;
        for (let i = 0; i < toks.length; i++) {
            const t = toks[i];
            const first = i;
            let body;
            let start;
            let end;
            if (t.type === 'string') {
                body = t.text.slice(1, -1);
                start = t.start;
                end = t.end;
            } else if (t.type === '`' && toks[i + 1] &&
                toks[i + 1].type === 'template' && toks[i + 2] &&
                toks[i + 2].type === '`') {
                body = toks[i + 1].text;
                start = t.start;
                end = toks[i + 2].end;
                // A tagged template is a call, not a string.
                const p = toks[i - 1];
                if (p && (isName(p) || p.type === ')' || p.type === ']')) {
                    i += 2;
                    continue;
                }
                i += 2;
            } else {
                continue;
            }
            if (/["'`\n\r\u2028\u2029]/.test(body)) continue;
            if (/\\(?:\r?\n|[0-7])/.test(body)) continue;
            if (env.src[start] === q) continue;
            const p = toks[first - 1];
            const n = toks[i + 1];
            const key = Boolean(n) && n.type === ':' && Boolean(p) &&
                (p.type === '{' || p.type === ',');
            if (q === '`' && (body.includes('${') || key)) {
                continue;
            }
            edits.push({ start, end, text: q + body + q });
        }
        return edits;
    };
}

function spaced(env) {
    const edits = [];
    env.toks.forEach((t, i) => {
        if (gapForbidden(env.toks, i)) return;
        if (t.start !== env.toks[i - 1].end) return;
        edits.push({ start: t.start, end: t.start, text: ' ' });
    });
    return edits;
}

// Spaces everywhere, plus a newline and indent after ; { and , — the
// shape a reference beautifier prints. Never a newline after a token
// where ASI could bite (return, throw, break, continue, ++, --, =>).
function beautified(env) {
    const edits = [];
    let depth = 0;
    env.toks.forEach((t, i) => {
        if (i === 0) return;
        const p = env.toks[i - 1];
        if (p.type === '{' || p.type === '${') depth++;
        if (t.type === '}') depth = Math.max(0, depth - 1);
        if (gapForbidden(env.toks, i)) return;
        const gap = env.src.slice(p.end, t.start);
        if (/\S/.test(gap)) return; // keep comments as they are
        const nl = p.type === ';' || p.type === '{' || p.type === ',';
        edits.push({ start: p.end, end: t.start,
            text: nl ? '\n' + '  '.repeat(Math.min(depth, 8)) : ' ' });
    });
    return edits;
}

const CALLISH_PREV = new Set(['name', 'this', ')', ']', 'string', 'num',
    '`', 'super', '}', 'template', 'regexp']);

// x.y(  ->  (0,x.y)(   for short (import-binding-like) receivers.
function callIndirect(env) {
    const edits = [];
    const toks = env.toks;
    for (let i = 0; i + 3 < toks.length; i++) {
        const [a, d, b, o] = toks.slice(i, i + 4);
        if (!isName(a) || a.text.length > 3 || SKIP_NAMES.has(a.text)) continue;
        if (d.type !== '.' || !isName(b) || o.type !== '(') continue;
        const p = toks[i - 1];
        if (isDot(p) || (p && (p.type === 'new' || p.type === '`'))) continue;
        edits.push({ start: a.start, end: a.start, text: '(0,' });
        edits.push({ start: b.end, end: b.end, text: ')' });
        i += 3;
    }
    return edits;
}

// (0,x.y)(  ->  x.y(
function callDirect(env) {
    const edits = [];
    const toks = env.toks;
    for (let i = 0; i + 7 < toks.length; i++) {
        const w = toks.slice(i, i + 8);
        if (w[0].type !== '(' || w[1].type !== 'num' || w[1].text !== '0' ||
            w[2].type !== ',' || !isName(w[3]) || w[4].type !== '.' ||
            !isName(w[5]) || w[6].type !== ')' || w[7].type !== '(') continue;
        const p = toks[i - 1];
        if (p && CALLISH_PREV.has(p.type)) continue;
        const sp = WORD.test(env.src[w[0].start - 1] || '') ? ' ' : '';
        edits.push({ start: w[0].start, end: w[3].start, text: sp });
        edits.push({ start: w[6].start, end: w[6].end, text: '' });
        i += 7;
    }
    return edits;
}

const ASSIGN = /^(?:=|[-+*/%&|^]=|\*\*=|<<=|>>>?=|&&=|\|\|=|\?\?=|\+\+|--)$/;

// a.b  ->  a?.b   everywhere it stays an rvalue member access.
function optionalChain(env) {
    const edits = [];
    const toks = env.toks;
    toks.forEach((t, i) => {
        if (t.type !== '.' || !isName(toks[i + 1])) return;
        const p = toks[i - 1];
        if (!p || !(isName(p) || p.type === ')' || p.type === ']')) return;
        let j = i + 2;
        // skip the rest of a plain dotted chain to find what follows it
        while (toks[j] && toks[j].type === '.' && isName(toks[j + 1])) j += 2;
        const n = toks[j];
        if (n && (ASSIGN.test(n.text) || n.type === '`')) return;
        // walk back to the start of the chain; `new a.b()` must stay
        let k = i - 1;
        while (k > 0 && isDot(toks[k - 1]) && isName(toks[k - 2])) k -= 2;
        const before = toks[k - 1];
        if (before && (before.type === 'new' || before.type === 'super' ||
            before.text === '++' || before.text === '--' ||
            before.type === 'delete')) return;
        if (isName(p) && p.text === 'super') return;
        edits.push({ start: t.start, end: t.start, text: '?' });
    });
    return edits;
}

// !0 -> true, !1 -> false
function boolWords(env) {
    const edits = [];
    const toks = env.toks;
    toks.forEach((t, i) => {
        const n = toks[i + 1];
        if (t.text !== '!' || !n || n.type !== 'num') return;
        if (n.text !== '0' && n.text !== '1') return;
        if (n.start !== t.end) return;
        let text = n.text === '0' ? 'true' : 'false';
        if (WORD.test(env.src[t.start - 1] || '')) text = ' ' + text;
        if (WORD.test(env.src[n.end] || '')) text += ' ';
        edits.push({ start: t.start, end: n.end, text });
    });
    return edits;
}

// Reverse the members of object literals whose members are all plain
// `key: value` pairs (no spread, method, shorthand, getter or computed
// key), wholly inside the window.
function keyOrder(env) {
    const edits = [];
    const { findAll } = require('./js');
    const objs = findAll(env.ast, (n) => n.type === 'ObjectExpression' &&
        n.start >= env.from && n.end <= env.to && n.properties.length >= 2 &&
        n.properties.every((p) => p.type === 'Property' && p.kind === 'init' &&
            !p.method && !p.shorthand && !p.computed));
    for (const o of objs) {
        // nested objects move with their parent; skip inner ones that a
        // reversed outer would already have relocated
        if (edits.some((e) => e.start <= o.start && o.end <= e.end)) continue;
        const ps = o.properties;
        const keys = ps.map((p) => p.key.name ?? String(p.key.value));
        if (new Set(keys).size !== keys.length) continue;
        const texts = ps.map((p) => env.src.slice(p.start, p.end));
        texts.reverse();
        const first = ps[0].start;
        const last = ps[ps.length - 1].end;
        const seps = [];
        for (let k = 0; k + 1 < ps.length; k++) {
            seps.push(env.src.slice(ps[k].end, ps[k + 1].start));
        }
        let text = '';
        texts.forEach((s, k) => {
            text += s + (k < seps.length ? seps[k] : '');
        });
        edits.push({ start: first, end: last, text });
    }
    return edits;
}

// a.b.c  ->  zP0.c : a value read once into a local, the shape a bundle
// takes when a module namespace or a parameter replaces an inline path
// (the #987 tray shape: `n.shouldUseDarkColors` vs the inline path).
function chainCollapse(env, ctx) {
    const edits = [];
    const toks = env.toks;
    for (let i = 0; i + 4 < toks.length; i++) {
        const [a, d1, b, d2, c] = toks.slice(i, i + 5);
        if (!isName(a) || SKIP_NAMES.has(a.text)) continue;
        if (isDot(toks[i - 1])) continue;
        if (d1.type !== '.' || !isName(b) || d2.type !== '.' || !isName(c)) {
            continue;
        }
        if (isKey(toks, i)) continue;
        const n = toks[i + 5];
        if (n && (ASSIGN.test(n.text) || n.type === '`')) continue;
        const p = toks[i - 1];
        if (p && p.type === 'new') continue;
        const base = a.text + '.' + b.text;
        if (!ctx.chains.has(base)) ctx.chains.set(base, ctx.fresh(['zP']));
        edits.push({ start: a.start, end: b.end, text: ctx.chains.get(base) });
        i += 2;
    }
    return edits;
}

// e=>  ->  (e)=>
function arrowParens(env) {
    const { findAll } = require('./js');
    return findAll(env.ast, (n) => n.type === 'ArrowFunctionExpression' &&
        n.start >= env.from && n.end <= env.to && n.params.length === 1 &&
        n.params[0].type === 'Identifier' && n.start === n.params[0].start &&
        !n.async)
        .map((n) => [{ start: n.params[0].start, end: n.params[0].start,
            text: '(' }, { start: n.params[0].end, end: n.params[0].end,
            text: ')' }])
        .flat();
}

const VARIANTS = {
    'identity': () => [],
    'rename': renamer(['zQ', 'zR', 'zS']),
    'rename-dollar': renamer(['$z', 'z$', '$$z']),
    'quote-double': requote('double'),
    'quote-single': requote('single'),
    'quote-backtick': requote('backtick'),
    'spaced': spaced,
    'beautified': beautified,
    'call-indirect': callIndirect,
    'call-direct': callDirect,
    'optional-chain': optionalChain,
    'bool-words': boolWords,
    'key-order': keyOrder,
    'chain-collapse': chainCollapse,
    'arrow-parens': arrowParens,
};

// Whole-file variants: they add text away from the sites.
//   decoy-comment  a copy of every window, inside a comment at the top
//                  of the file — a first-match or indexOf() patch edits
//                  the comment instead of the code.
const FILE_VARIANTS = {
    'decoy-comment': (src, windows) => [{ start: 0, end: 0,
        text: windows.map(([s, e]) => '/* ' +
            src.slice(s, e).replace(/\*\//g, '* /') + ' */').join('\n') +
            '\n' }],
};

module.exports = { VARIANTS, FILE_VARIANTS, gapForbidden, SKIP_NAMES };
