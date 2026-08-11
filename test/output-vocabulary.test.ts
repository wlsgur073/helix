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
// count growing but creates no pressure to shrink it: without a deadline these four sites stay by
// habit. After the window closes they must be gone, and this test says so by failing.
//
// Owner: whoever runs the v2 close chain. The four sites are three citations in
// o67-class-rule-2026-07.md (lines 109, 157, 167) and one in v2-preregistration-2026-07.md (551),
// all naming spec files under the gitignored local workspace. They were left in place because
// o67-class-rule is covered by the freeze receipt, so editing it mid-window would require re-issuing
// that receipt and re-running the verification chain — disproportionate for a documentation citation.
// Reviewed 2026-08-11: the paths carry no usernames, no home directories and no organisation or
// client identifiers; what they disclose is a directory name and a spec naming convention. That is
// why this is an expiring deferral and not a freeze exception.
const ALLOW: Record<string, number> = {
  'docs/release/o67-class-rule-2026-07.md': 3,
  'docs/release/v2-preregistration-2026-07.md': 1,
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
    // Before the window closes the four deferred sites are allowed, exactly and no more. After it
    // closes they are not: the deferral was bought by the freeze, and the freeze is over. This is a
    // deadline, not a flaky clock read — it flips once, at an instant the receipt fixes, and the fix
    // is to remove the citations rather than to move the date.
    const expected = Date.now() > freezeWindowClosesAt() ? {} : ALLOW;
    expect(got).toEqual(expected);
  });
});
