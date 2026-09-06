#!/usr/bin/env bash
# Terminal-riding watchdog for the helix dogfood runner.
# Silent when healthy. Banners (max once per calendar day, each on its own stamp) when the schedule
# mechanism is dead, no run completion has been recorded for >= 2 days, or Trigger-1 has ever fired
# in the sink's history (a standing disclosure, independent of the two health banners above).
# Spec: the dogfood schedule-reliability design (local operating notes)
# Contract: never break shell startup - no set -e, every path neutralized,
# always exit 0. Env seams exist so drills never touch live state.

TRIGGER_FILE="${TRIGGER_FILE:-$HOME/.helix/trigger.jsonl}"
TIMER_UNIT="${TIMER_UNIT:-helix-dogfood.timer}"
STAMP_FILE="${STAMP_FILE:-$HOME/.cache/dogfood-watch.stamp}"
TRIGGER_STAMP_FILE="${TRIGGER_STAMP_FILE:-$HOME/.cache/dogfood-watch-trigger.stamp}"

today() { TZ=Asia/Seoul date +%Y-%m-%d; }

banner() {
  # Throttle: at most one banner per KST calendar day.
  [ -f "$STAMP_FILE" ] && [ "$(cat "$STAMP_FILE" 2>/dev/null)" = "$(today)" ] && return 0
  mkdir -p "$(dirname "$STAMP_FILE")" 2>/dev/null
  today > "$STAMP_FILE" 2>/dev/null
  if [ -t 1 ]; then
    printf '\033[1;31m[dogfood-watch]\033[0m %s\n' "$1"
  else
    printf '[dogfood-watch] %s\n' "$1"
  fi
}

# Trigger-1 has no latch and needs none: every evaluation is already a durable line in the sink.
# What was missing is a reader. Report the DERIVED history rather than the last evaluation alone —
# the asset preload retires the cause, so once the evaluator's trailing window rolls the arm reports
# not-fired and a last-evaluation reader would go silent, hiding a fire that did happen.
# Fixed-string parse of JSON.stringify output: no spaces after colons, every '"' inside a string
# escaped, so '"kind":"evaluation"' and '"overall":"fired"' can occur only as those fields.
trigger_fired_summary() {
  f="$1"                                   # watch.sh passes "$TRIGGER_FILE"; postrun.sh passes "$sink"
  [ -r "$f" ] || return 0
  first=$(grep '"kind":"evaluation"' "$f" 2>/dev/null | grep -m1 '"overall":"fired"' | grep -o '"ts":"[^"]*"' | head -n 1 | cut -d'"' -f4)
  [ -n "$first" ] || return 0
  recent=$(grep '"kind":"evaluation"' "$f" 2>/dev/null | tail -n 14 | grep -c '"overall":"fired"')
  printf 'Trigger-1 has fired since %s; %s of the last 14 evaluations fired.\n' "$first" "$recent"
}

trigger_fired_banner() {
  # Throttled separately from banner() above, on its OWN stamp (TRIGGER_STAMP_FILE): once per KST
  # calendar day is enough to guarantee Trigger-1's fire can never again go unseen for seven days the
  # way the 2026-08-26 fire did — that failure mode was zero readers, not a daily one — and a line on
  # every shell start would be exactly the nag "Silent when healthy" exists to prevent. A separate
  # stamp keeps this disclosure from competing with banner()'s single daily slot below: printing this
  # first must never suppress a same-day timer/gap banner, and vice versa.
  msg=$(trigger_fired_summary "$TRIGGER_FILE")
  [ -n "$msg" ] || return 0
  [ -f "$TRIGGER_STAMP_FILE" ] && [ "$(cat "$TRIGGER_STAMP_FILE" 2>/dev/null)" = "$(today)" ] && return 0
  mkdir -p "$(dirname "$TRIGGER_STAMP_FILE")" 2>/dev/null
  today > "$TRIGGER_STAMP_FILE" 2>/dev/null
  if [ -t 1 ]; then
    printf '\033[1;31m[dogfood-watch]\033[0m %s\n' "$msg"
  else
    printf '[dogfood-watch] %s\n' "$msg"
  fi
}
trigger_fired_banner

# Signal 1: mechanism alive (priority - a dead timer subsumes the gap it causes,
# and it is the one condition catch-up cannot self-heal).
state=$(timeout 2 systemctl --user is-enabled "$TIMER_UNIT" 2>/dev/null)
rc=$?
if [ "$state" = "enabled" ]; then
  : # healthy - fall through to signal 2
elif [ "$state" = "not-found" ]; then
  # Modern systemd prints the literal state word for a missing unit.
  banner "$TIMER_UNIT not found - the daily dogfood run mechanism is GONE. Restore ~/.config/systemd/user/$TIMER_UNIT"
  exit 0
elif [ -n "$state" ]; then
  banner "$TIMER_UNIT is '$state' (not enabled) - the daily dogfood run is OFF. Fix: systemctl --user enable --now $TIMER_UNIT"
  exit 0
elif [ "$rc" -ge 124 ]; then
  banner "timer state unknown (systemctl failed/timed out) - check: systemctl --user status $TIMER_UNIT"
  exit 0
else
  banner "$TIMER_UNIT not found - the daily dogfood run mechanism is GONE. Restore ~/.config/systemd/user/$TIMER_UNIT"
  exit 0
fi

# Signal 2: completion gap, in whole KST calendar days. mtime is a faithful
# "last completion" proxy: the sink is fsync-appended on EVERY service
# completion (success, TERM, timeout alike) since Phase 2 (2026-07-17).
if [ ! -f "$TRIGGER_FILE" ]; then
  banner "cannot assess last dogfood completion - $TRIGGER_FILE is missing"
  exit 0
fi
mt=$(stat -c %Y "$TRIGGER_FILE" 2>/dev/null)
if [ -z "$mt" ]; then
  banner "cannot assess last dogfood completion - stat failed on $TRIGGER_FILE"
  exit 0
fi
last_day=$(TZ=Asia/Seoul date -d "@$mt" +%Y-%m-%d 2>/dev/null)
now_s=$(TZ=Asia/Seoul date -d "$(today)" +%s 2>/dev/null)
last_s=$(TZ=Asia/Seoul date -d "$last_day" +%s 2>/dev/null)
if [ -n "$now_s" ] && [ -n "$last_s" ]; then
  gap=$(( (now_s - last_s) / 86400 ))
  if [ "$gap" -ge 2 ]; then
    banner "no dogfood run completion for $gap days (last: $last_day). A Persistent catch-up may fire on this very boot - investigate only if this banner repeats tomorrow."
  fi
fi
exit 0
