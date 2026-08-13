// Output-vocabulary rule, executable: a fresh-clone reader must be able to resolve every named path.
// Private-workspace citations are counted per tracked file and must EQUAL the deferral allowlist
// exactly, so the count can never grow. The allowlist also EXPIRES with the freeze window that
// bought the deferral — see its comment below — because an exact-match list alone stops growth
// without ever forcing a shrink. Audit/planning records (docs/issues, docs/plans) are excluded:
// citing local material is their nature.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NEEDLE = ['docs', 'superpowers'].join('/'); // join(): this test must not match itself

// The deferral EXPIRES, and the expiry is read from the signed freeze receipt rather than typed in,
// so it cannot drift from the governance record it depends on. An exact-match allowlist stops the
// count growing but creates no pressure to shrink it: without a deadline these three sites stay by
// habit. After the window closes they must be gone, and this test says so by failing.
//
// Owner: whoever runs the v2 close chain. The three sites are the citations in
// o67-class-rule-2026-07.md (lines 109, 157, 167), naming spec files under the gitignored local
// workspace. They were left in place because o67-class-rule is covered by the freeze receipt, so
// editing it mid-window would require re-issuing that receipt and re-running the verification
// chain — disproportionate for a documentation citation. (The v2-preregistration-2026-07.md
// citation that used to sit alongside these was de-pathed 2026-08-12 rather than deferred: its
// site names the spec by title now, so it never re-enters this count regardless of window state.)
// Reviewed 2026-08-11: the paths carry no usernames, no home directories and no organisation or
// client identifiers; what they disclose is a directory name and a spec naming convention. That is
// why this is an expiring deferral and not a freeze exception.
const ALLOW: Record<string, number> = {
  'docs/release/o67-class-rule-2026-07.md': 3,
};

/** Window close, from the signed receipt's own payload — the same value the close chain runs on. */
function freezeWindowClosesAt(): number {
  const receipt = JSON.parse(readFileSync(resolve(ROOT, 'docs/release/v2-freeze-receipt-2026-08.json'), 'utf8')) as
    { payload: { txClose: string } };
  return Date.parse(receipt.payload.txClose);
}

describe('output vocabulary', () => {
  it('no tracked file cites the private workspace beyond the deferred allowlist', () => {
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
    // Before the window closes exactly the sites in ALLOW are permitted, at exactly their counts and
    // no more — ALLOW is the single source of truth for both which and how many, so no prose here can
    // drift out of step with it (an earlier version of this comment named a count that had since
    // shrunk). After the window closes none are permitted: the deferral was bought by the freeze, and
    // the freeze is over. This is a deadline, not a flaky clock read — it flips once, at an instant the
    // receipt fixes, and the fix is to remove the citations rather than to move the date.
    const expected = Date.now() > freezeWindowClosesAt() ? {} : ALLOW;
    expect(got).toEqual(expected);
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
  // Unlike the Class B deferral above, the allowlist is PERMANENT and by design: the freeze
  // receipt's content IS the runtime load-path record (its three absolute paths are the datum,
  // not a leak, and the payload is sha256-sealed), so the receipt is exempt forever while
  // every other tracked file must stay clean. Ruled by-design in the 2026-08-04 measurement.
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
  const PRIVATE_ALLOW: Record<string, number> = {
    'docs/release/v2-freeze-receipt-2026-08.json': 3,
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
