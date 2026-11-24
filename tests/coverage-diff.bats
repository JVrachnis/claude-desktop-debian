#!/usr/bin/env bats
#
# tools/coverage-diff.py: changed-lines coverage for a PR, from a
# `git diff --unified=0` and the Coverage workflow's kcov Cobertura and
# c8 LCOV reports.
#
# The fixture repo is small enough to count by hand:
#   scripts/a.sh    changed 2-4; kcov lists 2 (hit), 3 (missed), not 4
#   scripts/b.sh    changed 1-3; kcov lists 1, 3 (both missed)
#   scripts/cowork-fallback/svc.js  changed 10-12; c8 lists 10 (missed),
#                                   11 (hit), not 12
#   scripts/new.sh  added, in scope, absent from every report
#   tests/x.bats    changed, out of scope
#   scripts/cowork-fallback/tests/smoke.js  changed, in scope but excluded
#   scripts/gone.sh deleted
# so 2 of 6 changed executable lines are covered.

setup() {
	tool="$BATS_TEST_DIRNAME/../tools/coverage-diff.py"
	repo="$BATS_TEST_TMPDIR/repo"
	mkdir -p "$repo/scripts/cowork-fallback" "$repo/tests"
	printf '%s\n' '#!/bin/bash' 'echo hit' 'echo `missed` | x' \
		'# comment' 'echo five' 'exit 0' > "$repo/scripts/a.sh"
	printf '%s\n' 'b1' 'b2' 'b3' > "$repo/scripts/b.sh"
	cat > "$BATS_TEST_TMPDIR/cobertura.xml" << EOF
<?xml version="1.0" ?>
<coverage line-rate="0.5" lines-covered="3" lines-valid="6">
	<sources><source>$repo/</source></sources>
	<packages><package name=""><classes>
		<class name="a_sh" filename="scripts/a.sh"><lines>
			<line number="2" hits="1"/>
			<line number="3" hits="0"/>
			<line number="5" hits="2"/>
		</lines></class>
		<class name="b_sh" filename="$repo/scripts/b.sh"><lines>
			<line number="1" hits="0"/>
			<line number="3" hits="0"/>
		</lines></class>
	</classes></package></packages>
</coverage>
EOF
	cat > "$BATS_TEST_TMPDIR/lcov.info" << 'EOF'
TN:
SF:scripts/cowork-fallback/svc.js
DA:10,0
DA:11,4
end_of_record
EOF
	cat > "$BATS_TEST_TMPDIR/pr.diff" << 'EOF'
diff --git a/scripts/a.sh b/scripts/a.sh
--- a/scripts/a.sh
+++ b/scripts/a.sh
@@ -2,0 +2,3 @@ echo hit
+echo hit
+echo `missed` | x
+# comment
@@ -9,2 +11,0 @@ deletion-only hunk adds no new lines
diff --git a/scripts/b.sh b/scripts/b.sh
--- a/scripts/b.sh
+++ b/scripts/b.sh
@@ -1 +1,3 @@
+b1
+b2
+b3
diff --git a/scripts/cowork-fallback/svc.js b/scripts/cowork-fallback/svc.js
--- a/scripts/cowork-fallback/svc.js
+++ b/scripts/cowork-fallback/svc.js
@@ -10,0 +10,3 @@
diff --git a/scripts/new.sh b/scripts/new.sh
new file mode 100755
--- /dev/null
+++ b/scripts/new.sh
@@ -0,0 +1,2 @@
diff --git a/tests/x.bats b/tests/x.bats
--- a/tests/x.bats
+++ b/tests/x.bats
@@ -1 +1 @@
diff --git a/scripts/cowork-fallback/tests/smoke.js b/scripts/cowork-fallback/tests/smoke.js
--- a/scripts/cowork-fallback/tests/smoke.js
+++ b/scripts/cowork-fallback/tests/smoke.js
@@ -4 +4,2 @@
diff --git a/scripts/gone.sh b/scripts/gone.sh
deleted file mode 100755
--- a/scripts/gone.sh
+++ /dev/null
@@ -1,4 +0,0 @@
EOF
}

_run_diff() {
	run python3 "$tool" --diff "$BATS_TEST_TMPDIR/pr.diff" \
		--cobertura "$BATS_TEST_TMPDIR/cobertura.xml" \
		--lcov "$BATS_TEST_TMPDIR/lcov.info" \
		--scope scripts/ --scope build.sh --scope tools/ \
		--exclude scripts/cowork-fallback/tests/ \
		--root "$repo" "$@"
}

@test "coverage-diff: totals count only executable changed lines" {
	_run_diff
	[[ $status -eq 0 ]]
	[[ $output == *'**2 of 6 changed executable lines covered (33.3%).**'* ]]
}

@test "coverage-diff: per-file row separates changed from executable" {
	# a.sh: 3 changed lines, 2 of them executable (4 is a comment kcov
	# does not list), 1 covered, line 3 uncovered.
	_run_diff
	[[ $output == *'| `scripts/a.sh` | 3 | 2 | 1 | 3 |'* ]]
	[[ $output == *'| `scripts/b.sh` | 3 | 2 | 0 | 1, 3 |'* ]]
	[[ $output == *'| `scripts/cowork-fallback/svc.js` | 3 | 2 | 1 | 10 |'* ]]
}

@test "coverage-diff: absolute Cobertura filenames resolve against the root" {
	# b.sh is listed under its absolute path; it must still match the
	# diff's repo-relative path.
	_run_diff
	[[ $output == *'`scripts/b.sh` | 3 | 2 |'* ]]
}

@test "coverage-diff: in-scope file with no coverage data is listed as not measured" {
	_run_diff
	[[ $output == *'not in any coverage report'*'`scripts/new.sh`'* ]]
}

@test "coverage-diff: out-of-scope, excluded and deleted files are ignored" {
	# smoke.js sits under the scripts/ scope but in an --exclude prefix;
	# without the exclude it would show up as "not measured".
	_run_diff
	[[ $output != *'tests/x.bats'* ]]
	[[ $output != *'smoke.js'* ]]
	[[ $output != *'gone.sh'* ]]
}

@test "coverage-diff: uncovered lines show an escaped source snippet" {
	_run_diff
	[[ $output == *'<summary>Uncovered changed lines</summary>'* ]]
	# Backticks and pipes from the source must not break the Markdown.
	[[ $output == *"- 3: \`echo 'missed' \\| x\`"* ]]
}

@test "coverage-diff: annotations mark each uncovered run, with endLine for ranges" {
	_run_diff --annotations "$BATS_TEST_TMPDIR/notices"
	[[ $status -eq 0 ]]
	grep -qx '::notice file=scripts/a.sh,line=3,title=Changed line not covered::.*' \
		"$BATS_TEST_TMPDIR/notices"
	grep -q '^::notice file=scripts/b.sh,line=1,' "$BATS_TEST_TMPDIR/notices"
	grep -q '^::notice file=scripts/b.sh,line=3,' "$BATS_TEST_TMPDIR/notices"
	[[ $(wc -l < "$BATS_TEST_TMPDIR/notices") -eq 4 ]]
	# Covered lines never get a notice. (Counted, not `! grep`: a
	# negated command is not a failing assertion in bats, SC2314.)
	[[ $(grep -c 'line=2,' "$BATS_TEST_TMPDIR/notices") -eq 0 ]]
}

@test "coverage-diff: consecutive uncovered lines become one ranged notice" {
	cat > "$BATS_TEST_TMPDIR/pr.diff" << 'EOF'
+++ b/scripts/b.sh
@@ -0,0 +1,3 @@
EOF
	sed -i 's|<line number="3" hits="0"/>|<line number="2" hits="0"/><line number="3" hits="0"/>|' \
		"$BATS_TEST_TMPDIR/cobertura.xml"
	_run_diff --annotations "$BATS_TEST_TMPDIR/notices"
	[[ $(cat "$BATS_TEST_TMPDIR/notices") == '::notice file=scripts/b.sh,line=1,endLine=3,'* ]]
	[[ $(wc -l < "$BATS_TEST_TMPDIR/notices") -eq 1 ]]
	[[ $output == *'| 1–3 |'* ]]
}

@test "coverage-diff: notices stop at GitHub's 10-per-step limit" {
	{
		echo '+++ b/scripts/b.sh'
		echo '@@ -0,0 +1,40 @@'
	} > "$BATS_TEST_TMPDIR/pr.diff"
	local lines='' n
	for ((n = 1; n <= 40; n += 2)); do
		lines+="<line number=\"$n\" hits=\"0\"/>"
	done
	sed -i "s|<line number=\"1\" hits=\"0\"/>|$lines|" \
		"$BATS_TEST_TMPDIR/cobertura.xml"
	_run_diff --annotations "$BATS_TEST_TMPDIR/notices"
	[[ $(wc -l < "$BATS_TEST_TMPDIR/notices") -eq 10 ]]
}

@test "coverage-diff: JSON output carries the same counts" {
	_run_diff --json "$BATS_TEST_TMPDIR/out.json"
	python3 - "$BATS_TEST_TMPDIR/out.json" << 'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
assert (d["covered"], d["executable"]) == (2, 6), d
assert d["unmeasured"] == ["scripts/new.sh"], d
EOF
}

@test "coverage-diff: no changed lines in scope says so" {
	printf '%s\n' '+++ b/docs/x.md' '@@ -1 +1 @@' > "$BATS_TEST_TMPDIR/pr.diff"
	_run_diff
	[[ $status -eq 0 ]]
	[[ $output == *'No changed lines in measured scope.'* ]]
}

@test "coverage-diff: unreadable reports and diff never fail the step" {
	run python3 "$tool" --diff "$BATS_TEST_TMPDIR/pr.diff" \
		--cobertura "$BATS_TEST_TMPDIR/missing.xml" \
		--lcov "$BATS_TEST_TMPDIR/missing.info" --scope scripts/ \
		--root "$repo"
	[[ $status -eq 0 ]]
	[[ $output == *'unreadable'* ]]
	[[ $output == *'not in any coverage report'* ]]

	run python3 "$tool" --diff "$BATS_TEST_TMPDIR/no.diff"
	[[ $status -eq 0 ]]
	[[ $output == *'unreadable'* ]]

	printf 'not xml' > "$BATS_TEST_TMPDIR/cobertura.xml"
	_run_diff
	[[ $status -eq 0 ]]
	[[ $output == *'Cobertura report'*'unreadable'* ]]
}

@test "ci: coverage diff runs on pull requests only and cannot fail the job" {
	local wf="$BATS_TEST_DIRNAME/../.github/workflows/coverage.yml"
	awk '/- name: Changed-lines coverage/{f=1} f&&/^      - name: /&&!/Changed-lines/{exit} f' \
		"$wf" > "$BATS_TEST_TMPDIR/step"
	grep -q "if: github.event_name == 'pull_request'" "$BATS_TEST_TMPDIR/step"
	grep -q 'continue-on-error: true' "$BATS_TEST_TMPDIR/step"
	grep -q 'tools/coverage-diff.py' "$BATS_TEST_TMPDIR/step"
	# HEAD^1 is the PR's base inside the merge commit, so the checkout
	# needs two commits of history.
	grep -q 'fetch-depth: 2' "$wf"
}
