# shellcheck shell=bash
# Fixture for tests/mutation-test.bats. is_big() is pinned by the fixture
# tests below, so its relop mutant must be killed; greeting()'s text is
# never asserted, so emptying it must survive.

is_big() {
	[[ $1 -gt 10 ]]
}

greeting() {
	echo 'hello'
}
