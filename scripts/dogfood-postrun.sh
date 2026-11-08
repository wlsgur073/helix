#!/usr/bin/env bash
# ExecStopPost adapter for the T1 dogfood trigger sensor (Phase 2 Track 2a, Task A4 -- see
# the trigger-governance rollout plan). Invoked by systemd
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

# Sink path: HELIX_HOME when it is set and not empty, else $HOME/.helix. This is the artifact's own
# default (resolveHelixPaths in src/memory/home-env.ts): an empty value reads as unset, and a relative
# value is refused by the artifact with exit 3. The reporter-failure write below applies the same
# rule (sink_home_usable). HOME is itself nullable-defaulted here too -- if both HELIX_HOME and HOME
# are unset, the home collapses to the literal path "/.helix", which is normally absent, and the
# write is then skipped like any other missing home; the stdout echo is the journald-only trace.
sink_home="${HELIX_HOME:-${HOME:-}/.helix}"
sink="$sink_home/trigger.jsonl"

# True when the sink path holds nothing or a regular file that is not a symlink (B2a ruling F). The
# fired-history read below and the reporter-failure append both require it, so a FIFO named
# trigger.jsonl cannot block this script and a symlinked trigger.jsonl is neither read nor written
# through. The link test comes first because -e and -f follow a link; a dangling link is a link.
# No check here closes a swap between the look and the open.
sink_file_usable() {
  [ ! -L "$sink" ] && { [ ! -e "$sink" ] || [ -f "$sink" ]; }
}

# Trigger-1 has no latch and needs none: every evaluation is already a durable line in the sink.
# What was missing is a reader. Report the DERIVED history rather than the last evaluation alone --
# the asset preload retires the cause, so once the evaluator's trailing window rolls the arm reports
# not-fired and a last-evaluation reader would go silent, hiding a fire that did happen.
# Fixed-string parse of JSON.stringify output: no spaces after colons, every '"' inside a string
# escaped, so '"kind":"evaluation"' and '"overall":"fired"' can occur only as those fields.
trigger_fired_summary() {
  f="$1"                                   # watch.sh passes "$TRIGGER_FILE"; postrun.sh passes "$sink"
  [ -r "$f" ] || return 0
  first=$(grep '"kind":"evaluation"' "$f" 2>/dev/null | grep -m1 '"overall":"fired"' | grep -o '"ts":"[^"]*"' | head -n 1 | cut -d'"' -f4)
  [ -n "$first" ] || return 0
  n=$(grep -c '"kind":"evaluation"' "$f" 2>/dev/null)
  w=$(( n < 14 ? n : 14 ))                 # the window never claims more evaluations than exist
  recent=$(grep '"kind":"evaluation"' "$f" 2>/dev/null | tail -n 14 | grep -c '"overall":"fired"')
  msg="Trigger-1 has fired since $first; $recent of the last $w evaluations fired."
  # T1-STICKY (item 7): the LATEST acknowledgement (helix-trigger --acknowledge) quiets the alarm
  # until a later evaluation shows NEW evidence: a row, byte or latency leg reading "true" that did
  # not at the acknowledgement, or a RISE in the latency arm's definite slow count (`min`) between
  # consecutive readings, starting from the acknowledged reading (a fall is an old slow recall
  # leaving the window; a null reading is skipped). Known limits: a new slow recall entering in the
  # same interval an old one leaves nets zero and is missed; an evaluation with exactly the
  # acknowledgement's timestamp is not "later" and is not compared. Returns 10 alarm, 11
  # acknowledged, 0 nothing to report.
  ack=$(grep '"kind":"acknowledgement"' "$f" 2>/dev/null | tail -n 1)
  if [ -z "$ack" ]; then
    printf '%s\n' "$msg"
    return 10
  fi
  ack_ts=$(printf '%s' "$ack" | grep -o '"ts":"[^"]*"' | head -n 1 | cut -d'"' -f4)
  prev=$(printf '%s' "$ack" | grep -o '"latency":{"min":[0-9]*' | head -n 1 | grep -o '[0-9]*$')
  rows0=$(printf '%s' "$ack" | grep -o '"rows":{[^}]*}' | head -n 1 | grep -o '"status":"[a-z]*"' | cut -d'"' -f4)
  bytes0=$(printf '%s' "$ack" | grep -o '"bytes":{[^}]*}' | head -n 1 | grep -o '"status":"[a-z]*"' | cut -d'"' -f4)
  lat0=$(printf '%s' "$ack" | grep -o '"latency":{[^}]*}' | head -n 1 | grep -o '"status":"[a-z]*"' | cut -d'"' -f4)
  rearmed=0
  while IFS= read -r line; do
    ts=$(printf '%s' "$line" | grep -o '"ts":"[^"]*"' | head -n 1 | cut -d'"' -f4)
    [[ "$ts" > "$ack_ts" ]] || continue
    cur=$(printf '%s' "$line" | grep -o '"latency":{"min":[0-9]*' | head -n 1 | grep -o '[0-9]*$')
    if [ -n "$cur" ] && [ -n "$prev" ] && [ "$cur" -gt "$prev" ]; then rearmed=1; fi
    [ -n "$cur" ] && prev="$cur"
    rows=$(printf '%s' "$line" | grep -o '"rows":{[^}]*}' | head -n 1 | grep -o '"status":"[a-z]*"' | cut -d'"' -f4)
    bytes=$(printf '%s' "$line" | grep -o '"bytes":{[^}]*}' | head -n 1 | grep -o '"status":"[a-z]*"' | cut -d'"' -f4)
    lat=$(printf '%s' "$line" | grep -o '"latency":{[^}]*}' | head -n 1 | grep -o '"status":"[a-z]*"' | cut -d'"' -f4)
    if [ "$rows" = true ] && [ "$rows0" != true ]; then rearmed=1; fi
    if [ "$bytes" = true ] && [ "$bytes0" != true ]; then rearmed=1; fi
    if [ "$lat" = true ] && [ "$lat0" != true ]; then rearmed=1; fi
  done < <(grep '"kind":"evaluation"' "$f" 2>/dev/null)
  if [ "$rearmed" = 1 ]; then
    printf '%s Re-armed after the acknowledgement of %s: a new slow recall or a size crossing since.\n' "$msg" "$ack_ts"
    return 10
  fi
  printf '%s Acknowledged %s: no new slow recall or size crossing since.\n' "$msg" "$ack_ts"
  return 11
}
# Runs before the artifact call below, so it can never be skipped by an early exit (the artifact
# success path returns right after the call below, with no further stdout of its own). It reads the
# sink only when sink_file_usable holds (above); a FIFO, a directory, a device or a link at the sink
# path prints no summary.
if sink_file_usable; then trigger_fired_summary "$sink"; fi

# HELIX_POSTRUN_TIMEOUT / HELIX_POSTRUN_KILL_AFTER override the production 45s/5s budget. They exist
# ONLY so tests can avoid real 45-second waits -- production always runs with the defaults.
timeout -k "${HELIX_POSTRUN_KILL_AFTER:-5}" "${HELIX_POSTRUN_TIMEOUT:-45}" \
  node "$artifact" --root "${1:-}" --run "$run_id" \
  --service-result "${SERVICE_RESULT:-}" --exit-code "${EXIT_CODE:-}" --exit-status "${EXIT_STATUS:-}"
status=$?

# Dogfood issue auto-file (issue-tracking decision 2026-07-20): when the RUN ITSELF failed --
# SERVICE_RESULT is anything but "success", covering the agent-dead / signal / nonzero cases the
# agent can never self-report -- append one OPEN issue to the project's ISSUES.md so the NEXT
# run's open-issue-first rule picks it up. Two stops are not the run's own failure (B2a ruling H):
# a usage-limit stop and a host shutdown. Those file no issue; one constant line to stdout (journald)
# names which, and the sink keeps the evaluation record the artifact wrote with the same lifecycle
# values (ruling N2: nothing is written to ISSUES.md, so the runner prompt and the agent's memory
# stay as they are). Independent of the reporter artifact's own status
# (checked BEFORE the exit-0 early return below: a healthy reporter can coexist with a failed
# run). Fixed template; lifecycle enums pass the same control/quote/backslash strip as the sink
# record plus shell-metacharacter strip (defensive -- systemd values are enum-like already); the
# run id is machine-generated. Best-effort and fully guarded like everything in this script --
# a missing/unwritable ISSUES.md (or an absent $1) silently skips, and nothing here can break
# the trailing exit 0. Next id = HIGHEST existing "## ISSUE-NNNN" + 1 (the file's own convention;
# a count would collide after gaps). 10# forces decimal -- zero-padded ids would otherwise parse
# as octal and "0008"/"0009" would abort the arithmetic.
NOTE_USAGE_LIMIT='dogfood-postrun: no issue filed, the run stopped at a usage limit'
NOTE_HOST_SHUTDOWN='dogfood-postrun: no issue filed, the host was shutting down'
RUN_LOG_FRESH_SECONDS=600

# Prints "limit", "shutdown" or nothing for a run that did not succeed. $1 = the dogfood root.
#  limit    -- the newest run log under "$1/runs" (the runner's own tee target; by mtime, so a retry's
#              -attemptN log counts) was written within RUN_LOG_FRESH_SECONDS and its FIRST line is the
#              CLI's usage-limit message ("You've hit your session limit ...", "... weekly limit ...").
#              A stale log (the run died before writing one) and a limit message further down a log
#              (the agent quoting it) do not count.
#  shutdown -- SERVICE_RESULT is "signal" and the system manager or the user manager reports
#              "stopping" (systemctl is-system-running). A TERM from anyone else stays a failure.
# Not measured on a real shutdown yet: the stub tests pin the rule, the next boot that ends a
# catch-up run is the observation.
classify_run_stop() {
  local root="${1:-}" f newest="" first="" mt now state
  if [ -n "$root" ]; then
    for f in "$root"/runs/20*.log; do
      [ -f "$f" ] || continue
      if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then newest="$f"; fi
    done
  fi
  if [ -n "$newest" ]; then
    mt=$(stat -c %Y "$newest" 2>/dev/null)
    now=$(date +%s)
    if [ -n "$mt" ] && [ $(( now - mt )) -le "$RUN_LOG_FRESH_SECONDS" ]; then
      IFS= read -r first < "$newest" 2>/dev/null
      case "$first" in
        "You've hit your "*" limit"*) printf 'limit'; return 0 ;;
      esac
    fi
  fi
  if [ "${SERVICE_RESULT:-}" = "signal" ]; then
    state=$(timeout 5 systemctl is-system-running 2>/dev/null)
    if [ "$state" = "stopping" ]; then printf 'shutdown'; return 0; fi
    state=$(timeout 5 systemctl --user is-system-running 2>/dev/null)
    if [ "$state" = "stopping" ]; then printf 'shutdown'; return 0; fi
  fi
  return 0
}

run_stop=""
if [ "${SERVICE_RESULT:-}" != "success" ]; then
  run_stop=$(classify_run_stop "${1:-}")
fi
case "$run_stop" in
  limit) printf '%s\n' "$NOTE_USAGE_LIMIT" ;;
  shutdown) printf '%s\n' "$NOTE_HOST_SHUTDOWN" ;;
esac

if [ "${SERVICE_RESULT:-}" != "success" ] && [ -z "$run_stop" ] && [ -n "${1:-}" ] && [ -f "${1}/ISSUES.md" ]; then
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
# exiting under its own logic (a genuine crash). Exit 3 is helix-trigger's own refusal of a home
# (B2a plan decisions P1 and P2: a relative or unresolvable HELIX_HOME, a symlinked home, a missing
# parent, a home owned by someone else). It keeps reason "crash" -- the sink's reasons stay the three
# above -- and adds one optional field, home_refused, so a reader can tell it from a crash (exit 1).
home_refused=""
case "$status" in
  124|137) reason="timeout" ;;
  126|127) reason="launch-failure" ;;
  3) reason="crash"; home_refused=',"home_refused":true' ;;
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
record=$(printf '{"v":1,"policy":"T1-2026-07-11","kind":"reporter-failure","ts":"%s","run":"%s","service_result":%s,"exit_code":%s,"exit_status":%s,"reason":"%s"%s}' \
  "$ts" "$run_id" \
  "$(json_lifecycle "${SERVICE_RESULT:-}")" "$(json_lifecycle "${EXIT_CODE:-}")" "$(json_lifecycle "${EXIT_STATUS:-}")" \
  "$reason" "$home_refused")

# True when the sink's home may be written to by this adapter (B2a ruling F): an absolute path (the
# artifact refuses a relative HELIX_HOME, so a relative one never names a home), not a symlink (every
# Helix write through a symlinked home is refused; the last component is looked at with trailing
# slashes and a trailing "/." removed, as resolveHelixPaths cuts them in src/memory/home-env.ts,
# because "link/" and "link/." would otherwise be followed by the look) and an existing directory
# (this adapter never creates the home or its parents; the artifact creates a missing home through
# ensureHelixDir, one 0700 directory under an existing parent). A home reached as "<link>/../name" is
# the kernel's, as for the server. No check here closes a swap between the look and the append.
sink_home_usable() {
  local h="$sink_home"
  while :; do
    if [ "${#h}" -gt 1 ] && [ "${h%/}" != "$h" ]; then h="${h%/}"; continue; fi
    if [ "${#h}" -gt 2 ] && [ "${h%/.}" != "$h" ]; then h="${h%/.}"; continue; fi
    break
  done
  case "$h" in /*) ;; *) return 1 ;; esac
  [ ! -L "$h" ] && [ -d "$h" ]
}

# Best-effort append: plain `>>`, no fsync -- this IS the failure-reporting path, so it stays as
# simple and dependency-free as possible (the success path's fsynced write, owned by the artifact
# itself, is where the durability guarantee actually lives). It is skipped when the home is not
# usable (above) or the sink path holds something other than a regular file (sink_file_usable); if
# the sink is unwritable otherwise (wrong permissions), the append below silently fails -- there is
# no `set -e`, so the script keeps going either way -- and the stdout echo next is the ONLY trace,
# picked up by journald.
if sink_home_usable && sink_file_usable; then
  printf '%s\n' "$record" >> "$sink" 2>/dev/null
fi

# One echo either way (append succeeded or failed) -- the record always reaches journald via stdout,
# even when the sink write silently failed.
printf '%s\n' "$record"

exit 0
