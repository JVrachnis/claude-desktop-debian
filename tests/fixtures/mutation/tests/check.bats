#!/usr/bin/env bats
# Covering tests for the mutation-test fixture (see ../check.sh).

setup() {
	# shellcheck source=tests/fixtures/mutation/check.sh
	source "$BATS_TEST_DIRNAME/../check.sh"
}

@test "is_big: 20 is big" {
	is_big 20
}

@test "is_big: 5 is not big" {
	! is_big 5
}

@test "greeting: prints something" {
	run greeting
	[[ $status -eq 0 ]]
}
