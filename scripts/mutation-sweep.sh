#!/usr/bin/env bash
# Scoped mutation sweep over the witness modules. ONE perturbation at a time, restored between each,
# so a survivor is attributable to a single line.
#
# packaging.test.ts is excluded deliberately: it byte-compares a rebuild of bin/ against the
# committed bundle, so it fails on ANY source edit and would score every mutant "killed", making the
# whole sweep meaningless. It is also already red for the duration of the pilot freeze.
#
# This script's real product is a WORK LIST, not a coverage claim by itself — and that list otherwise
# lives only in an untracked report, so a fresh clone keeps the tool and loses the findings. Its last
# full run (four-file sweep) surfaced two gaps, both in src/memory/witness-store.ts. BOTH ARE NOW
# CLOSED, and the guard for each is a tracked test, so this outcome survives a clone even though the
# report it came from does not:
#   1. deriveState's pending-journal MAC check, written `if (master && verifyMac(...)) journal = ...`.
#      Flipping `&&` to `||` made the `master` half alone sufficient, skipping MAC verification of the
#      journal entirely whenever a master key was present, and nothing in the test tree tampered a
#      journal's MAC. Closed by test/memory/witness-store.test.ts's "tamper: flip one hex char of the
#      stored JOURNAL mac on disk -> macInvalid, journal suppressed".
#   2. completeTransition's staleness guard `entry.epoch >= journal.epoch`. Weakening it to `>` missed
#      the exact-epoch-equality boundary: the older "a journal can never lower the witness" case only
#      drove a journal strictly BEHIND the entry's epoch, never one exactly equal to it. Closed by the
#      same file's "refuses a journal whose epoch the witness has exactly REACHED, not only one it has
#      passed".
# Re-measured after the fact rather than taken from the commits that claim them: each mutation was
# re-applied here and the whole suite re-run. Line numbers are omitted on purpose — they drift, and a
# stale one sends a later reader to unrelated code. Grep the symbol instead.
#
# Correction to the commit that made this change: its message said the two line numbers this header
# used to carry (~118, ~287) "had already stopped pointing at the guards they named". That was wrong —
# checked afterwards, both were still exact at the parent commit. Dropping them is a policy about what
# survives future edits, not a repair of something already broken, and the message should have said so.
# Re-run the sweep before trusting any list here is still current.
set -u
cd "$(dirname "$0")/.."
BAK=$(mktemp -d)
trap 'rm -rf "$BAK"' EXIT
TARGETS="${TARGETS:-src/memory/witness-core.ts src/memory/witness-store.ts src/memory/witness-read.ts src/memory/witness-write.ts}"

# from|to, applied to the first match on a line. Each rule mutates a freshly-restored copy of the
# file (the restore runs after every rule below), so rule order does not let one rule's output feed
# the next rule's input.
RULES="<=|<
<|<=
>=|>
>|>=
&&|II
III|&&"
# (The last two use II/III as stand-ins written by the sed below; bash here-strings and | collide.)

fails_now() { npx vitest run --exclude 'test/plugin/packaging.test.ts' 2>&1 | grep -cE '^ FAIL'; }

survived=0
killed=0
for f in $TARGETS; do
  base=$(basename "$f")
  cp "$f" "$BAK/$base"
  total=$(wc -l < "$f")
  for ((line=1; line<=total; line++)); do
    while IFS='|' read -r from to; do
      [ -z "$from" ] && continue
      [ "$from" = "III" ] && from='||'
      [ "$to" = "II" ] && to='||'
      MUT_FILE="$f" MUT_LINE="$line" MUT_FROM="$from" MUT_TO="$to" python3 -c '
import os, sys
path = os.environ["MUT_FILE"]; line = int(os.environ["MUT_LINE"])
frm = os.environ["MUT_FROM"]; to = os.environ["MUT_TO"]
lines = open(path, encoding="utf-8").read().split("\n")
if frm not in lines[line-1]: sys.exit(1)
lines[line-1] = lines[line-1].replace(frm, to, 1)
open(path, "w", encoding="utf-8").write("\n".join(lines))
' || continue
      n=$(fails_now)
      if [ "$n" -eq 0 ]; then
        echo "SURVIVED  $f:$line  $from -> $to"
        survived=$((survived + 1))
      else
        killed=$((killed + 1))
      fi
      cp "$BAK/$base" "$f"
    done <<< "$RULES"
  done
done
echo "---"
echo "survived=$survived killed=$killed"
git status --short src/
