#!/usr/bin/env bash
# ExecStopPost adapter for the T1 dogfood trigger sensor (Phase 2 Track 2a, Task A4 -- see
# docs/superpowers/plans/2026-07-17-phase2-trigger-governance-and-disclosure.md). Invoked by systemd
# as `ExecStopPost=<abs repo path>/scripts/dogfood-postrun.sh <dogfood root>` on every stop path
# (clean exit, non-zero exit, signal kill, failed startup -- man-verified, systemd 255). ExecStart's
# shell state is NOT inherited by ExecStopPost -- everything this script needs arrives via argv ($1)
# and systemd-provided env (SERVICE_RESULT / EXIT_CODE / EXIT_STATUS / INVOCATION_ID), any of which
# MAY BE UNSET (e.g. a startup-resource failure never reaches the point where systemd sets them, or a
# broken ExecStopPost= invocation omits the dogfood-root argument entirely). Every expansion below --
# $1 included -- is nullable-defaulted (`${VAR:-...}`) so `set -u` never aborts this script on a
# missing one.
#
# Single writer per record kind: the measurement artifact (bin/helix-trigger.mjs, Tasks A2/A3) is the
# ONLY writer of `kind:"evaluation"` records -- it self-validates before its one sink append, so a
# timeout-truncated stdout line can never become a torn evaluation record. This script is the ONLY
# writer of `kind:"reporter-failure"` records, composed from a FIXED template (enums, numbers, and
# machine-generated ids only -- never untrusted bytes, never a path) whenever the artifact does not
# exit 0. This script never reads, parses, or forwards the artifact's own stdout into the sink -- that
# stdout passes straight through to journald, untouched, exactly as the artifact wrote it.
#
# This adapter ALWAYS exits 0. Every step below is guarded so that no failure -- of the artifact, of
# the sink append, of this script's own bookkeeping, or of the final stdout echo itself -- can
# propagate a nonzero exit: a nonzero ExecStopPost exit marks the systemd unit "failed", which would
# pollute the dogfood agent's own run result with an unrelated reporting-path failure. SIGPIPE is
# trapped (ignored) below, before `set -u`, because bash's default SIGPIPE disposition would otherwise
# kill this script outright (exit 141) if the final echo's reader goes away early (e.g. a journald
# hiccup) -- with the trap, that `printf` simply returns a normal nonzero status and execution still
# reaches the trailing `exit 0`.
trap '' PIPE
set -u

# Run id: INVOCATION_ID (a systemd-minted id, stable for this unit invocation) when available, else a
# same-shape fallback (`p<pid>-<epoch seconds>`) -- both are machine-generated and JSON-safe as-is, so
# neither goes through the lifecycle quoting helper below.
run_id="${INVOCATION_ID:-p$$-$(date +%s)}"

# Locate the compiled artifact relative to THIS script's own location, not the caller's cwd --
# ExecStopPost does not inherit ExecStart's shell state, and systemd may invoke this script from an
# arbitrary working directory.
artifact="$(cd "$(dirname "$0")" && pwd)/../bin/helix-trigger.mjs"

# Sink path mirrors the artifact's own resolution (scripts/trigger-measure.ts resolveHome): HELIX_HOME
# when set, else ~/.helix. HOME is itself nullable-defaulted here too -- if both HELIX_HOME and HOME
# are unset, this collapses to the literal path "/.helix/trigger.jsonl" (normally unwritable for a
# non-root user); the mkdir/append below then fail exactly like any other unwritable-sink case, and
# the stdout echo is the journald-only trace (the already-tested sink-unwritable path).
sink="${HELIX_HOME:-${HOME:-}/.helix}/trigger.jsonl"

# HELIX_POSTRUN_TIMEOUT / HELIX_POSTRUN_KILL_AFTER override the production 45s/5s budget. They exist
# ONLY so tests can avoid real 45-second waits -- production always runs with the defaults.
timeout -k "${HELIX_POSTRUN_KILL_AFTER:-5}" "${HELIX_POSTRUN_TIMEOUT:-45}" \
  node "$artifact" --root "${1:-}" --run "$run_id" \
  --service-result "${SERVICE_RESULT:-}" --exit-code "${EXIT_CODE:-}" --exit-status "${EXIT_STATUS:-}"
status=$?

# Dogfood issue auto-file (issue-tracking decision 2026-07-20): when the RUN ITSELF failed --
# SERVICE_RESULT is anything but "success", covering the agent-dead / signal / nonzero cases the
# agent can never self-report -- append one OPEN issue to the project's ISSUES.md so the NEXT
# run's open-issue-first rule picks it up. Independent of the reporter artifact's own status
# (checked BEFORE the exit-0 early return below: a healthy reporter can coexist with a failed
# run). Fixed template; lifecycle enums pass the same control/quote/backslash strip as the sink
# record plus shell-metacharacter strip (defensive -- systemd values are enum-like already); the
# run id is machine-generated. Best-effort and fully guarded like everything in this script --
# a missing/unwritable ISSUES.md (or an absent $1) silently skips, and nothing here can break
# the trailing exit 0. Next id = HIGHEST existing "## ISSUE-NNNN" + 1 (the file's own convention;
# a count would collide after gaps). 10# forces decimal -- zero-padded ids would otherwise parse
# as octal and "0008"/"0009" would abort the arithmetic.
if [ "${SERVICE_RESULT:-}" != "success" ] && [ -n "${1:-}" ] && [ -f "${1}/ISSUES.md" ]; then
  {
    last=$(grep -o '^## ISSUE-[0-9]\{1,\}' "${1}/ISSUES.md" 2>/dev/null | sed 's/.*ISSUE-//' | sort -n | tail -1)
    issue_n=$(( 10#${last:-0} + 1 ))
    sr=$(printf '%s' "${SERVICE_RESULT:-unknown}" | tr -d '\000-\037\177"\\`$')
    es=$(printf '%s' "${EXIT_STATUS:-unknown}" | tr -d '\000-\037\177"\\`$')
    today=$(date -u +%Y-%m-%d)
    printf '\n## ISSUE-%04d — %s — OPEN — severity: high\n- symptom: run-level failure, auto-filed by postrun adapter (service_result=%s exit_status=%s)\n- evidence: journalctl --user -u helix-dogfood.service --since "%s"; run id %s\n- suspected cause: (next session: diagnose from the journal)\n- resolution: (filled at close)\n- closed: (date + commit id)\n' \
      "$issue_n" "$today" "$sr" "$es" "$today" "$run_id" >> "${1}/ISSUES.md"
  } 2>/dev/null || true
fi

# Artifact exit 0 -> it already validated and appended its own evaluation record. Nothing more to do.
if [ "$status" -eq 0 ]; then
  exit 0
fi

# Reason mapping from the timeout(1)/node exit status. 124 = `timeout` delivered TERM and the command
# exited as a result; 137 = 128+9, the command was still alive after the kill-after grace period and
# `timeout` escalated to KILL -- both mean "it ran too long", so both map to the same reason. 126/127
# = `timeout` itself could not exec `node` at all (not found / not executable) -- a launch failure,
# never reached by the artifact's own logic (a merely-missing artifact FILE still lets `node` launch
# and then exit 1, which falls through to the crash case below). Anything else nonzero is the artifact
# exiting under its own logic (a genuine crash).
case "$status" in
  124|137) reason="timeout" ;;
  126|127) reason="launch-failure" ;;
  *) reason="crash" ;;
esac

# Renders one lifecycle value as a JSON scalar: unset/empty -> the unquoted literal `null`; anything
# else -> a quoted string. systemd's own SERVICE_RESULT/EXIT_CODE/EXIT_STATUS values are short,
# enum-like, and shell-safe already, but this still strips `"`, `\`, and control bytes (defensively --
# not a real adversarial boundary) before quoting, so a value from an unexpected systemd version can
# never break the fixed template below.
json_lifecycle() {
  if [ -z "$1" ]; then
    printf 'null'
    return
  fi
  local cleaned
  cleaned=$(printf '%s' "$1" | tr -d '\000-\037\177"\\')
  printf '"%s"' "$cleaned"
}

ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
record=$(printf '{"v":1,"policy":"T1-2026-07-11","kind":"reporter-failure","ts":"%s","run":"%s","service_result":%s,"exit_code":%s,"exit_status":%s,"reason":"%s"}' \
  "$ts" "$run_id" \
  "$(json_lifecycle "${SERVICE_RESULT:-}")" "$(json_lifecycle "${EXIT_CODE:-}")" "$(json_lifecycle "${EXIT_STATUS:-}")" \
  "$reason")

# Best-effort append: plain `>>`, no fsync -- this IS the failure-reporting path, so it stays as
# simple and dependency-free as possible (the success path's fsynced write, owned by the artifact
# itself, is where the durability guarantee actually lives). If the sink is unwritable (missing
# parent, wrong permissions, or something else occupying the sink path), mkdir/the append below
# silently fail -- there is no `set -e`, so the script keeps going either way -- and the stdout echo
# next is the ONLY trace, picked up by journald.
mkdir -p "$(dirname "$sink")" 2>/dev/null
printf '%s\n' "$record" >> "$sink" 2>/dev/null

# One echo either way (append succeeded or failed) -- the record always reaches journald via stdout,
# even when the sink write silently failed.
printf '%s\n' "$record"

exit 0
