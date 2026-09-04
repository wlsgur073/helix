#!/usr/bin/env bash
#
# STATUS: RETIRED 2026-09-05 -- INERT BY DEFAULT. The window this guard enforced ENDED BY ABORT on
# 2026-08-31 (Abort A-2026-08-31, T_abort 2026-08-31T10:02:21Z, anchored at ee35e41; record:
# docs/release/v2-close-report-2026-08.md, rewritten as the ABORT RECORD). The guard wiring is gone
# (no shell rc hook, no systemd ExecStartPre) and the autoUpdate freeze is lifted, so there is
# nothing left to enforce. Its own retirement path CANNOT fire: step 0 exits only on a VALIDATED
# docs/release/v2-close-receipt-2026-08.json, and the window aborted instead of closing, so that
# receipt was never written -- and writing one now would falsify the record.
#
# Two measured reasons the default had to change, not just the wiring (2026-09-05):
#   1. The checks below are anchored to the RETIRED candidate 94dd136 and to the aborted window, so
#      an invocation reports the CORRECT post-abort state (263f2a9 deployed, autoUpdate restored)
#      as six violations. A guard that fails a healthy system is worse than no guard.
#   2. FRC_HEAL defaulted to 1, which armed the `git reset --hard "$CANDIDATE"` below. It could only
#      fire when clone-HEAD drift was the SOLE violation -- six stand today, so it was not live --
#      but the primitive does not belong in a retired tool. The default is now 0.
#
# LEFT IN PLACE RATHER THAN DELETED: the release record cites this script 36 times across four
# TRACKED documents (v2-close-checklist, v2-freeze-deviations, v2-close-report, v2-close-procedure);
# deleting the file would make the D1 rehearsal steps those documents specify unreproducible.
# Measured 2026-09-05: nothing executes it -- no test, no npm script, no CI job, no shell rc, no
# systemd unit.
#
# TO RUN THE HISTORICAL VALIDATOR ANYWAY (forensics, or reproducing a cited drill): FRC_FORCE=1.
# FRC_HEAL still defaults to 0 and must be set explicitly to re-arm the reset.
# freeze-runtime-check.sh - v2 freeze window runtime-pin guard (2026-08).
# Silent when healthy or after a VALIDATED close; one aggregate stderr banner
# and exit 1 while any violation stands. Point-in-time detection, not
# continuous monitoring. Env seams (FRC_*) exist so drills never touch live
# state. Spec + why-log: the 2026-08-09 autoupdate-guard-restore design doc.
# Pinned constants derived 2026-08-09 from the anchored freeze receipt and
# recorded in docs/release/v2-freeze-deviations-2026-08.md. RE-DERIVED 2026-08-14
# for the SECOND window: the first was reset (D-2026-08-13-in-window-tooling), and
# because txClose is derived from a cutoff that is verified against the candidate's
# authored time, a moved window means new values here, not an edited receipt. All
# four must move together — a half-updated set fails the anchor check in step 1,
# which is the intended behaviour and not a bug to work around.

# Retirement gate (2026-09-05). Nothing below runs unless a caller opts in explicitly.
if [ "${FRC_FORCE:-0}" != "1" ]; then
  printf '[freeze-guard] RETIRED 2026-09-05: the v2 window ended by abort on 2026-08-31 and this guard has nothing to enforce (its checks are anchored to the retired candidate). Set FRC_FORCE=1 to run the historical validator.\n' >&2
  exit 0
fi

CANDIDATE="${FRC_CANDIDATE:-94dd136925253be74c58df92392044c550aa6ec2}"
PAYLOAD_SHA="${FRC_PAYLOAD_SHA:-360ffe80f6baf853fdc5acb4bc949a14b84838c3827cbeb56832da56bfcc7332}"
CONFIG_SHA="${FRC_CONFIG_SHA:-16f6d97fffb6b9934f82bcb03570af8657464d9899c22deb89c9cb61555ef9c3}"
TX_CLOSE="${FRC_TX_CLOSE:-2026-09-11T06:20:01Z}"
SETTINGS="${FRC_SETTINGS:-$HOME/.claude/settings.json}"
KNOWN_MP="${FRC_KNOWN_MP:-$HOME/.claude/plugins/known_marketplaces.json}"
INSTALLED="${FRC_INSTALLED:-$HOME/.claude/plugins/installed_plugins.json}"
CLONE="${FRC_CLONE:-$HOME/.claude/plugins/marketplaces/helix}"
CACHE="${FRC_CACHE:-$HOME/.claude/plugins/cache/helix/helix/0.1.0}"
RECEIPT="${FRC_RECEIPT:-$HOME/dev/helix/docs/release/v2-freeze-receipt-2026-08.json}"
PINS="${FRC_PINS:-$HOME/dev/helix/docs/release/v2-freeze-runtime-pins-2026-08.txt}"
HELIX_CONFIG="${FRC_HELIX_CONFIG:-$HOME/.helix/config.json}"
CLOSE_RECEIPT="${FRC_CLOSE_RECEIPT:-$HOME/dev/helix/docs/release/v2-close-receipt-2026-08.json}"

fails=()

# 0. A validated close retires the guard. The close checklist creates this
# file only AFTER full release-record validation (existence alone is nothing).
if [ -f "$CLOSE_RECEIPT" ]; then
  ok=$(python3 - "$CLOSE_RECEIPT" "$PAYLOAD_SHA" <<'PY' 2>/dev/null
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print("no"); raise SystemExit
print("yes" if d.get("artifact")=="close-receipt"
      and d.get("freezePayloadSha256")==sys.argv[2]
      and d.get("releaseRecordPayloadSha256") else "no")
PY
)
  if [ "$ok" = "yes" ]; then exit 0; else fails+=("close receipt present but INVALID: $CLOSE_RECEIPT"); fi
fi

# 1. Receipt anchored by the known payload sha; candidate + config cross-checked.
if [ ! -r "$RECEIPT" ]; then
  fails+=("freeze receipt unreadable: $RECEIPT")
else
  rc=$(python3 - "$RECEIPT" "$PAYLOAD_SHA" "$CANDIDATE" "$CONFIG_SHA" <<'PY' 2>/dev/null
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print("malformed"); raise SystemExit
p=d.get("payload",{}); bad=[]
if d.get("payloadSha256")!=sys.argv[2]: bad.append("payloadSha256")
if p.get("candidateCommit")!=sys.argv[3]: bad.append("candidateCommit")
if p.get("config",{}).get("sha256")!=sys.argv[4]: bad.append("configSha")
print(",".join(bad) if bad else "ok")
PY
)
  [ -z "$rc" ] && rc="malformed"
  [ "$rc" != "ok" ] && fails+=("freeze receipt fails anchor check ($rc): $RECEIPT")
fi

# 2. Both autoUpdate flags must be EXPLICITLY false (absent counts as violation).
v=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("extraKnownMarketplaces",{}).get("helix",{}).get("autoUpdate"))' "$SETTINGS" 2>/dev/null)
[ "$v" = "False" ] || fails+=("settings extraKnownMarketplaces.helix.autoUpdate not false (got ${v:-unreadable})")
v=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("helix",{}).get("autoUpdate"))' "$KNOWN_MP" 2>/dev/null)
[ "$v" = "False" ] || fails+=("known_marketplaces helix.autoUpdate not false (got ${v:-unreadable})")

# 3. Clone HEAD == candidate.
h=$(git -C "$CLONE" rev-parse HEAD 2>/dev/null)
[ "$h" = "$CANDIDATE" ] || fails+=("marketplace clone HEAD ${h:-unreadable} != candidate")

# 4. EVERY helix@helix registry entry on the candidate sha + expected cache path.
v=$(python3 - "$INSTALLED" "$CANDIDATE" "$CACHE" <<'PY' 2>/dev/null
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print("unreadable"); raise SystemExit
bad=[e.get("scope","?") for e in d.get("plugins",{}).get("helix@helix",[])
     if e.get("gitCommitSha")!=sys.argv[2] or e.get("installPath")!=sys.argv[3]]
print(",".join(bad) if bad else "ok")
PY
)
[ -z "$v" ] && v="unreadable"
[ "$v" != "ok" ] && fails+=("installed_plugins helix entries off-pin: $v")

# 5. Runtime surface bytes in BOTH load paths vs the pin list.
if [ ! -r "$PINS" ]; then
  fails+=("runtime pin list unreadable: $PINS")
else
  for root in "$CLONE" "$CACHE"; do
    out=$( (cd "$root" 2>/dev/null && sha256sum --quiet -c "$PINS") 2>&1 )
    [ $? -ne 0 ] && fails+=("runtime bytes off-pin under $root: $(printf '%s' "$out" | head -3 | tr '\n' ' ')")
  done
fi

# 6. Pinned helix config bytes (read-only hash).
s=$(sha256sum "$HELIX_CONFIG" 2>/dev/null | cut -d' ' -f1)
[ "$s" = "$CONFIG_SHA" ] || fails+=("helix config sha ${s:-unreadable} != pin")

# 7. Past scheduled close with no validated close: the guard stays active.
now=$(date -u +%s); close=$(date -u -d "$TX_CLOSE" +%s 2>/dev/null || echo 0)
if [ "$close" -gt 0 ] && [ "$now" -gt "$close" ]; then
  fails+=("past scheduled close ($TX_CLOSE) with no validated close receipt - guard stays active")
fi

[ ${#fails[@]} -eq 0 ] && exit 0

# Auto-heal (owner-approved 2026-08-10, deviation D-2026-08-10): when the SOLE violation is
# clone-HEAD drift and every byte/pin check passed, mechanize the twice-approved remediation —
# reset the clone to the candidate, log the heal, notify on stderr, exit healthy. Any other
# combination (byte drift, flag drift, past-close, dirty clone) still hard-fails below.
HEAL="${FRC_HEAL:-0}"   # was 1 until 2026-09-05; see the RETIRED banner at the top
HEAL_LOG="${FRC_HEAL_LOG:-$HOME/.cache/freeze-guard-heals.log}"
if [ "$HEAL" = "1" ] && [ ${#fails[@]} -eq 1 ] && [[ "${fails[0]}" == "marketplace clone HEAD"* ]]; then
  if [ -z "$(git -C "$CLONE" status --porcelain=v1 2>/dev/null)" ] \
     && git -C "$CLONE" reset --hard "$CANDIDATE" >/dev/null 2>&1 \
     && [ "$(git -C "$CLONE" rev-parse HEAD 2>/dev/null)" = "$CANDIDATE" ]; then
    mkdir -p "$(dirname "$HEAL_LOG")" 2>/dev/null
    printf '%s healed %s -> %s\n' "$(date -u +%FT%TZ)" "$h" "$CANDIDATE" >> "$HEAL_LOG" 2>/dev/null
    printf '[freeze-guard] auto-healed marketplace clone HEAD drift (%s -> candidate; bytes were candidate-identical; logged to %s)\n' "$h" "$HEAL_LOG" >&2
    exit 0
  fi
fi

{
  printf '\033[1;31m[freeze-guard]\033[0m v2 freeze runtime-pin VIOLATION (%d):\n' "${#fails[@]}"
  for f in "${fails[@]}"; do printf '  - %s\n' "$f"; done
  printf '  see: docs/release/v2-freeze-deviations-2026-08.md (deviation ledger + remediation)\n'
} >&2
exit 1
