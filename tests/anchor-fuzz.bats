#!/usr/bin/env bats
#
# tools/anchor-fuzz: the patch-anchor fuzzer.
#
# What these tests guard is the fuzzer's verdict, not any patch: a
# fuzzer whose oracle calls a wrong edit "ok" is worse than none, because
# its green matrix reads as evidence the anchors are robust. So most
# tests below run deliberately broken stand-in patches and assert the
# classification they must earn (MISAPPLY, PARTIAL, CORRUPT, FAIL,
# NOOP), and the variant tests pin that each rewrite keeps the meaning
# of the code it rewrites (canon-equal) while really changing its bytes.
#
# The fixture tree in tests/fixtures/anchor-fuzz/bundle holds small
# anchor regions in the 6.28899.6 shape (names and literals as shipped,
# context reduced to what the patches read) — never the bundle itself.

# JS snippets hold ` and ${...} that must reach node unexpanded.
# shellcheck disable=SC2016

setup() {
	fuzz_dir="$BATS_TEST_DIRNAME/../tools/anchor-fuzz"
	fixture="$BATS_TEST_DIRNAME/fixtures/anchor-fuzz/bundle"
	repo_root="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"

	if ! node --expose-internals -e \
		"require('$fuzz_dir/lib/js.js')" 2>/dev/null; then
		skip 'no acorn: node lacks internal acorn and none is installed'
	fi

	# A repo whose scripts/patches is the real one plus an override file
	# sourced last, so a test can swap in a broken patch function.
	fake_repo="$BATS_TEST_TMPDIR/repo"
	mkdir -p "$fake_repo/scripts/patches"
	local f
	for f in "$repo_root"/scripts/patches/*.sh; do
		ln -s "$f" "$fake_repo/scripts/patches/${f##*/}"
	done
}

# Run the fuzzer. $1 = repo, rest = extra args.
_fuzz() {
	local repo="$1"
	shift
	run node --expose-internals "$fuzz_dir/anchor-fuzz.js" \
		--build "$fixture" --repo "$repo" \
		--json "$BATS_TEST_TMPDIR/out.json" "$@"
}

# Result for one patch/variant pair from the last --json.
_result() {
	node -e '
		const r = require(process.argv[1]).find((x) =>
			x.patch === process.argv[2] && x.variant === process.argv[3]);
		console.log(r ? r.result : "none");
	' "$BATS_TEST_TMPDIR/out.json" "$1" "${2:-identity}"
}

# Define a replacement patch function, sourced after the real ones.
_override() {
	printf '%s\n' "$1" > "$fake_repo/scripts/patches/zz-override.sh"
}

# Rewrite JS with one variant: $1 = variant, $2 = code. Prints the result.
_variant() {
	node --expose-internals -e '
		const { tokenize, parse } = require(process.argv[1] + "/lib/js");
		const { VARIANTS } = require(process.argv[1] + "/lib/variants");
		const { applyEdits } = require(process.argv[1] + "/anchor-fuzz");
		const src = process.argv[3];
		const toks = tokenize(src);
		const env = { src, toks, from: 0, to: src.length, ast: parse(src) };
		const ctx = { renames: new Map(), chains: new Map(), n: 0,
			fresh(p) { return p[0] + (this.n++); } };
		process.stdout.write(applyEdits(src,
			VARIANTS[process.argv[2]](env, ctx)).out);
	' "$fuzz_dir" "$1" "$2"
}

# canon(a) === canon(b)
_same() {
	node --expose-internals -e '
		const { canon } = require(process.argv[1] + "/lib/js");
		process.exit(canon(process.argv[2]) === canon(process.argv[3]) ? 0 : 1);
	' "$fuzz_dir" "$1" "$2"
}

# =============================================================================
# Variants: each rewrite changes bytes but not meaning
# =============================================================================

@test "variant: rename is consistent and spares properties and keys" {
	run _variant rename 'a.b(a,{c:1},process.env)'
	[[ $status -eq 0 ]]
	[[ $output == 'zQ0.b(zQ0,{c:1},process.env)' ]]
}

@test "variant: quote-backtick skips object keys and bodies holding a quote" {
	run _variant quote-backtick 'f("a",{"k":1},"it'\''s")'
	[[ $output == 'f(`a`,{"k":1},"it'\''s")' ]]
}

@test "variant: call-indirect and call-direct are inverses" {
	run _variant call-indirect 'x=n.join(a,b)'
	[[ $output == 'x=(0,n.join)(a,b)' ]]
	run _variant call-direct "$output"
	[[ $output == 'x=n.join(a,b)' ]]
}

@test "variant: call-direct leaves a call's argument list alone" {
	# f(0,n.join)(x) is f called with two arguments, not an indirect call
	run _variant call-direct 'f(0,n.join)(x)'
	[[ $output == 'f(0,n.join)(x)' ]]
}

@test "variant: optional-chain spares assignment targets and new" {
	run _variant optional-chain 'a.b=c.d;new e.f();g.h++;i.j()'
	[[ $output == 'a.b=c?.d;new e.f();g.h++;i?.j()' ]]
}

@test "variant: bool-words keeps keywords apart" {
	run _variant bool-words 'return!0,x=!1'
	[[ $output == 'return true,x=false' ]]
}

@test "variant: key-order reverses plain members only" {
	run _variant key-order 'x={a:1,b:2};y={a,b:2};z={...q,c:3}'
	[[ $output == 'x={b:2,a:1};y={a,b:2};z={...q,c:3}' ]]
}

@test "variant: spaced and beautified never touch template text" {
	run _variant spaced 'f(`a ${b} c`)'
	[[ $output == 'f ( `a ${ b } c` )' ]]
	run _variant beautified 'f(`x,${y};z`);g()'
	[[ $output == *'`x,${ y };z`'* ]]
}

@test "variant: every rewrite stays canon-equal to its source" {
	local src='function F(e,t){return(0,n.join)(e,"a"),t.b.c?.d(!0,{k:1})}'
	local v out
	for v in rename quote-single quote-backtick spaced beautified \
		call-indirect call-direct optional-chain bool-words arrow-parens; do
		out=$(_variant "$v" "$src")
		node --expose-internals -e \
			"require('$fuzz_dir/lib/js').parse(process.argv[1])" "$out"
		# renames change names, so compare those structurally elsewhere
		[[ $v == rename ]] && continue
		_same "$src" "$out" || {
			echo "variant $v changed meaning: $out"
			return 1
		}
	done
}

@test "canon: (0,x.y)( and x?.y( read as x.y(; true as !0; quotes as JSON" {
	_same '(0,n.join)(`a`,true)' 'n?.join("a",!0)'
	run _same 'f(0,n.join)(x)' 'f(n.join)(x)'
	[[ $status -ne 0 ]]
}

# =============================================================================
# The real patches on the fixture
# =============================================================================

@test "identity: every real patch applies cleanly to the fixture" {
	_fuzz "$repo_root" --variant identity
	echo "$output"
	[[ $status -eq 0 ]]
	[[ $output == *'OK=7'* ]]
}

@test "identity not all OK exits 3, so a stale site map cannot pass" {
	_override 'patch_org_plugins_path() { return 1; }'
	_fuzz "$fake_repo" --variant identity --patch patch_org_plugins_path
	[[ $status -eq 3 ]]
}

# =============================================================================
# Classification: broken stand-ins must earn the verdict they deserve
# =============================================================================

@test "classify: a non-zero exit is FAIL (safe)" {
	_override 'patch_cowork_firmware_probe() { return 1; }'
	_fuzz "$fake_repo" --variant identity,spaced \
		--patch patch_cowork_firmware_probe
	[[ $(_result patch_cowork_firmware_probe spaced) == FAIL ]]
}

@test "classify: changing nothing is NOOP (safe)" {
	_override 'patch_cowork_firmware_probe() { :; }'
	_fuzz "$fake_repo" --variant spaced --patch patch_cowork_firmware_probe
	[[ $(_result patch_cowork_firmware_probe spaced) == NOOP ]]
}

@test "classify: the linux case after default is MISAPPLY" {
	# One edit from the real patch: the case lands where it never runs.
	_override 'patch_org_plugins_path() {
		sed -i -E "s/(default:return null)/\1;case\"linux\":return\"\/etc\/claude\/org-plugins\";/" \
			app.asar.contents/.vite/build/index.chunk-main.js
	}'
	_fuzz "$fake_repo" --variant identity --patch patch_org_plugins_path
	echo "$output"
	[[ $(_result patch_org_plugins_path identity) == MISAPPLY ]]
}

@test "classify: an edit outside the patch's own sites is MISAPPLY" {
	# The real patch, plus one stray byte elsewhere in the same file.
	cat > "$fake_repo/scripts/patches/zz-override.sh" <<-EOF
	patch_cowork_firmware_probe() {
		(source "$repo_root/scripts/patches/cowork-firmware-probe.sh" &&
			patch_cowork_firmware_probe) || return
		sed -i 's/"TrayIcon.ico"/"TrayIcon2.ico"/' \\
			app.asar.contents/.vite/build/index.chunk-main.js
	}
	EOF
	_fuzz "$fake_repo" --variant spaced --patch patch_cowork_firmware_probe
	echo "$output"
	[[ $(_result patch_cowork_firmware_probe spaced) == MISAPPLY ]]
	[[ $output == *'bytes outside the patch sites changed'* ]]
}

@test "classify: touching a file the patch does not own is MISAPPLY" {
	cat > "$fake_repo/scripts/patches/zz-override.sh" <<-EOF
	patch_terminal_da_reply() {
		(source "$repo_root/scripts/patches/terminal-da-reply.sh" &&
			patch_terminal_da_reply) || return
		echo '//x' >> app.asar.contents/.vite/build/mainView.js
	}
	EOF
	_fuzz "$fake_repo" --variant identity --patch patch_terminal_da_reply
	echo "$output"
	[[ $(_result patch_terminal_da_reply identity) == MISAPPLY ]]
	[[ $output == *'mainView.js changed'* ]]
}

@test "classify: one site edited and the other skipped is PARTIAL" {
	# quick-window's hide() half only: the tripwire sees changed bytes
	# and lets it through, so only the oracle can catch this.
	_override 'patch_quick_window() {
		sed -i -E "s/\|\|PJ\.hide\(\)/||((process.env.XDG_CURRENT_DESKTOP||\"\").toLowerCase().includes(\"kde\")?(PJ.blur(),PJ.hide()):PJ.hide())/" \
			app.asar.contents/.vite/build/index.chunk-main.js
	}'
	_fuzz "$fake_repo" --variant identity --patch patch_quick_window
	echo "$output"
	[[ $(_result patch_quick_window identity) == PARTIAL ]]
}

@test "classify: exit 0 with unparseable output is CORRUPT" {
	_override 'patch_cowork_firmware_probe() {
		sed -i "s/\"\/usr\/share\/OVMF\/OVMF_CODE.fd\"\]/&]/" \
			app.asar.contents/.vite/build/index.chunk-main.js
	}'
	_fuzz "$fake_repo" --variant identity --patch patch_cowork_firmware_probe
	echo "$output"
	[[ $(_result patch_cowork_firmware_probe identity) == CORRUPT ]]
}

@test "classify: an edit inside a decoy comment is caught, real site or not" {
	# indexOf() takes the first hit: with a copy of the anchor in a
	# comment above the code, a first-match patch edits the comment.
	_override 'patch_cowork_firmware_probe() {
		INDEX_JS=app.asar.contents/.vite/build/index.chunk-main.js node -e "
			const fs = require(\"fs\"), f = process.env.INDEX_JS;
			let c = fs.readFileSync(f, \"utf8\");
			const a = \"\\\"/usr/share/OVMF/OVMF_CODE.fd\\\"]\";
			const i = c.indexOf(a) + a.length - 1;
			fs.writeFileSync(f, c.slice(0, i) + \",\\\"/x\\\"\" + c.slice(i));
		"
	}'
	_fuzz "$fake_repo" --variant identity,decoy-comment \
		--patch patch_cowork_firmware_probe
	echo "$output"
	[[ $(_result patch_cowork_firmware_probe identity) == MISAPPLY ]]
	[[ $(_result patch_cowork_firmware_probe decoy-comment) == MISAPPLY ]]
	[[ $output == *'inside a comment'* ]]
}

@test "--strict exits 2 on a dangerous result, 0 without it" {
	_override 'patch_quick_window() {
		sed -i -E "s/\|\|PJ\.hide\(\)/||((process.env.XDG_CURRENT_DESKTOP||\"\").toLowerCase().includes(\"kde\")?(PJ.blur(),PJ.hide()):PJ.hide())/" \
			app.asar.contents/.vite/build/index.chunk-main.js
	}'
	_fuzz "$fake_repo" --variant bool-words --patch patch_quick_window
	[[ $status -eq 0 ]]
	_fuzz "$fake_repo" --variant bool-words --patch patch_quick_window --strict
	[[ $status -eq 2 ]]
}

@test "the fixture never changes: runs work on copies" {
	local before
	before=$(cat "$fixture"/*.js | sha256sum)
	_fuzz "$repo_root" --variant identity,rename
	[[ $(cat "$fixture"/*.js | sha256sum) == "$before" ]]
}

@test "anchor-fuzz.sh --help prints the header" {
	run "$BATS_TEST_DIRNAME/../tools/anchor-fuzz.sh" --help
	[[ $status -eq 0 ]]
	[[ $output == *'Patch-anchor fuzzer'* ]]
	[[ $output == *'MISAPPLY'* ]]
}
