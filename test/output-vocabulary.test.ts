// Output-vocabulary rule, executable: a fresh-clone reader must be able to resolve every
// named path. Private-workspace citations are counted per tracked file and must EQUAL the
// deferral allowlist exactly (deferred sites live inside freeze-governed release docs and
// are cleaned after the pilot window closes — an exact-match allowlist forces that cleanup
// to also shrink this list). Audit/planning records (docs/issues, docs/plans) are excluded:
// citing local material is their nature.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NEEDLE = ['docs', 'superpowers'].join('/'); // join(): this test must not match itself

const ALLOW: Record<string, number> = {
  'docs/release/o67-class-rule-2026-07.md': 3,
  'docs/release/v2-preregistration-2026-07.md': 1,
};

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
    expect(got).toEqual(ALLOW);
  });
});
