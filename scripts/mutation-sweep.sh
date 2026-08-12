#!/usr/bin/env bash
# Scoped mutation sweep over the witness modules. ONE perturbation at a time, restored between each,
# so a survivor is attributable to a single line.
#
# packaging.test.ts is excluded deliberately: it byte-compares a rebuild of bin/ against the
# committed bundle, so it fails on ANY source edit and would score every mutant "killed", making the
# whole sweep meaningless. It is also already red for the duration of the pilot freeze.
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
