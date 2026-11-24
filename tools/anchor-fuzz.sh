#!/usr/bin/env bash
#===============================================================================
# Patch-anchor fuzzer for the active asar patches.
#
# Report-only. Takes the real anchor regions out of the official bundle,
# re-spells them in semantics-preserving ways (renamed minified names,
# other quote styles, beautified whitespace, (0,x.y)() call forms,
# optional chaining, true for !0, reordered object keys, a namespace
# path collapsed into a local, ...), runs every patch in active_patches
# on each variant, and checks the output structurally. The question it
# answers: when upstream's minifier changes its spelling, does each patch
# still apply — or at least fail loudly — instead of shipping a bundle
# it edited in the wrong place?
#
# Usage:
#   tools/anchor-fuzz.sh                    # fetch the pinned amd64 .deb
#   tools/anchor-fuzz.sh --deb FILE         # fuzz a local official .deb
#   tools/anchor-fuzz.sh --tree DIR         # an extracted data.tar root
#   tools/anchor-fuzz.sh --build DIR        # an extracted .vite/build
#
# Any other option goes to tools/anchor-fuzz/anchor-fuzz.js:
#   --patch a,b       only these patch functions
#   --variant a,b     only these variants
#   --jobs N          variants in parallel (each needs ~1 GB of RAM)
#   --json FILE       full results
#   --markdown FILE   the matrix as a Markdown table (CI step summary)
#   --strict          exit 2 when any result is PARTIAL/MISAPPLY/CORRUPT
#   --keep            keep the per-run trees (under --tmp DIR)
#
# Results, per patch and variant:
#   ok        applied correctly
#   fail      the patch exited non-zero              (safe: the build stops)
#   noop      the patch changed nothing              (safe: tripwire stops)
#   PARTIAL   some sites edited, the rest silently skipped
#   MISAPPLY  a site edited into the wrong shape, or other bytes changed
#   CORRUPT   exit 0 but the output no longer parses
#   ?         the oracle could not read this variant (fuzzer limitation)
#   -         the variant does not touch this patch's sites
#
# Exits 3 when the identity variant is not all ok: either a patch
# mis-applies to the unmodified bundle, or the site map or an oracle in
# tools/anchor-fuzz/lib/patches.js is stale for this bundle.
#===============================================================================

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project_root=$(dirname "$script_dir")

# shellcheck source=scripts/_common.sh
source "$project_root/scripts/_common.sh"
# shellcheck source=scripts/setup/official-deb.sh
source "$project_root/scripts/setup/official-deb.sh"

architecture=$(dpkg --print-architecture 2>/dev/null || echo amd64)
tree_dir=''
build_dir=''
local_deb_path=''
work_dir=''
fuzz_args=()

usage() {
	local close
	close=$(grep -n '^#====' "${BASH_SOURCE[0]}" | sed -n '2s/:.*//p')
	sed -n "2,$((close - 1))p" "${BASH_SOURCE[0]}"
	exit "${1:-0}"
}

cleanup() {
	[[ -n $work_dir ]] && rm -rf "$work_dir"
}

parse_args() {
	while (( $# )); do
		case "$1" in
			--deb)	local_deb_path="$2"; shift 2 ;;
			--tree)	tree_dir="$2"; shift 2 ;;
			--build)	build_dir="$2"; shift 2 ;;
			-h|--help)	usage ;;
			--keep|--strict)	fuzz_args+=("$1"); shift ;;
			--*)
				if (( $# < 2 )); then
					echo "Missing value for $1" >&2
					usage 1
				fi
				fuzz_args+=("$1" "$2")
				shift 2
				;;
			*)	echo "Unknown argument: $1" >&2; usage 1 ;;
		esac
	done
}

# Sets build_dir to an extracted .vite/build, fetching and unpacking the
# official .deb unless one was given.
stage_build() {
	[[ -n $build_dir ]] && return 0

	work_dir=$(mktemp -d /tmp/anchor-fuzz.XXXXXX) || return 1
	trap cleanup EXIT

	if [[ -z $tree_dir ]]; then
		fetch_official_deb
		tree_dir="$claude_extract_dir"
	fi

	local asar_path="$tree_dir/usr/lib/claude-desktop/resources/app.asar"
	if [[ ! -f $asar_path ]]; then
		echo "app.asar not found at $asar_path" >&2
		return 1
	fi

	# @electron/asar@3 for the same reason as patch-necessity-audit.sh:
	# read-only use, and 3.x still runs on Debian 13's Node 20.
	_resolve_asar "$work_dir" 3 || return 1

	local contents_dir="$work_dir/app.asar.contents"
	echo 'Extracting official app.asar...' >&2
	"$asar_exec" extract "$asar_path" "$contents_dir" || {
		echo 'Failed to extract app.asar' >&2
		return 1
	}
	# The .deb's own extract is no longer needed: free its ~500 MB
	# before every variant copies the bundle.
	[[ -n ${claude_extract_dir:-} ]] && rm -rf "$claude_extract_dir"
	build_dir="$contents_dir/.vite/build"
}

main() {
	parse_args "$@"
	stage_build || exit 1
	if [[ ! -d $build_dir ]]; then
		echo "Not a directory: $build_dir" >&2
		exit 1
	fi
	# --expose-internals: the fuzzer parses with the acorn Node ships, so
	# it needs no npm install.
	node --expose-internals "$script_dir/anchor-fuzz/anchor-fuzz.js" \
		--build "$build_dir" --repo "$project_root" "${fuzz_args[@]}"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
	main "$@"
fi
