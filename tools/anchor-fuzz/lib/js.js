'use strict';
// Parser plumbing for the anchor fuzzer. No npm dependencies: Node ships
// acorn and acorn-walk internally (reachable with --expose-internals);
// a plain `acorn` install is the fallback for runtimes that hide them.

function loadAcorn() {
    const tries = [
        ['internal/deps/acorn/acorn/dist/acorn',
            'internal/deps/acorn/acorn-walk/dist/walk'],
        ['acorn', 'acorn-walk'],
    ];
    for (const [a, w] of tries) {
        try {
            return { acorn: require(a), walk: require(w) };
        } catch (e) {
            // try the next location
        }
    }
    throw new Error('acorn not found: run node with --expose-internals ' +
        'or install acorn and acorn-walk');
}

const { acorn, walk } = loadAcorn();

const PARSE_OPTS = {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
};

function parse(src) {
    return acorn.parse(src, PARSE_OPTS);
}

// null when src parses, else the error message with its position.
function parseError(src) {
    try {
        parse(src);
        return null;
    } catch (e) {
        return e.message;
    }
}

// Tokens of src, restricted to those starting in [from, to). Offsets are
// absolute. `text` is the raw source slice of the token.
function tokenize(src, from = 0, to = src.length) {
    const out = [];
    for (const t of acorn.tokenizer(src, PARSE_OPTS)) {
        if (t.start >= to) break;
        if (t.start < from) continue;
        out.push({
            type: t.type.label,
            kw: t.type.keyword || null,
            start: t.start,
            end: t.end,
            text: src.slice(t.start, t.end),
            value: t.value,
        });
    }
    return out;
}

const WORDY = /^[\w$]/;
const CALLISH = new Set(['name', 'this', ')', ']', 'string', 'num', '`',
    'super', 'template', 'regexp']);

// toks[i..i+7] spell `(0,x.y)(` and toks[i] is a grouping paren.
function isIndirect(toks, i) {
    const w = toks.slice(i, i + 8);
    const p = toks[i - 1];
    return w.length === 8 && w[1].type === 'num' && w[1].text === '0' &&
        w[2].type === ',' && w[3].type === 'name' &&
        (w[4].type === '.' || w[4].type === '?.') &&
        w[5].type === 'name' && w[6].type === ')' && w[7].type === '(' &&
        !(p && CALLISH.has(p.type));
}

// A spelling-independent form of src[from, to): whitespace and comments
// dropped, every string re-spelled as JSON, substitution-free templates
// as strings, true/false as !0/!1, ?. as . and (0,x.y)( as x.y(. Two
// snippets with equal canon mean the
// same thing token for token.
function canon(src, from = 0, to = src.length) {
    const parts = [];
    const toks = tokenize(src.slice(from, to));
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        let s = t.text;
        if (t.type === 'string') {
            s = JSON.stringify(t.value);
        } else if (t.type === '`' && toks[i + 1] &&
            toks[i + 1].type === 'template' && toks[i + 2] &&
            toks[i + 2].type === '`') {
            s = JSON.stringify(toks[i + 1].value);
            i += 2;
        } else if (t.type === 'true') {
            s = '!0';
        } else if (t.type === 'false') {
            s = '!1';
        } else if (t.type === 'template') {
            s = JSON.stringify(t.value);
        } else if (t.type === '?.') {
            s = '.';
        } else if (t.type === '(' && isIndirect(toks, i)) {
            // (0,x.y)( is x.y( without a this binding: same callee
            s = toks[i + 3].text + '.' + toks[i + 5].text;
            i += 6;
        }
        const prev = parts[parts.length - 1];
        if (prev !== undefined && WORDY.test(s) && /[\w$]$/.test(prev)) {
            parts.push(' ');
        }
        parts.push(s);
    }
    return parts.join('');
}

// The string a Literal or substitution-free TemplateLiteral spells, else
// undefined.
function strVal(n) {
    if (!n) return undefined;
    if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
    if (n.type === 'TemplateLiteral' && n.expressions.length === 0) {
        return n.quasis[0].value.cooked;
    }
    return undefined;
}

// Every node under ast satisfying pred, in source order.
function findAll(ast, pred) {
    const out = [];
    walk.full(ast, (n) => {
        if (pred(n)) out.push(n);
    });
    return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

module.exports = { acorn, walk, parse, parseError, tokenize, canon, strVal,
    findAll };
