#!/usr/bin/env python3
"""Changed-lines coverage for a pull request (Coverage workflow).

Intersects the lines a PR adds or changes (a `git diff --unified=0`)
with the line coverage the Coverage workflow measured: kcov's Cobertura
XML for the shell under BATS, c8's LCOV for the bwrap daemon. Prints a
Markdown report for $GITHUB_STEP_SUMMARY.

Only lines the coverage tool reports as executable count. A changed line
that kcov/c8 does not list (a comment, a blank line, a `fi`, the body of
a heredoc) is neither covered nor uncovered, so it never moves the
figure. A changed file in scope that no report mentions at all is listed
separately as "not measured": the tools give no line data for it.

Informational only, like tools/coverage-summary.sh: any problem becomes
a line in the report and the exit status is always 0.

Usage:
  coverage-diff.py --diff pr.diff [--cobertura FILE]... [--lcov FILE]...
                   [--scope PREFIX]... [--exclude PREFIX]...
                   [--root DIR] [--json OUT] [--annotations OUT]

--annotations writes one `::notice` workflow command per run of
uncovered changed lines (at most 10, GitHub's per-step limit) to OUT;
the workflow cats it so the notices land on the PR's Files tab. Stdout
stays reserved for the Markdown report.
"""

import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")
# GitHub shows at most 10 notice annotations per step; keep under it.
MAX_ANNOTATIONS = 10
SNIPPET_WIDTH = 72


def parse_diff(text):
    """Return {path: set(new line numbers)} for added/changed lines."""
    changed = {}
    path = None
    for line in text.splitlines():
        if line.startswith("+++ "):
            target = line[4:].split("\t", 1)[0]
            if target == "/dev/null":
                path = None
            else:
                path = target[2:] if target.startswith("b/") else target
                changed.setdefault(path, set())
            continue
        if path is None:
            continue
        match = HUNK_RE.match(line)
        if match:
            start = int(match.group(1))
            count = int(match.group(2)) if match.group(2) is not None else 1
            changed[path].update(range(start, start + count))
    return {p: lines for p, lines in changed.items() if lines}


def _rel(path, roots):
    path = path.replace("\\", "/")
    for root in roots:
        if root and path.startswith(root):
            return path[len(root):].lstrip("/")
    return path[2:] if path.startswith("./") else path


def _merge(cov, path, number, hits):
    lines = cov.setdefault(path, {})
    lines[number] = max(lines.get(number, 0), hits)


def load_cobertura(file, cov, roots, notes):
    try:
        tree = ET.parse(file)
    except (OSError, ET.ParseError) as err:
        notes.append(f"Cobertura report `{file}` unreadable: {err}")
        return
    sources = [s.text.rstrip("/") + "/" for s in tree.iter("source") if s.text]
    for cls in tree.iter("class"):
        name = cls.get("filename")
        if not name:
            continue
        path = _rel(name, sources + roots)
        for line in cls.iter("line"):
            try:
                _merge(cov, path, int(line.get("number")),
                       int(line.get("hits", "0")))
            except (TypeError, ValueError):
                continue


def load_lcov(file, cov, roots, notes):
    try:
        with open(file, encoding="utf-8") as fh:
            text = fh.read()
    except OSError as err:
        notes.append(f"LCOV report `{file}` unreadable: {err}")
        return
    path = None
    for line in text.splitlines():
        if line.startswith("SF:"):
            path = _rel(line[3:], roots)
            cov.setdefault(path, {})
        elif line.startswith("DA:") and path is not None:
            parts = line[3:].split(",")
            try:
                _merge(cov, path, int(parts[0]), int(parts[1]))
            except (IndexError, ValueError):
                continue
        elif line == "end_of_record":
            path = None


def in_scope(path, scope, exclude):
    if any(path == e or path.startswith(e) for e in exclude):
        return False
    return not scope or any(path == s or path.startswith(s) for s in scope)


def runs(numbers):
    """Collapse sorted ints into (start, end) runs."""
    out = []
    for n in sorted(numbers):
        if out and n == out[-1][1] + 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return [tuple(r) for r in out]


def fmt_runs(numbers):
    return ", ".join(f"{a}" if a == b else f"{a}–{b}" for a, b in runs(numbers))


def snippet(root, path, number):
    try:
        with open(os.path.join(root, path), encoding="utf-8",
                  errors="replace") as fh:
            for i, text in enumerate(fh, 1):
                if i == number:
                    text = text.strip()
                    if len(text) > SNIPPET_WIDTH:
                        text = text[:SNIPPET_WIDTH - 1] + "…"
                    return text.replace("`", "'").replace("|", "\\|")
    except OSError:
        pass
    return ""


def analyse(changed, cov, scope, exclude):
    files = []
    unmeasured = []
    for path in sorted(changed):
        if not in_scope(path, scope, exclude):
            continue
        lines = cov.get(path)
        if lines is None:
            unmeasured.append(path)
            continue
        executable = sorted(n for n in changed[path] if n in lines)
        covered = [n for n in executable if lines[n] > 0]
        uncovered = [n for n in executable if lines[n] == 0]
        files.append({"path": path, "changed": len(changed[path]),
                      "executable": len(executable),
                      "covered": covered, "uncovered": uncovered})
    return files, unmeasured


def render(files, unmeasured, notes, root):
    total = sum(f["executable"] for f in files)
    hit = sum(len(f["covered"]) for f in files)
    out = ["## Changed-lines coverage (informational, no threshold)", ""]
    if total:
        out.append(f"**{hit} of {total} changed executable lines covered "
                   f"({100 * hit / total:.1f}%).** Lines kcov/c8 do not "
                   "count as executable (comments, blank lines, heredoc "
                   "bodies) are left out.")
    elif not files and not unmeasured:
        out.append("No changed lines in measured scope.")
    else:
        out.append("No changed executable lines in the coverage reports.")
    out.append("")
    if files:
        out += ["| File | Changed | Executable | Covered | Uncovered lines |",
                "|---|---:|---:|---:|---|"]
        for f in files:
            unc = fmt_runs(f["uncovered"]) if f["uncovered"] else "–"
            out.append(f"| `{f['path']}` | {f['changed']} | "
                       f"{f['executable']} | {len(f['covered'])} | {unc} |")
        out.append("")
        missed = [f for f in files if f["uncovered"]]
        if missed:
            out += ["<details><summary>Uncovered changed lines</summary>", ""]
            for f in missed:
                out.append(f"`{f['path']}`")
                out.append("")
                for n in f["uncovered"]:
                    out.append(f"- {n}: `{snippet(root, f['path'], n)}`")
                out.append("")
            out += ["</details>", ""]
    if unmeasured:
        out.append("Changed but not in any coverage report (no line data): "
                   + ", ".join(f"`{p}`" for p in unmeasured))
        out.append("")
    for note in notes:
        out.append(f"> {note}")
    return "\n".join(out).rstrip() + "\n"


def annotations(files):
    lines = []
    for f in files:
        for a, b in runs(f["uncovered"]):
            if len(lines) == MAX_ANNOTATIONS:
                return lines
            end = f",endLine={b}" if b != a else ""
            lines.append(f"::notice file={f['path']},line={a}{end},"
                         "title=Changed line not covered::"
                         "No test in the BATS suite or protocol smoke "
                         "runs this changed line (Coverage workflow).")
    return lines


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--diff", required=True)
    ap.add_argument("--cobertura", action="append", default=[])
    ap.add_argument("--lcov", action="append", default=[])
    ap.add_argument("--scope", action="append", default=[])
    ap.add_argument("--exclude", action="append", default=[])
    ap.add_argument("--root", default=".")
    ap.add_argument("--json")
    ap.add_argument("--annotations",
                    help="write ::notice commands here (default: none)")
    args = ap.parse_args(argv)

    notes = []
    root = os.path.abspath(args.root)
    roots = [root.rstrip("/") + "/"]
    try:
        with open(args.diff, encoding="utf-8", errors="replace") as fh:
            changed = parse_diff(fh.read())
    except OSError as err:
        sys.stdout.write("## Changed-lines coverage\n\n"
                         f"> Diff `{args.diff}` unreadable: {err}\n")
        return 0

    cov = {}
    for file in args.cobertura:
        load_cobertura(file, cov, roots, notes)
    for file in args.lcov:
        load_lcov(file, cov, roots, notes)
    if not cov:
        notes.append("No coverage report was readable, so every changed "
                     "file shows as not measured.")

    files, unmeasured = analyse(changed, cov, args.scope, args.exclude)
    sys.stdout.write(render(files, unmeasured, notes, root))

    if args.json:
        total = sum(f["executable"] for f in files)
        hit = sum(len(f["covered"]) for f in files)
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({"executable": total, "covered": hit,
                       "files": files, "unmeasured": unmeasured}, fh,
                      indent=2)
    if args.annotations:
        with open(args.annotations, "w", encoding="utf-8") as fh:
            for line in annotations(files):
                fh.write(line + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as err:  # informational: never fail the step
        sys.stdout.write(f"\n> coverage-diff.py failed: {err}\n")
        sys.exit(0)
