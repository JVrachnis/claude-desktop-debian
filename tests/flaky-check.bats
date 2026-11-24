#!/usr/bin/env bats
#
# tools/flaky-check.sh: the JUnit reduction and the run-to-run diff that
# decide whether a test "flipped". Running the conditions themselves is
# exercised by the Flaky workflow, not here.

setup() {
	# shellcheck source=tools/flaky-check.sh
	source "$BATS_TEST_DIRNAME/../tools/flaky-check.sh"
	runs="$BATS_TEST_TMPDIR/runs"
	mkdir -p "$runs"
}

# Real bats 1.13 JUnit bytes: a pass (self-closing), a failure whose body
# spans lines and quotes the test source, and a skip.
junit_fixture() {
	cat << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<testsuites time="0.004">
<testsuite name="t.bats" tests="3" failures="1" errors="0" skipped="1" time="0.004" timestamp="2026-11-24T13:27:17" hostname="h">
    <testcase classname="t.bats" name="passes" time="0.002" />
    <testcase classname="t.bats" name="fails with &lt;angle&gt; &amp; &quot;quotes&quot;" time="0.002">
        <failure type="failure">(in test file t.bats, line 2)
  `@test &quot;fails with &lt;angle&gt; &amp; \&quot;quotes\&quot;&quot; { echo out; false; }&#39; failed
out</failure>
    </testcase>
    <testcase classname="t.bats" name="skipped" time="0">
        <skipped>because</skipped>
    </testcase>

</testsuite>
<testsuite name="u.bats" tests="1" failures="0" errors="0" skipped="0" time="0.001" timestamp="2026-11-24T13:27:17" hostname="h">
    <testcase classname="u.bats" name="passes" time="0.001" />
</testsuite>
</testsuites>
EOF
}

@test "parse_junit: pass, fail and skip, keyed by file and name" {
	run flaky_parse_junit < <(junit_fixture)
	[[ $status -eq 0 ]]
	diff -u - <(printf '%s\n' "$output") << 'EOF'
t.bats	passes	pass
t.bats	fails with &lt;angle&gt; &amp; &quot;quotes&quot;	fail
t.bats	skipped	skip
u.bats	passes	pass
EOF
}

@test "parse_junit: name is not read from inside classname" {
	# classname="…" contains `name="` as a substring; a naive match took
	# the file name as the test name, collapsing every test in a file
	# into one key.
	run flaky_parse_junit <<< '<testcase classname="f.bats" name="real name" time="0" />'
	[[ $output == $'f.bats\treal name\tpass' ]]
}

@test "parse_junit: an <error> counts as a failure" {
	run flaky_parse_junit << 'EOF'
<testcase classname="f.bats" name="t" time="0">
<error type="error">boom</error>
</testcase>
EOF
	[[ $output == $'f.bats\tt\tfail' ]]
}

@test "parse_junit: an absolute and a relative classname key the same file" {
	# The host passes absolute paths, a container relative ones; both must
	# key on the basename or every such test reads as missing elsewhere.
	local abs rel
	abs=$(printf '%s\n' \
		'<testcase classname="/home/u/repo/scripts/t/x.bats" name="n" time="0" />' \
		| flaky_parse_junit)
	rel=$(printf '%s\n' \
		'<testcase classname="x.bats" name="n" time="0" />' \
		| flaky_parse_junit)
	[[ $abs == "$rel" ]]
	[[ $abs == $'x.bats\tn\tpass' ]]
}

@test "parse_junit: an empty report gives no rows" {
	run flaky_parse_junit < /dev/null
	[[ $status -eq 0 ]]
	[[ -z $output ]]
}

@test "diff: identical runs report nothing" {
	printf 'f.bats\ta\tpass\nf.bats\tb\tskip\n' > "$runs/one.tsv"
	cp "$runs/one.tsv" "$runs/two.tsv"
	run flaky_diff "$runs/one.tsv" "$runs/two.tsv"
	[[ $status -eq 0 ]]
	[[ -z $output ]]
}

@test "diff: a status change is reported with every run's status" {
	printf 'f.bats\ta\tpass\nf.bats\tb\tpass\n' > "$runs/baseline.tsv"
	printf 'f.bats\ta\tpass\nf.bats\tb\tfail\n' > "$runs/locale-c.tsv"
	run flaky_diff "$runs/baseline.tsv" "$runs/locale-c.tsv"
	[[ $output == $'f.bats\tb\tbaseline=pass;locale-c=fail' ]]
}

@test "diff: a test absent from one run counts as missing there" {
	printf 'f.bats\ta\tpass\nf.bats\tb\tpass\n' > "$runs/baseline.tsv"
	printf 'f.bats\ta\tpass\n' > "$runs/reverse.tsv"
	run flaky_diff "$runs/baseline.tsv" "$runs/reverse.tsv"
	[[ $output == $'f.bats\tb\tbaseline=pass;reverse=missing' ]]
}

@test "diff: same test name in two files are separate tests" {
	printf 'a.bats\tsame\tpass\nb.bats\tsame\tpass\n' > "$runs/one.tsv"
	printf 'a.bats\tsame\tpass\nb.bats\tsame\tfail\n' > "$runs/two.tsv"
	run flaky_diff "$runs/one.tsv" "$runs/two.tsv"
	[[ $output == $'b.bats\tsame\tone=pass;two=fail' ]]
}

@test "diff: pass versus skip is a flip too" {
	# A test that skips in one environment and passes in another is not
	# a failure, but it is still environment-dependent coverage.
	printf 'f.bats\ta\tpass\n' > "$runs/host.tsv"
	printf 'f.bats\ta\tskip\n' > "$runs/ctr.tsv"
	run flaky_diff "$runs/host.tsv" "$runs/ctr.tsv"
	[[ $output == $'f.bats\ta\thost=pass;ctr=skip' ]]
}

@test "report: lists only the runs that disagree with the common outcome" {
	local totals="$BATS_TEST_TMPDIR/totals.tsv"
	printf 'r1\t1\t0\t0\n' > "$totals"
	run flaky_report "$totals" <<< $'f.bats\tt | pipe\tr1=pass;r2=pass;r3=fail'
	[[ $output == *'1 test(s) changed outcome'* ]]
	[[ $output == *'| f.bats | t \| pipe | pass elsewhere; **r3**: fail |'* ]]
	[[ $output != *'**r1**'* ]]
}

@test "report: says so when nothing flipped" {
	local totals="$BATS_TEST_TMPDIR/totals.tsv"
	printf 'r1\t1\t0\t0\n' > "$totals"
	run flaky_report "$totals" < /dev/null
	[[ $output == *'No test changed outcome between runs.'* ]]
}

@test "totals: counts per run" {
	printf 'f\ta\tpass\nf\tb\tfail\nf\tc\tskip\nf\td\tpass\n' > "$runs/x.tsv"
	run flaky_totals "$runs/x.tsv"
	[[ $output == $'x\t2\t1\t1' ]]
}

@test "name_regex: unescapes JUnit entities and escapes ERE metacharacters" {
	# shellcheck disable=SC2016  # a literal $1 in a test name, not an expansion
	run flaky_name_regex 'a &lt;b&gt; &amp; &quot;q&quot; (x) [y] a.b $1 it&#39;s'
	# shellcheck disable=SC2016  # the expected regex has a literal \$1
	[[ $output == '^a <b> & "q" \(x\) \[y\] a\.b \$1 it'"'"'s$' ]]
}

@test "name_regex: the regex selects exactly that test with bats --filter" {
	local f="$BATS_TEST_TMPDIR/names.bats"
	# printf, not a heredoc: bats 1.10 (the version CI installs) rewrites
	# any line starting with @test, heredoc bodies included, so these two
	# would become tests of this file.
	printf '%s\n' '@test "a (x) & b" { true; }' \
		'@test "a (x) & b plus more" { true; }' > "$f"
	local re
	re=$(flaky_name_regex 'a (x) &amp; b')
	run bats --formatter junit --filter "$re" "$f"
	[[ $(flaky_parse_junit <<< "$output" | cut -f2) == 'a (x) &amp; b' ]]
}

@test "shuffle: deterministic for a seed and a permutation of the input" {
	local a b
	a=$(printf '%s\n' 1 2 3 4 5 6 7 8 | _flaky_shuffle 7)
	b=$(printf '%s\n' 1 2 3 4 5 6 7 8 | _flaky_shuffle 7)
	[[ $a == "$b" ]]
	[[ $(sort -n <<< "$a" | tr '\n' ' ') == '1 2 3 4 5 6 7 8 ' ]]
}

@test "conditions: every listed condition is handled by _flaky_run" {
	local cond
	while read -r cond _; do
		[[ -z $cond ]] && continue
		grep -qE "^[[:space:]]+(${cond}|[a-z-]+\|${cond})\)" \
			"$BATS_TEST_DIRNAME/../tools/flaky-check.sh" \
			|| { echo "unhandled: $cond"; return 1; }
	done < <(flaky_conditions | grep -E '^[a-z]')
}
