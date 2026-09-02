// Output-vocabulary rule, executable: a fresh-clone reader must be able to resolve every named path.
// Private-workspace citations are counted per tracked file and the count must be ZERO: no tracked
// file may cite the private workspace, and neither a clock nor a receipt is read to decide that.
// Until 2026-09-02 the rule carried an expiring deferral for three citations; it was retired early
// and is recorded below, because a rule that was removed is the part no changelog keeps.
// Audit/planning records (docs/issues, docs/plans) are excluded: citing local material is their
// nature.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NEEDLE = ['docs', 'superpowers'].join('/'); // join(): this test must not match itself

// Class B, RETIRED 2026-09-02 — the rule is now unconditional: NO tracked file may cite the private
// workspace, at any time. The record of what the deferral was is kept here on purpose, because the
// removal of a rule is the part no changelog preserves.
//
// What it was: an expiring allowlist of exactly one file, docs/release/o67-class-rule-2026-07.md at
// exactly 3 citations (its lines 109, 157, 167), naming spec files under the gitignored local
// workspace. Its expiry was READ from the signed freeze receipt's payload.txClose rather than typed
// in here, so it could not drift from the governance record it depended on, and before that instant
// the three citations were REQUIRED to be present.
//
// Why it ended EARLY, on 2026-09-02 rather than at that txClose of 2026-09-11T06:20:01Z: the
// deferral's stated ground was cost, not entitlement — o67-class-rule is covered by the freeze
// receipt, so editing it mid-window would have required re-issuing that receipt and re-running the
// verification chain, disproportionate for a documentation citation. That chain is
// scripts/pilot/input-pins.ts, which re-derives the method-doc hashes at the close and refuses
// `method-drift` on any change. The owner ended the window on 2026-08-31 (Abort A-2026-08-31,
// anchored at ee35e41; record in docs/release/v2-close-report-2026-08.md), so no close chain will
// run and no validated close receipt will ever be written. With the ground gone the obligation to
// remove could be met at once — early compliance with an obligation to remove, not a waiver of it.
// It moves the removal, never the deadline, and the rule it leaves behind is STRICTER than the one
// the deadline would have produced: not "exactly 3 until an instant, then 0", but 0 at all times.
//
// THE RECEIPT WAS NOT EDITED. Its payload is sha256-sealed and downstream records cite it, and
// txClose still reads 2026-09-11T06:20:01.000Z. What was removed is the deferral that read it. This
// test no longer OPENS the receipt at all; below, it is only a path name inside PRIVATE_ALLOW's
// by-design exemption.
//
// WHAT THIS COSTS, recorded here because nothing else measures it. o67-class-rule-2026-07.md is one
// of the two receipt-pinned method documents (PINNED_METHOD_DOCS, scripts/pilot/pin-hashes.ts),
// pinned at sha256 c1fe768ca0ec2b11…. Removing the citations changes its bytes, so from 2026-09-02
// the working tree DIVERGES from that pin, permanently and by intent. Three consequences, each
// measured that day rather than reasoned. The freeze guard stays GREEN: it hashes every pinned path
// out of the CANDIDATE COMMIT and only warns about the working tree, and the candidate blob at
// 94dd136 is untouched, so the receipt is still true about what it actually pinned. `input-pins`
// re-run against this receipt from this tree now refuses `method-drift` naming this file, and will
// do so forever — harmless only because the close it guarded was canceled. And the other pinned
// method document, gate-decision-2026-07-22.md, still matches its pin.
//
// Tracked records that still say the three citations "must REMAIN until 2026-09-11" derive that
// clause from the mechanism removed here — they describe this test rather than bind it — so they go
// stale on the day this lands rather than being contradicted by it. The abort record's §2.2 entry
// is the one needing a dated correction rather than a re-wording, because it is a MEASUREMENT
// ("sha256sum … still equals the pinned value") and it is the authority the other records cite.
//
// How the three sites were ended: DE-PATHED, not deleted, on the precedent this file already
// recorded — the v2-preregistration-2026-07.md citation that used to sit alongside them was
// de-pathed 2026-08-12 rather than deferred, and because that site names the spec by date and title
// it never re-enters this count regardless of window state. Nothing checks the SHAPE of the
// replacement text, only the count below, and the cited specs were removed from the working tree in
// the same operation (they survive in two local archives), so read the document itself for what
// those three lines now say and do not trust this comment for it.
//
// Reviewed 2026-08-11, kept because it is what made a deferral defensible rather than a leak: the
// paths carried no usernames, no home directories and no organisation or client identifiers; what
// they disclosed was a directory name and a spec naming convention. That is why this was an
// expiring deferral and not a freeze exception.

describe('output vocabulary', () => {
  it('no tracked file cites the private workspace', () => {
    let out = '';
    try {
      out = execFileSync('git',
        ['-C', ROOT, 'grep', '-c', NEEDLE, '--', ':!docs/issues', ':!docs/plans'],
        { encoding: 'utf8' });
    } catch (e) {
      const r = e as { status?: number; stdout?: string };
      if (r.status === 1) out = r.stdout ?? ''; // grep: no matches at all
      else throw e;
    }
    const got: Record<string, number> = {};
    for (const line of out.split('\n').filter(Boolean)) {
      const i = line.lastIndexOf(':');
      got[line.slice(0, i)] = Number(line.slice(i + 1));
    }
    // Zero sites, unconditionally. There is no allowlist left for prose to drift out of step with
    // (an earlier version of the comment here named a count that had since shrunk), and no clock
    // read, so the verdict no longer depends on when the suite runs. Compared as a map rather than
    // as a count so the failure names the offending file and how many times it cites the workspace.
    expect(got).toEqual({});
  });

  // Class A: POSIX-style private path prefixes, and ONLY those two — a leading `/home/<segment>` or
  // `/mnt/c/Users/<segment>`. The name of this lock used to promise "absolute private paths (home
  // directories, Windows user profiles)", which is materially broader than what the regex sees.
  // MEASURED 2026-08-12 against this exact pattern, all passing SILENTLY: native Windows
  // `C:\Users\<user>\...`, macOS `/Users/<user>/...`, UNC `\\wsl$\<distro>\home\<user>`, and the
  // slash-preceded forms `file:///home/<user>/...` and `//home/<user>/...` (the character before
  // `/home` is `/`, which the leading guard counts as path context, so the guard itself rejects
  // them). Those shapes are NOT checked here. The claim is narrowed rather than the pattern widened
  // on purpose: widening has to be re-measured against every tracked file, including the pinned
  // ones, and that is a separate job from stating honestly what today's lock covers.
  // Unlike the Class B deferral recorded above — retired 2026-09-02 — this allowlist is PERMANENT
  // and by design: the freeze receipt's content IS the runtime load-path record (its three absolute
  // paths are the datum, not a leak, and the payload is sha256-sealed), so the receipt is exempt
  // forever while every other tracked file must stay clean. Ruled by-design in the 2026-08-04
  // measurement.
  // The leading boundary admits start-of-line OR any character outside `[A-Za-z0-9._/-]` — which is
  // WIDER than "only an actual absolute-path start", as an earlier version of this comment claimed.
  // Measured consequence: a RELATIVE segment named "home" DOES count when a non-path character sits
  // immediately before it — an angle-bracketed placeholder directory followed by a "home" segment and
  // then a filename matches, whereas the same path with a LETTER before that slash does not. That
  // example is described here rather than written out because writing it out makes this file fail its
  // own lock, which is the proof. The tree has one such site — a scope-labelled fixture path in a doc
  // comment — and it escapes only because the line wraps right after the "home" segment, leaving
  // nothing for the trailing `[A-Za-z0-9._-]+` to match. Left as-is deliberately: tightening the
  // boundary to start-of-line/whitespace/quote would NARROW a privacy lock (it would stop matching
  // real leaks like `path=/home/<user>/...`), so the wider guard stays and the comment states it.
  const PRIVATE_RE =
    ['(^|[^A-Za-z0-9._', '/-])(/home', '|/mnt/c/Users)/', '[A-Za-z0-9._', '-]+'].join(''); // join(): this test must not match itself
  // Two entries since 2026-08-14, not a widened rule. The first window was reset, and a freeze
  // receipt is immutable evidence: the superseded one is RENAMED, never scrubbed or deleted, so its
  // three load-path lines survive under the void filename and carry the same by-design exemption
  // the live receipt has. Each window that resets adds exactly one more row here, by name and by
  // count — which is the point of listing counts rather than globbing the receipts: this test is
  // what forced the question to be decided rather than absorbed.
  const PRIVATE_ALLOW: Record<string, number> = {
    'docs/release/v2-freeze-receipt-2026-08.json': 3,
    'docs/release/v2-freeze-receipt-2026-08-02-void.json': 3,
  };

  it('no tracked file carries a leading /home or /mnt/c/Users path beyond the by-design receipt (other private-path spellings are NOT checked — see above)', () => {
    let out = '';
    try {
      out = execFileSync('git',
        ['-C', ROOT, 'grep', '-c', '-E', PRIVATE_RE, '--', ':!docs/issues', ':!docs/plans'],
        { encoding: 'utf8' });
    } catch (e) {
      const r = e as { status?: number; stdout?: string };
      if (r.status === 1) out = r.stdout ?? ''; // no matches anywhere
      else throw e;
    }
    const got: Record<string, number> = {};
    for (const line of out.split('\n').filter(Boolean)) {
      const i = line.lastIndexOf(':');
      got[line.slice(0, i)] = Number(line.slice(i + 1));
    }
    expect(got).toEqual(PRIVATE_ALLOW);
  });
});
