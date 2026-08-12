#!/usr/bin/env bash
# Scoped mutation sweep over the witness modules. ONE perturbation at a time, restored between each,
# so a survivor is attributable to a single line.
#
# packaging.test.ts is excluded deliberately: it byte-compares a rebuild of bin/ against the
# committed bundle, so it fails on ANY source edit and would score every mutant "killed", making the
# whole sweep meaningless. It is also already red for the duration of the pilot freeze.
#
# This script's real product is a WORK LIST, not a coverage claim by itself — and that list otherwise
# lives only in an untracked report, so a fresh clone keeps the tool and loses the findings. The last
# full run (four-file sweep) surfaced two real, still-open gaps, both in src/memory/witness-store.ts:
#   1. deriveState (~line 118): the pending-journal MAC check `if (master && verifyMac(scopeKey,
#      master, raw.journal)) journal = raw.journal; else macInvalid = true;` is written with `&&`.
#      Flipping it to `||` makes the `master` half alone sufficient, skipping MAC verification of the
#      journal entirely whenever a master key is present. Nothing in the test tree tampers a journal's
#      MAC to catch this — the only .mac-adjacent journal values in the suite are hardcoded
#      placeholders in hand-built state doubles that bypass deriveState altogether.
#   2. completeTransition (~line 287): the staleness guard `entry.epoch >= journal.epoch` can be
#      weakened to `>`, which would miss the exact-epoch-equality boundary — a journal whose epoch
#      exactly matches the current entry's should be refused as stale but would instead be allowed to
#      complete. The existing "a journal can never lower the witness" test only drives a journal
#      strictly BEHIND the entry's epoch, never one exactly equal to it, so it never exercises this
#      boundary.
# Re-run the sweep before trusting this list is still current.
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
