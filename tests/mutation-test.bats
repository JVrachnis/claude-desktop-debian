#!/usr/bin/env bats
#
# tools/mutation-test.py against a tiny fixture (tests/fixtures/mutation):
# a mutant the fixture tests pin must be killed, one they don't must
# survive, the source tree must be left untouched, and a filter that
# matches no test must be an error rather than a 100%-survived report.

setup() {
	tool="$BATS_TEST_DIRNAME/../tools/mutation-test.py"
	fixture="$BATS_TEST_DIRNAME/fixtures/mutation"
	out="$BATS_TEST_TMPDIR/out"
	# The tool runs the fixture's own .bats files; reuse this bats.
	BATS=$(command -v bats || true)
	if [[ -z $BATS ]]; then
		BATS=$(dirname "$BATS_ROOT")/bin/bats
		[[ -x $BATS ]] || BATS="$BATS_ROOT/bin/bats"
	fi
	export BATS
}

_status_of() {
	# $1 = op, $2 = line → status of that mutant in report.json
	python3 - "$out/report.json" "$1" "$2" << 'EOF'
import json, sys
report, op, line = sys.argv[1], sys.argv[2], int(sys.argv[3])
for t in json.load(open(report)):
    for m in t["mutants"]:
        if m["op"] == op and m["line"] == line:
            print(m["status"])
EOF
}

@test "mutation-test: --list generates the expected operators" {
	run python3 "$tool" --root "$fixture" \
		--config "$fixture/targets.conf" --only fixture --list
	[[ $status -eq 0 ]]
	[[ $output == *$'check.sh:7\trelop -gt->-le\t[[ $1 -le 10 ]]'* ]]
	[[ $output == *$'check.sh:11\tstring empty\techo \'\''* ]]
	[[ $output == *$'check.sh:11\tdelete line\t:'* ]]
}

@test "mutation-test: pinned mutant killed, unpinned one survives" {
	cp "$fixture/check.sh" "$BATS_TEST_TMPDIR/before.sh"
	run python3 "$tool" --root "$fixture" \
		--config "$fixture/targets.conf" --only fixture --jobs 2 \
		--out "$out"
	[[ $status -eq 0 ]]
	[[ $(_status_of 'relop -gt->-le' 7) == killed ]]
	[[ $(_status_of 'string empty' 11) == survived ]]
	[[ $(_status_of 'delete line' 11) == survived ]]
	grep -q 'check.sh:11: \[string empty\]' "$out/survivors.txt"
	grep -q '| `fixture` |' "$out/summary.md"
	# The tool works on copies: the fixture itself is unchanged.
	cmp "$fixture/check.sh" "$BATS_TEST_TMPDIR/before.sh"
}

@test "mutation-test: a filter that runs no tests is an error" {
	run python3 "$tool" --root "$fixture" \
		--config "$fixture/targets.conf" --only filtered --out "$out"
	[[ $status -eq 2 ]]
	[[ $output == *'baseline ran 0 tests'* ]]
}

@test "mutation-test: --changed selects targets by script or test path" {
	run python3 "$tool" --root "$fixture" \
		--config "$fixture/targets.conf" --changed README.md --list
	[[ $status -eq 0 ]]
	[[ $output == 'no targets selected' ]]
	run python3 "$tool" --root "$fixture" \
		--config "$fixture/targets.conf" --only fixture \
		--changed tests/check.bats --list
	[[ $output == *'relop -gt->-le'* ]]
}

@test "mutation-test: heredoc bodies get JS operators; noise ops are filtered" {
	PYTHONDONTWRITEBYTECODE=1 python3 - "$tool" << 'EOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("mt", sys.argv[1])
mt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mt)
# Heredoc bodies get the JS operators, not the shell ones.
_, ms = mt.generate("node << 'EOF'\nif (a === b && c) process.exit(1);\nEOF\n")
ops = sorted(m["op"] for m in ms)
assert ops == ["js &&->||", "js ===->!==", "js exit 1->0"], ops
# `|| true` -> `&& true` is equivalent without set -e: not generated.
_, ms = mt.generate("f() {\n\tx=$(cmd) || true\n}\n")
assert not [m for m in ms if m["op"].startswith("logic")], ms
# `if` inside a quoted message is not a statement.
_, ms = mt.generate("f() {\n\techo 'only if needed'\n}\n")
assert not [m for m in ms if m["op"].startswith("negate")], ms
EOF
}
