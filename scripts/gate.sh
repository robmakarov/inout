#!/bin/sh
# ONE HEAVY RUN AT A TIME, ACROSS EVERY SESSION AND EVERY WORKTREE.
#
# WHY THIS EXISTS, and it is not tidiness: this repo's gates are TIMING gates on
# an 8 GB machine. Two sessions running `npm run oracle` at once do not take
# twice as long — they take each other's numbers down. G6 is an entire task
# about gates that flake under load (v1 throughput reads 0.46-0.94x loaded
# against 0.51-0.82x idle; the spur gate moves 25 dB; the 120 s cell dies on CDP
# about one run in three). Note 10 says the rig is wrong before the product is.
#
# So the danger of parallel overnight sessions is NOT that they collide in git —
# T1 fixed that. It is that a session reads a RED gate that is red because
# another session was rendering, believes it, and "fixes" a bug that does not
# exist. That is worse than doing nothing, because it lands.
#
#   scripts/gate.sh npm run oracle
#   scripts/gate.sh npm run exp -- pressure
#   scripts/gate.sh --status          # who holds it, and for how long
#   scripts/gate.sh --wait=0 ...      # fail instead of queueing
#
# Cheap commands (typecheck, unit tests) do NOT need this — they are CPU-bound
# but nothing reads a clock against a band. Wrap anything that opens a browser,
# renders, encodes, or prints a number a gate is read against.
set -eu

repo=$(git rev-parse --show-toplevel)
. "$repo/scripts/lib/session.sh"

# The lock lives in the COMMON git dir, not the worktree's: every worktree for
# this repo must contend for the SAME lock or the whole thing is decorative.
common=$(git rev-parse --git-common-dir)
case "$common" in /*) ;; *) common="$repo/$common" ;; esac
lock="$common/inout-gate.lock"

# A heavy cell can legitimately run for minutes (oracle:long is 182-189 s,
# oracle:load is two phases, memory-slope is 60). Wait generously by default;
# a queued session that waits is doing its job.
wait_max=5400
poll=5
# A holder whose process is gone left the lock behind (killed session, usage
# limit, closed laptop). Reap it rather than blocking the night on a corpse.
stale_after=7200

usage() {
    echo "usage: gate.sh [--wait=SECONDS] <command...>   |   gate.sh --status" >&2
    exit 64
}

holder_line() {
    [ -f "$lock/owner" ] && cat "$lock/owner" 2>/dev/null || echo "unknown"
}

release() {
    # Only ever remove OUR lock: a stale-reap by another session may have handed
    # it on while we ran, and deleting theirs would be the exact mess this
    # script exists to prevent.
    if [ -f "$lock/pid" ] && [ "$(cat "$lock/pid" 2>/dev/null)" = "$$" ]; then
        rm -rf "$lock"
    fi
}

case "${1:-}" in
    --status)
        if [ -d "$lock" ]; then
            started=$(cat "$lock/started" 2>/dev/null || echo 0)
            now=$(date +%s)
            echo "HELD for $((now - started))s by: $(holder_line)"
            echo "command: $(cat "$lock/cmd" 2>/dev/null || echo '?')"
        else
            echo "free"
        fi
        exit 0
        ;;
    --wait=*)
        wait_max=${1#--wait=}
        shift
        ;;
    -*)
        usage
        ;;
esac

[ $# -gt 0 ] || usage

waited=0
while ! mkdir "$lock" 2>/dev/null; do
    started=$(cat "$lock/started" 2>/dev/null || echo 0)
    pid=$(cat "$lock/pid" 2>/dev/null || echo 0)
    now=$(date +%s)
    # Reap a lock whose owner is gone, or one that has outlived any honest run.
    if [ "$pid" -gt 0 ] 2>/dev/null && ! kill -0 "$pid" 2>/dev/null; then
        echo "gate: holder pid $pid is gone — reaping its lock" >&2
        rm -rf "$lock"
        continue
    fi
    if [ "$started" -gt 0 ] 2>/dev/null && [ $((now - started)) -gt "$stale_after" ]; then
        echo "gate: lock older than ${stale_after}s — reaping" >&2
        rm -rf "$lock"
        continue
    fi
    if [ "$waited" -ge "$wait_max" ]; then
        echo "gate: still held after ${waited}s by $(holder_line) — giving up" >&2
        echo "gate: run scripts/gate.sh --status to see it" >&2
        exit 75
    fi
    if [ "$waited" = 0 ]; then
        echo "gate: waiting — held by $(holder_line)" >&2
    fi
    sleep "$poll"
    waited=$((waited + poll))
done

trap 'release' EXIT INT TERM HUP

sid=$(inout_session_id)
branch=$(git branch --show-current 2>/dev/null || echo detached)
printf '%s' "$$" > "$lock/pid"
printf '%s' "$(date +%s)" > "$lock/started"
printf 'session %s · branch %s · %s\n' "${sid:-?}" "$branch" "$repo" > "$lock/owner"
printf '%s\n' "$*" > "$lock/cmd"

[ "$waited" = 0 ] || echo "gate: acquired after ${waited}s" >&2

set +e
"$@"
status=$?
set -e
exit "$status"
