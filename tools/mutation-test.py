#!/usr/bin/env python3
"""Mutation testing for the shell scripts and their BATS suites.

Automates the review "mutation check" (docs/learnings/
test-methodology-and-coverage.md): break the code under test on purpose
and see whether a test goes red. A mutant that survives is a change no
test notices -- either a real coverage gap or an equivalent mutant.

For each target in the config (tools/mutation-targets.conf), the tool:
  1. copies the repo's tracked files into one scratch copy per worker,
     so the working tree is never modified;
  2. checks that the covering .bats files pass unmutated (baseline);
  3. generates mutants with small, high-signal operators (see OPERATORS);
     a shell mutant that `bash -n` rejects is recorded as invalid and not
     run, so syntax breakage cannot inflate the score;
  4. runs the covering .bats files against each mutant with a timeout
     and records killed / survived / timeout.

Outputs (under --out): report.json, summary.md (for $GITHUB_STEP_SUMMARY)
and survivors.txt. Exit status is 0 when the run completed, whatever the
score; 2 on usage errors or a failing baseline.

Standard library only. BATS comes from $BATS, else `bats` on PATH, else
`npx --yes bats`.
"""

import argparse
import concurrent.futures
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

# --------------------------------------------------------------------------
# Operators. Each yields (operator, mutated_line) for one line. "sh" runs
# on shell lines, "js" on lines inside heredocs (the embedded Node in
# scripts/patches/*.sh).

RELOP_SWAP = {"-eq": "-ne", "-ne": "-eq", "-lt": "-ge", "-ge": "-lt",
              "-gt": "-le", "-le": "-gt"}
STRUCTURAL = re.compile(
    r"^(if|then|else|elif|fi|for|while|until|do|done|case|esac|;;|\{|\}|"
    r"local\b|declare\b|readonly\b|export\b|function\b|return\b|exit\b|"
    r"[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{|.*\)\s*$|.*\bin\s*$)")
# The line itself opens a block or continues onto the next one.
CONTINUES = re.compile(r"(\\|\||&&|\|\||\(|\{|\bdo|\bthen|\bin|;)\s*$")
# The previous line continues onto this one (a block opener does not).
CONTINUED = re.compile(r"(\\|\||&&|\|\|)\s*$")
HEREDOC = re.compile(r"<<(-?)\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2")
FUNC_START = re.compile(r"^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{")


def _each(line, old, new, op):
    """One mutant per occurrence of `old` in `line`."""
    start = 0
    while True:
        i = line.find(old, start)
        if i < 0:
            return
        yield op, line[:i] + new + line[i + len(old):]
        start = i + len(old)


def _code_part(line):
    """The part of a shell line before an unquoted comment (rough)."""
    stripped = line.lstrip()
    if stripped.startswith("#"):
        return ""
    return line


def stripped_starts_quote(line):
    return line.lstrip()[:1] in ("'", '"')


def sh_mutants(line, prev):
    code = _code_part(line)
    if not code.strip():
        return
    for old, new in RELOP_SWAP.items():
        yield from _each(code, f" {old} ", f" {new} ", f"relop {old}->{new}")
    yield from _each(code, " == ", " != ", "streq ==->!=")
    yield from _each(code, " != ", " == ", "streq !=->==")
    yield from _each(code, " && ", " || ", "logic &&->||")
    # `cmd || true` -> `cmd && true` only changes the exit status, which
    # these scripts never check (no set -e): an equivalent mutant.
    for op, new in _each(code, " || ", " && ", "logic ||->&&"):
        if not re.search(r" && (true|:)\s*(\)|;|$)", new):
            yield op, new
    for word in ("exit", "return"):
        for a, b in (("0", "1"), ("1", "0")):
            pat = re.compile(rf"\b{word} {a}\b")
            for m in pat.finditer(code):
                yield (f"{word} {a}->{b}",
                       code[:m.start()] + f"{word} {b}" + code[m.end():])
    for kw in ("if", "elif", "while"):
        # Only at the start of a statement, never inside quoted text.
        m = re.search(rf"(?:^\s*|;\s*|\bthen\s+|\belse\s+){kw} (! )?", code)
        if m:
            if m.group(1):
                yield (f"negate {kw}", code[:m.start()] + f"{kw} " +
                       code[m.end():])
            else:
                yield (f"negate {kw}", code[:m.end()] + "! " +
                       code[m.end():])
    for m in re.finditer(r"\[\[ (! )?-([fdexsrwzn]) ", code):
        flag = m.group(2)
        if flag in "zn":
            other = "n" if flag == "z" else "z"
            yield (f"test -{flag}->-{other}",
                   code[:m.start()] + f"[[ -{other} " + code[m.end():])
        elif m.group(1):
            yield (f"test drop ! -{flag}",
                   code[:m.start()] + f"[[ -{flag} " + code[m.end():])
        else:
            yield (f"test add ! -{flag}",
                   code[:m.start()] + f"[[ ! -{flag} " + code[m.end():])
    for a, b in (("=true", "=false"), ("=false", "=true")):
        yield from _each(code, a, b, f"bool {a[1:]}->{b[1:]}")
    for m in re.finditer(r"\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]+)\}", code):
        yield (f"default drop ${{{m.group(1)}:-...}}",
               code[:m.start()] + f"${{{m.group(1)}:-}}" + code[m.end():])
    # Empty the first single-quoted literal. Lines that start with a quote
    # are fragments of a multi-line message, mostly noise; skip them.
    # A heredoc delimiter ('EOF') is not a literal to empty.
    if not stripped_starts_quote(code) and not HEREDOC.search(code):
        for m in re.finditer(r"'([^'\n]+)'", code):
            yield ("string empty",
                   code[:m.start()] + "''" + code[m.end():])
            break
    # Delete one plain command line (replace with `:`), only where that
    # keeps the structure: indented, not a keyword/brace/declaration,
    # not a continuation in either direction.
    stripped = code.strip()
    if (code[:1].isspace() and not STRUCTURAL.match(stripped)
            and not CONTINUES.search(stripped)
            and not CONTINUED.search(prev.strip())):
        indent = code[:len(code) - len(code.lstrip())]
        yield "delete line", indent + ":"


def js_mutants(line, _prev):
    stripped = line.strip()
    if not stripped or stripped.startswith("//"):
        return
    yield from _each(line, "===", "!==", "js ===->!==")
    yield from _each(line, "!==", "===", "js !==->===")
    yield from _each(line, " && ", " || ", "js &&->||")
    yield from _each(line, " || ", " && ", "js ||->&&")
    yield from _each(line, "process.exit(0)", "process.exit(1)",
                     "js exit 0->1")
    yield from _each(line, "process.exit(1)", "process.exit(0)",
                     "js exit 1->0")
    yield from _each(line, "!== 1", "!== 2", "js count 1->2")
    yield from _each(line, "return true", "return false", "js true->false")
    yield from _each(line, "return false", "return true", "js false->true")


OPERATORS = {"sh": sh_mutants, "js": js_mutants}

# --------------------------------------------------------------------------


def line_contexts(lines):
    """Per line: 'sh', 'js' (heredoc body) or None (heredoc delimiter)."""
    ctx = []
    i = 0
    while i < len(lines):
        line = lines[i]
        ctx.append("sh")
        m = HEREDOC.search(line) if not line.lstrip().startswith("#") else None
        if m:
            dash, delim = m.group(1), m.group(3)
            i += 1
            while i < len(lines):
                body = lines[i].rstrip("\n")
                if (body.lstrip("\t") if dash else body) == delim:
                    ctx.append(None)
                    break
                ctx.append("js")
                i += 1
        i += 1
    return ctx


def function_ranges(lines, names):
    """Line index ranges [start, end] of the named top-level functions."""
    ctx = line_contexts(lines)
    ranges = []
    i = 0
    while i < len(lines):
        m = FUNC_START.match(lines[i]) if ctx[i] == "sh" else None
        if m and m.group(1) in names:
            j = i + 1
            while j < len(lines) and not (ctx[j] == "sh"
                                          and lines[j].startswith("}")):
                j += 1
            ranges.append((i, j))
            i = j
        i += 1
    return ranges


def generate(text, functions=None):
    lines = text.splitlines(keepends=True)
    ctx = line_contexts(lines)
    allowed = None
    if functions:
        allowed = set()
        for a, b in function_ranges(lines, set(functions)):
            allowed.update(range(a + 1, b))  # body only
    mutants = []
    seen = set()
    for i, line in enumerate(lines):
        if allowed is not None and i not in allowed:
            continue
        kind = ctx[i]
        if kind is None:
            continue
        body = line.rstrip("\n")
        prev = lines[i - 1].rstrip("\n") if i else ""
        for op, new in OPERATORS[kind](body, prev):
            key = (i, new)
            if new == body or key in seen:
                continue
            seen.add(key)
            mutants.append({"line": i + 1, "op": op, "kind": kind,
                            "original": body.strip(), "mutated": new.strip(),
                            "_new": new})
    return lines, mutants


# --------------------------------------------------------------------------


def read_config(path):
    targets = []
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.split("#", 1)[0].strip() if not raw.lstrip().startswith(
                "#") else ""
            if not line:
                continue
            # maxsplit 4: the last column is a regex and may contain |.
            parts = [p.strip() for p in line.split("|", 4)]
            parts += [""] * (5 - len(parts))
            name, target, tests, funcs, flt = parts[:5]
            targets.append({
                "name": name, "target": target, "tests": tests.split(),
                "functions": [f for f in funcs.split(",") if f.strip()],
                "filter": flt})
    return targets


def bats_command():
    if os.environ.get("BATS"):
        return [os.environ["BATS"]]
    if shutil.which("bats"):
        return ["bats"]
    return ["npx", "--yes", "bats"]


def copy_tree(root, dest):
    if os.path.isdir(os.path.join(root, ".git")) or os.path.isfile(
            os.path.join(root, ".git")):
        files = subprocess.run(
            ["git", "-C", root, "ls-files", "-z"], check=True,
            capture_output=True).stdout.decode().split("\0")
        for rel in filter(None, files):
            src = os.path.join(root, rel)
            if not os.path.isfile(src):
                continue
            dst = os.path.join(dest, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
    else:
        shutil.copytree(root, dest, dirs_exist_ok=True, symlinks=True)


def run_tests(copy, tests, flt, timeout, tmp, count=False):
    """Run the covering tests. Returns killed|survived|timeout, or with
    count=True a (status, number_of_tests_run) pair for the baseline."""
    cmd = bats_command() + (["-f", flt] if flt else []) + tests
    env = dict(os.environ, TMPDIR=tmp, BATS_TMPDIR=tmp)
    proc = subprocess.Popen(cmd, cwd=copy, env=env,
                            stdout=subprocess.PIPE if count
                            else subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        out, _ = proc.communicate(timeout=timeout)
        status = "killed" if proc.returncode else "survived"
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
        return ("timeout", 0) if count else "timeout"
    if not count:
        return status
    plan = re.search(rb"^1\.\.(\d+)$", out or b"", re.M)
    return status, int(plan.group(1)) if plan else 0


def bash_ok(path):
    return subprocess.run(["bash", "-n", path], capture_output=True).returncode == 0


def run_target(root, t, jobs, timeout, workdir, log):
    target_path = os.path.join(root, t["target"])
    with open(target_path, encoding="utf-8") as fh:
        original = fh.read()
    lines, mutants = generate(original, t["functions"])
    result = {"name": t["name"], "target": t["target"], "tests": t["tests"],
              "functions": t["functions"], "filter": t["filter"],
              "mutants": []}

    copies = []
    for n in range(jobs):
        d = os.path.join(workdir, f"{t['name']}-w{n}")
        os.makedirs(os.path.join(d, ".tmp"))
        copy_tree(root, d)
        copies.append(d)

    start = time.time()
    base, ntests = run_tests(copies[0], t["tests"], t["filter"], timeout * 3,
                             os.path.join(copies[0], ".tmp"), count=True)
    result["baseline_seconds"] = round(time.time() - start, 1)
    result["tests_run"] = ntests
    if base != "survived":
        result["error"] = f"baseline {base}: covering tests fail unmutated"
        return result
    # A filter that matches nothing "passes" with zero tests, and every
    # mutant would then survive. Treat it as a configuration error.
    if ntests == 0:
        result["error"] = "baseline ran 0 tests (check the bats filter)"
        return result
    # A mutant that makes the code loop forever is detected, but should
    # not cost the full --timeout: allow 10x the baseline, at least 10s.
    timeout = min(timeout, max(10, int(result["baseline_seconds"] * 10)))
    result["mutant_timeout"] = timeout

    pool = list(copies)
    lock = threading.Lock()

    def one(m):
        with lock:
            copy = pool.pop()
        try:
            dst = os.path.join(copy, t["target"])
            mutated = lines[:]
            mutated[m["line"] - 1] = m["_new"] + (
                "\n" if lines[m["line"] - 1].endswith("\n") else "")
            with open(dst, "w", encoding="utf-8") as fh:
                fh.write("".join(mutated))
            if m["kind"] == "sh" and not bash_ok(dst):
                status = "invalid"
            else:
                status = run_tests(copy, t["tests"], t["filter"], timeout,
                                   os.path.join(copy, ".tmp"))
            with open(dst, "w", encoding="utf-8") as fh:
                fh.write(original)
            return dict({k: v for k, v in m.items() if k != "_new"},
                        status=status)
        finally:
            with lock:
                pool.append(copy)

    start = time.time()
    with concurrent.futures.ThreadPoolExecutor(jobs) as ex:
        for done, r in enumerate(ex.map(one, mutants), 1):
            result["mutants"].append(r)
            if done % 25 == 0:
                log(f"  {t['name']}: {done}/{len(mutants)}")
    result["seconds"] = round(time.time() - start, 1)
    return result


def score(r):
    counts = {s: 0 for s in ("killed", "survived", "timeout", "invalid")}
    for m in r["mutants"]:
        counts[m["status"]] += 1
    effective = counts["killed"] + counts["survived"] + counts["timeout"]
    detected = counts["killed"] + counts["timeout"]
    pct = round(100 * detected / effective, 1) if effective else None
    return counts, pct


def write_reports(results, out):
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "report.json"), "w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=2)
    md = ["## Mutation testing (informational)", "",
          "A survived mutant is a change to the code that no test noticed.",
          "", "| Target | Mutants | Killed | Survived | Timeout | Invalid "
          "| Score | Time |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
    surv = []
    for r in results:
        if "error" in r:
            md.append(f"| `{r['name']}` | | | | | | {r['error']} | |")
            continue
        c, pct = score(r)
        md.append(f"| `{r['name']}` | {len(r['mutants'])} | {c['killed']} | "
                  f"{c['survived']} | {c['timeout']} | {c['invalid']} | "
                  f"{pct if pct is not None else '-'}% | {r['seconds']}s |")
        for m in r["mutants"]:
            if m["status"] == "survived":
                surv.append(f"{r['target']}:{m['line']}: [{m['op']}] "
                            f"{m['original']}  =>  {m['mutated']}")
    if surv:
        md += ["", f"<details><summary>{len(surv)} surviving mutants</summary>",
               "", "```"] + surv + ["```", "</details>"]
    with open(os.path.join(out, "summary.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(md) + "\n")
    with open(os.path.join(out, "survivors.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(surv) + ("\n" if surv else ""))
    return md


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", default=os.path.dirname(here),
                    help="repo root (default: this repo)")
    ap.add_argument("--config", default=os.path.join(here,
                                                     "mutation-targets.conf"))
    ap.add_argument("--only", default="", help="comma-separated target names")
    ap.add_argument("--changed", nargs="*",
                    help="only targets whose script or tests are in these paths")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 2)
    ap.add_argument("--timeout", type=int, default=120,
                    help="seconds per mutant run")
    ap.add_argument("--out", default="mutation-report")
    ap.add_argument("--list", action="store_true",
                    help="print the mutants without running anything")
    args = ap.parse_args(argv)

    root = os.path.abspath(args.root)
    targets = read_config(args.config)
    if args.only:
        wanted = set(args.only.split(","))
        targets = [t for t in targets if t["name"] in wanted]
    if args.changed is not None:
        changed = set(args.changed)
        targets = [t for t in targets
                   if t["target"] in changed or changed & set(t["tests"])]
    if not targets:
        print("no targets selected", file=sys.stderr)
        if not args.list:
            write_reports([], args.out)
        return 0

    if args.list:
        for t in targets:
            with open(os.path.join(root, t["target"]), encoding="utf-8") as fh:
                _, mutants = generate(fh.read(), t["functions"])
            for m in mutants:
                print(f"{t['name']}\t{t['target']}:{m['line']}\t{m['op']}\t"
                      f"{m['mutated']}")
        return 0

    def log(msg):
        print(msg, file=sys.stderr, flush=True)

    results = []
    workdir = tempfile.mkdtemp(prefix="mutation-")
    try:
        for t in targets:
            log(f"{t['name']}: {t['target']} vs {' '.join(t['tests'])}")
            r = run_target(root, t, max(1, args.jobs), args.timeout, workdir,
                           log)
            results.append(r)
            if "error" in r:
                log(f"  {r['error']}")
            else:
                c, pct = score(r)
                log(f"  {len(r['mutants'])} mutants: {c} score={pct}% "
                    f"({r['seconds']}s)")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    for line in write_reports(results, args.out):
        print(line)
    return 2 if any("error" in r for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
