#!/usr/bin/env bash
#===============================================================================
# flaky-check.sh: run the BATS suite under varied conditions and report every
# test whose outcome changes between them.
#
# A green suite only says the tests passed in one environment, in one order.
# This runs the same tests again with the order reversed or shuffled, in
# parallel, with a different TZ / locale / umask, with spaces in TMPDIR and
# HOME, with a stripped environment, with a desktop session's variables
# injected, and (with --container) inside other distros, as root or not, and
# with the real package installed on the "host". Each run's JUnit report is
# reduced to `file<TAB>test<TAB>pass|fail|skip`, and any test whose status is
# not the same in every run is listed with the runs that disagreed.
#
# A flip means the test depends on something it does not set up itself: run
# order, timing, the environment, or what is installed on the machine. That
# is the class of bug where a test passes on CI and fails on a contributor's
# laptop (or the other way round), or is green for the wrong reason.
#
# Usage: tools/flaky-check.sh [options] [bats files...]
#   --conditions LIST  comma-separated, see `--list` (default: $FLAKY_DEFAULT)
#   --runs N           repeat each condition N times (default 1)
#   --seed N           seed for `shuffle` (default 1)
#   --jobs N           parallelism for the `jobs` condition (default 4)
#   --container SPEC   also run in a container; SPEC is
#                      IMAGE[:root|:user][+pkg][#jobs] (repeatable; needs
#                      podman or docker). `+pkg` installs the package given
#                      by --package first, so tests see a "host" that has
#                      the real app installed; `#jobs` runs bats --jobs N
#                      with GNU parallel installed in the container.
#   --package PATH     a built .deb/.rpm for `+pkg` containers
#   --out DIR          keep results here (default: a temp dir)
#   --prefix NAME      prefix every run name (to merge runs from several
#                      machines: `--compare DIR...` on their TSVs)
#   --compare DIR...   only compare the *.tsv already in the given dirs
#   --strict           exit 1 when any test flipped
#   --list             list the conditions and exit
# Files default to the CI set: tests/*.bats scripts/cowork-fallback/tests/*.bats
#
# Sourced by: tests/flaky-check.bats (for the parse/diff helpers)
#===============================================================================

FLAKY_DEFAULT='baseline,reverse,shuffle,tz-east,tz-west,locale-c,umask-077,space-paths,clean-env,session-env'

# All conditions, with what each varies. `isolate` runs every test on its own
# (one bats process per test), which finds tests that only pass after an
# earlier test in the same file; it is slow, so it is not in the default set.
flaky_conditions() {
	cat << 'EOF'
baseline     the suite as CI runs it
reverse      file order reversed
shuffle      file order shuffled (--seed)
jobs         bats --jobs N across and within files (needs GNU parallel)
isolate      every test in its own bats process (slow)
tz-east      TZ=Pacific/Kiritimati (UTC+14)
tz-west      TZ=Etc/GMT+12 (UTC-12)
locale-c     LC_ALL=C
locale-tr    LC_ALL=tr_TR.UTF-8 (dotted/dotless i), if the locale exists
umask-077    umask 077
space-paths  TMPDIR and HOME under a directory with spaces in its name
clean-env    env -i: only PATH, HOME, TERM and LANG survive
session-env  a desktop session's variables injected (DISPLAY, WAYLAND_DISPLAY,
             XDG_*, CLAUDE_*, ...)
EOF
}

#--- JUnit -> TSV -------------------------------------------------------------

# Read a bats JUnit report on stdin; print `file<TAB>name<TAB>status` per
# test, status pass|fail|skip. Names keep their XML escaping: it is the same
# in every run, so it works as a key and needs no decoding to compare.
flaky_parse_junit() {
	awk '
		# The leading space keeps `name` from matching inside `classname`.
		function attr(line, key) {
			if (match(line, " " key "=\"[^\"]*\""))
				return substr(line, RSTART + length(key) + 3,
					RLENGTH - length(key) - 4)
			return ""
		}
		function emit() { printf "%s\t%s\t%s\n", file, name, status; open = 0 }
		/<testcase / {
			if (open) emit()
			file = attr($0, "classname"); name = attr($0, "name")
			# bats puts the file path in classname, absolute or relative
			# depending on how it was invoked (host vs container), so key
			# on the basename; the suite has no duplicate basenames.
			sub(/.*\//, "", file)
			status = "pass"; open = 1
			if ($0 ~ /\/>[[:space:]]*$/) emit()
			next
		}
		open && /<failure/ { status = "fail" }
		open && /<error/ { status = "fail" }
		open && /<skipped/ { status = "skip" }
		open && /<\/testcase>/ { emit() }
		END { if (open) emit() }
	'
}

#--- Comparing runs -----------------------------------------------------------

# $@ = TSV files, one per run; each file's name without .tsv is the run name.
# Prints one line per test whose status is not identical in every run:
#   file<TAB>name<TAB>run=status;run=status;...
# A test absent from a run counts as `missing` there (crash, abort, filter).
flaky_diff() {
	awk -F '\t' '
		FNR == 1 {
			run = FILENAME; sub(/^.*\//, "", run); sub(/\.tsv$/, "", run)
			runs[++nruns] = run
		}
		NF >= 3 {
			key = $1 "\t" $2
			if (!(key in seen)) { seen[key] = 1; order[++nkeys] = key }
			st[key, run] = $3
		}
		END {
			for (k = 1; k <= nkeys; k++) {
				key = order[k]; first = ""; differs = 0; out = ""
				for (r = 1; r <= nruns; r++) {
					s = ((key, runs[r]) in st) ? st[key, runs[r]] : "missing"
					if (r == 1) first = s
					else if (s != first) differs = 1
					out = out (r > 1 ? ";" : "") runs[r] "=" s
				}
				if (differs) print key "\t" out
			}
		}
	' "$@"
}

# $@ = TSV files. Per-run totals: run<TAB>pass<TAB>fail<TAB>skip
flaky_totals() {
	local f run
	for f in "$@"; do
		run=${f##*/}
		run=${run%.tsv}
		awk -F '\t' -v run="$run" '
			{ n[$3]++ }
			END { printf "%s\t%d\t%d\t%d\n", run, n["pass"], n["fail"], n["skip"] }
		' "$f"
	done
}

# Markdown report from the diff lines (stdin) and the per-run totals ($1).
flaky_report() {
	local totals=$1 diffs
	diffs=$(cat)
	echo '## Flaky / environment-dependent tests'
	echo
	if [[ -z $diffs ]]; then
		echo 'No test changed outcome between runs.'
	else
		echo "$(grep -c . <<< "$diffs") test(s) changed outcome between runs:"
		echo
		echo '| File | Test | Outcomes |'
		echo '|---|---|---|'
		# Show only the runs that disagree with the most common outcome,
		# so a 1-in-12 flip stays readable.
		awk -F '\t' '{
			n = split($3, parts, ";"); delete count; best = ""; bestn = 0
			for (i = 1; i <= n; i++) {
				split(parts[i], kv, "="); count[kv[2]]++
				if (count[kv[2]] > bestn) { bestn = count[kv[2]]; best = kv[2] }
			}
			odd = ""
			for (i = 1; i <= n; i++) {
				split(parts[i], kv, "=")
				if (kv[2] != best) odd = odd (odd ? ", " : "") "**" kv[1] "**: " kv[2]
			}
			gsub(/\|/, "\\|", $2)
			printf "| %s | %s | %s elsewhere; %s |\n", $1, $2, best, odd
		}' <<< "$diffs"
	fi
	echo
	echo '| Run | pass | fail | skip |'
	echo '|---|---|---|---|'
	awk -F '\t' '{ printf "| %s | %s | %s | %s |\n", $1, $2, $3, $4 }' "$totals"
}

#--- Running conditions -------------------------------------------------------

_flaky_bats() {
	if [[ -n ${BATS:-} ]]; then
		# shellcheck disable=SC2206  # BATS may carry arguments, e.g. "npx bats"
		_flaky_bats_cmd=($BATS)
	elif command -v bats > /dev/null; then
		_flaky_bats_cmd=(bats)
	else
		_flaky_bats_cmd=(npx --yes bats)
	fi
}

# Deterministic shuffle of stdin lines (no `shuf --random-source`
# portability questions).
_flaky_shuffle() {
	# A Park-Miller generator instead of srand()/rand(): mawk, Ubuntu's
	# default awk and so CI's, reseeds from the clock regardless of
	# srand(seed), which made the order different on every run. Products
	# stay below 2^53, so every awk computes the same sequence.
	awk -v seed="$1" '
		BEGIN { x = (seed % 2147483646) + 1 }
		{ x = (x * 48271) % 2147483647; printf "%010d\t%s\n", x, $0 }' \
		| sort -n | cut -f2-
}

# Run one condition. $1 = condition, $2 = run name, rest = bats files.
# Writes $out/junit/<run>.xml, $out/<run>.tsv, $out/logs/<run>.log.
# Returns 2 when the condition cannot run here (logged, no TSV written).
_flaky_run() {
	local cond=$1 run=$2
	shift 2
	local -a files=("$@") env_cmd=(env) bats_args=()
	local pre='' xml="$out/junit/$run.xml" log="$out/logs/$run.log"

	case $cond in
		baseline) ;;
		reverse)
			mapfile -t files < <(printf '%s\n' "${files[@]}" | tac)
			;;
		shuffle)
			mapfile -t files < <(printf '%s\n' "${files[@]}" \
				| _flaky_shuffle "$seed")
			;;
		jobs)
			if ! command -v parallel > /dev/null; then
				echo "skip $cond: GNU parallel not installed" >> "$out/skipped"
				return 2
			fi
			bats_args=(--jobs "$jobs")
			;;
		isolate)
			_flaky_isolate "$run" "${files[@]}"
			return
			;;
		tz-east) env_cmd+=(TZ=Pacific/Kiritimati) ;;
		tz-west) env_cmd+=(TZ=Etc/GMT+12) ;;
		locale-c) env_cmd+=(LC_ALL=C LANG=C) ;;
		locale-tr)
			if ! locale -a 2> /dev/null | grep -qi '^tr_TR\.utf-\?8$'; then
				echo "skip $cond: tr_TR.UTF-8 locale not installed" \
					>> "$out/skipped"
				return 2
			fi
			env_cmd+=(LC_ALL=tr_TR.UTF-8 LANG=tr_TR.UTF-8)
			;;
		umask-077) pre='umask 077' ;;
		space-paths)
			local sp="$out/space dir/run $run"
			mkdir -p "$sp/tmp" "$sp/home"
			env_cmd+=("TMPDIR=$sp/tmp" "HOME=$sp/home")
			;;
		clean-env)
			env_cmd=(env -i "PATH=$PATH" "HOME=$HOME" TERM=dumb
				"LANG=${LANG:-C.UTF-8}")
			;;
		session-env)
			env_cmd+=(DISPLAY=:0 WAYLAND_DISPLAY=wayland-0
				XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME
				XDG_SESSION_DESKTOP=gnome DESKTOP_SESSION=gnome
				XDG_RUNTIME_DIR=/run/user/1000
				"XDG_DATA_DIRS=/usr/local/share:/usr/share:/var/lib/flatpak/exports/share"
				"XDG_CONFIG_DIRS=/etc/xdg"
				DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
				GTK_IM_MODULE=ibus QT_IM_MODULE=ibus
				CLAUDE_USE_WAYLAND=1 CLAUDE_DISABLE_GPU=1
				CLAUDE_TRAY_USE_DARK_ICON=1 ELECTRON_OZONE_PLATFORM_HINT=auto)
			;;
		*)
			echo "unknown condition: $cond (see --list)" >&2
			return 1
			;;
	esac

	(
		[[ -n $pre ]] && eval "$pre"
		"${env_cmd[@]}" "${_flaky_bats_cmd[@]}" "${bats_args[@]}" \
			--formatter junit "${files[@]}" > "$xml" 2> "$log"
	) || true
	flaky_parse_junit < "$xml" > "$out/$run.tsv"
}

# $1 = a test name as JUnit escapes it. Prints an anchored ERE that matches
# exactly that name, for `bats --filter`.
flaky_name_regex() {
	local name=$1
	name=${name//&lt;/<}
	name=${name//&gt;/>}
	name=${name//&quot;/\"}
	name=${name//&#39;/\'}
	# \& not &: with bash 5.2's patsub_replacement a bare & in the
	# replacement means "the matched text".
	name=${name//&amp;/\&}
	printf '^%s$' "$(printf '%s' "$name" | sed -e 's/[][\\.^$*+?(){}|/]/\\&/g')"
}

# isolate: one bats process per test, run in parallel with xargs.
_flaky_isolate() {
	local run=$1
	shift
	local f list="$out/logs/$run.tests"
	: > "$list"
	# Enumerate the tests from one ordinary run of each file.
	for f in "$@"; do
		"${_flaky_bats_cmd[@]}" --formatter junit "$f" 2> /dev/null \
			| flaky_parse_junit | cut -f2 \
			| while IFS= read -r name; do
				printf '%s\t%s\n' "$f" "$name"
			done >> "$list"
	done
	mkdir -p "$out/isolate-$run"
	# Each line: file<TAB>name. The name is XML-escaped; unescape the five
	# entities and regex-escape it for an exact --filter match.
	local i=0 one re
	# shellcheck disable=SC2016  # expanded by the inner bash, per test
	one='$BATS_CMD --formatter junit --filter "$3" "$2" \
		> "$OUT/isolate-$RUN/$1.xml" 2> /dev/null || true'
	while IFS=$'\t' read -r f name; do
		i=$((i + 1))
		re=$(flaky_name_regex "$name")
		printf '%s\0%s\0%s\0' "$i" "$f" "$re"
	done < "$list" | xargs -0 -n 3 -P "${jobs:-4}" bash -c "$one" _
	cat "$out/isolate-$run"/*.xml 2> /dev/null | flaky_parse_junit \
		> "$out/$run.tsv"
}

#--- Containers ---------------------------------------------------------------

# Run the baseline inside a container. $1 = SPEC (IMAGE[:root|:user][+pkg]).
_flaky_container() {
	local spec=$1 image user='root' pkg='' ctr_jobs=''
	local engine
	engine=$(command -v podman || command -v docker) || {
		echo "skip container $spec: no podman or docker" >> "$out/skipped"
		return 2
	}
	if [[ $spec == *'#jobs' ]]; then
		ctr_jobs=$jobs
		spec=${spec%#jobs}
	fi
	image=${spec%%+*}
	[[ $spec == *+pkg ]] && pkg=$package
	if [[ $image == *:user ]]; then user='user'; image=${image%:user}; fi
	image=${image%:root}
	if [[ -n $pkg && ! -f $pkg ]]; then
		echo "skip container $spec: --package not given or missing" \
			>> "$out/skipped"
		return 2
	fi
	local run="ctr-${image//[:\/]/-}-$user${pkg:++pkg}${ctr_jobs:+-jobs}"
	local work="$out/ctr/$run"
	mkdir -p "$work/src"
	# A copy, so the container can write wherever the tests write.
	tar -C "$repo" --exclude=./build --exclude=./test-build \
		--exclude='./*.deb' --exclude='./*.rpm' --exclude='./*.AppImage' \
		-cf - . | tar -C "$work/src" -xf -
	[[ -n $pkg ]] && cp "$pkg" "$work/pkg.${pkg##*.}"
	local -a files_rel=()
	local f
	for f in "${files[@]}"; do files_rel+=("${f#"$repo"/}"); done
	printf '%s\n' "${files_rel[@]}" > "$work/files"

	cat > "$work/inner.sh" << 'INNER'
set -u
if command -v apt-get > /dev/null; then
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq > /dev/null
	apt-get install -y -qq bats nodejs git file procps xz-utils \
		python3 ${FLAKY_JOBS:+parallel} > /dev/null 2>&1
	if [ -f /w/pkg.deb ]; then
		apt-get install -y -qq /w/pkg.deb > /dev/null 2>&1 \
			|| echo 'package install failed' >&2
	fi
elif command -v dnf > /dev/null; then
	# util-linux for su: fedora:latest ships without it.
	dnf -y -q install bats nodejs git file procps-ng xz python3 \
		util-linux ${FLAKY_JOBS:+parallel} > /dev/null 2>&1
	if [ -f /w/pkg.rpm ]; then
		dnf -y -q install /w/pkg.rpm > /dev/null 2>&1 \
			|| echo 'package install failed' >&2
	fi
fi
cd /w/src || exit 1
mapfile -t files < /w/files
args=()
[ -n "${FLAKY_JOBS:-}" ] && args=(--jobs "$FLAKY_JOBS")
if [ "$FLAKY_USER" = user ]; then
	useradd -m flaky 2> /dev/null || true
	chown -R flaky /w
	su flaky -c "cd /w/src && bats ${args[*]} --formatter junit $(printf '%q ' "${files[@]}")" \
		> /w/result.xml 2> /w/stderr.log
else
	bats "${args[@]}" --formatter junit "${files[@]}" > /w/result.xml \
		2> /w/stderr.log
fi
bats --version > /w/bats-version 2>&1
# Hand the tree back to the container's root, which is the invoking user
# under rootless podman, so the host can delete it afterwards.
chown -R 0:0 /w 2> /dev/null
exit 0
INNER
	"$engine" run --rm -e FLAKY_USER="$user" -e FLAKY_JOBS="$ctr_jobs" \
		-v "$work:/w:Z" "$image" \
		bash /w/inner.sh > "$out/logs/$run.log" 2>&1 || true
	cp "$work/result.xml" "$out/junit/$run.xml" 2> /dev/null || :
	cat "$work/bats-version" >> "$out/logs/$run.log" 2> /dev/null || :
	cat "$work/stderr.log" >> "$out/logs/$run.log" 2> /dev/null || :
	flaky_parse_junit < "$out/junit/$run.xml" > "$out/$run.tsv" 2> /dev/null
	rm -rf "$work/src"
	# A run that never reached bats (missing tool, failed install) yields
	# an empty report; say so instead of comparing an empty run.
	if [[ ! -s $out/$run.tsv ]]; then
		rm -f "$out/$run.tsv"
		echo "no results from container $spec; see logs/$run.log" \
			>> "$out/skipped"
		return 1
	fi
}

#--- Main ---------------------------------------------------------------------

main() {
	local conditions=$FLAKY_DEFAULT runs=1 strict=false package='' prefix=''
	local compare=false
	local -a files=() containers=() log_dirs=()
	seed=1 jobs=4 out=''
	repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

	while (($#)); do
		case $1 in
			--conditions) conditions=$2; shift 2 ;;
			--runs) runs=$2; shift 2 ;;
			--seed) seed=$2; shift 2 ;;
			--jobs) jobs=$2; shift 2 ;;
			--container) containers+=("$2"); shift 2 ;;
			--package) package=$(readlink -f "$2"); shift 2 ;;
			--out) out=$2; shift 2 ;;
			--prefix) prefix=$2; shift 2 ;;
			--compare) compare=true; shift ;;
			--strict) strict=true; shift ;;
			--list) flaky_conditions; return 0 ;;
			-h | --help) sed -n '2,/^#====/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; return 0 ;;
			-*) echo "unknown option: $1" >&2; return 1 ;;
			*) files+=("$(readlink -f "$1")"); shift ;;
		esac
	done

	if $compare; then
		# Positional arguments are result dirs from earlier runs.
		[[ -n $out ]] || out=$(mktemp -d "${TMPDIR:-/tmp}/flaky-check.XXXXXX")
		mkdir -p "$out"
		: > "$out/skipped"
		local d
		local -a tsvs=()
		for d in "${files[@]}"; do
			tsvs+=("$d"/*.tsv)
			[[ -s $d/skipped ]] && cat "$d/skipped" >> "$out/skipped"
		done
		log_dirs=("${files[@]}")
		_flaky_finish "${tsvs[@]}"
		return
	fi

	if ((${#files[@]} == 0)); then
		files=("$repo"/tests/*.bats "$repo"/scripts/cowork-fallback/tests/*.bats)
	fi
	[[ -n $out ]] || out=$(mktemp -d "${TMPDIR:-/tmp}/flaky-check.XXXXXX")
	out=$(readlink -f "$out")
	mkdir -p "$out/junit" "$out/logs"
	: > "$out/skipped"

	_flaky_bats
	export BATS_CMD="${_flaky_bats_cmd[*]}" OUT="$out"

	local cond i run
	local IFS=,
	for cond in $conditions; do
		IFS=$' \t\n'
		for ((i = 1; i <= runs; i++)); do
			run=${prefix:+$prefix-}$cond
			((runs > 1)) && run="$run.$i"
			export RUN="$run"
			echo "[flaky-check] $run ..." >&2
			_flaky_run "$cond" "$run" "${files[@]}" || {
				(($? == 1)) && return 1
			}
		done
		IFS=,
	done
	IFS=$' \t\n'
	for cond in "${containers[@]}"; do
		echo "[flaky-check] container $cond ..." >&2
		_flaky_container "$cond" || true
	done

	log_dirs=("$out")
	_flaky_finish "$out"/*.tsv
}

# Compare the given TSVs and write totals, diff and report.md into $out.
_flaky_finish() {
	local -a tsvs=()
	local t
	for t in "$@"; do
		# A reused or compared dir may hold an earlier comparison's output.
		case ${t##*/} in totals.tsv | diff.tsv) continue ;; esac
		[[ -s $t ]] && tsvs+=("$t")
	done
	if ((${#tsvs[@]} == 0)); then
		echo 'no results' >&2
		return 1
	fi
	flaky_totals "${tsvs[@]}" > "$out/totals.tsv"
	flaky_diff "${tsvs[@]}" > "$out/diff.tsv"
	# bats counts tests before running them; when it runs fewer (a stray
	# `@test` line in a heredoc, which bats 1.10 registers and then cannot
	# find), those tests never reach the JUnit report, so no diff shows
	# them. Its own warnings in the run logs are the only trace.
	local d log
	: > "$out/warnings"
	for d in "${log_dirs[@]}"; do
		for log in "$d"/logs/*.log; do
			[[ -f $log ]] || continue
			grep -hE 'instead of expected|unknown test name' "$log" \
				| sed "s|^|$(basename "$log" .log): |" >> "$out/warnings"
		done
	done
	{
		flaky_report "$out/totals.tsv" < "$out/diff.tsv"
		if [[ -s $out/warnings ]]; then
			echo
			echo 'bats warnings (tests counted but not run):'
			sort -u "$out/warnings" | sed 's/^/- /'
		fi
		if [[ -s $out/skipped ]]; then
			echo
			echo 'Not run here:'
			sed 's/^/- /' "$out/skipped"
		fi
	} > "$out/report.md"
	cat "$out/report.md"
	echo >&2
	echo "[flaky-check] results in $out" >&2
	if $strict && [[ -s $out/diff.tsv ]]; then
		return 1
	fi
	return 0
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
	set -o pipefail
	main "$@"
	exit
fi
