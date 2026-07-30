import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { strayTrustFiles, TRUST_FILE_NAMES } from '../../src/memory/trust-store-layout.js';

const layout = () => {
  const base = mkdtempSync(join(tmpdir(), 'helix-layout-'));
  const home = join(base, 'home');
  const elsewhere = join(base, 'repo');
  mkdirSync(home);
  mkdirSync(elsewhere);
  return { home, elsewhere };
};

describe('strayTrustFiles', () => {
  it('finds nothing when the ledger lives in the home directory', () => {
    const { home } = layout();
    writeFileSync(join(home, 'ledger-mac-master.key'), randomBytes(32));
    expect(strayTrustFiles(home, join(home, 'memory.jsonl'))).toEqual([]);
  });

  it('does NOT fire on a trailing-slash home that names the same directory', () => {
    // The comparison has to be canonical, not textual: `join()` normalises the ledger's dirname
    // while the environment variable keeps whatever the user typed. A textual compare reads
    // "/x/home/" and "/x/home" as different places and hard-downs a correctly configured user.
    const { home } = layout();
    writeFileSync(join(home, 'ledger-mac-master.key'), randomBytes(32));
    expect(strayTrustFiles(home + sep, join(home, 'memory.jsonl'))).toEqual([]);
  });

  it('reports a master key sitting beside a relocated ledger', () => {
    const { home, elsewhere } = layout();
    writeFileSync(join(elsewhere, 'ledger-mac-master.key'), randomBytes(32));
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual(['ledger-mac-master.key']);
  });

  it('reports a witness and a registry only when they are shape-valid', () => {
    const { home, elsewhere } = layout();
    // `projects.json` and `witness.json` are generic enough names that a repo could hold unrelated
    // files by those names; only Helix-shaped content counts, or the fix refuses to start over
    // somebody else's data.
    writeFileSync(join(elsewhere, 'projects.json'), JSON.stringify({ some: 'unrelated tool config' }));
    writeFileSync(join(elsewhere, 'witness.json'), 'not json at all');
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual([]);

    writeFileSync(join(elsewhere, 'projects.json'), JSON.stringify({ '/a/project': { stamp: 'x', adoptedAt: '2026-01-01T00:00:00.000Z', macNonce: 'n' } }));
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual(['projects.json']);
  });

  it('reports every stray file it finds, in a stable order', () => {
    const { home, elsewhere } = layout();
    writeFileSync(join(elsewhere, 'witness-log.jsonl'), '{"v":1}\n');
    writeFileSync(join(elsewhere, 'ledger-mac-master.key'), randomBytes(32));
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl')))
      .toEqual(TRUST_FILE_NAMES.filter((n: string) => n === 'ledger-mac-master.key' || n === 'witness-log.jsonl'));
  });

  it('finds nothing beside a relocated ledger that has no trust state yet', () => {
    // A user who set HELIX_LEDGER on a FRESH install has nothing to migrate and must not be blocked.
    const { home, elsewhere } = layout();
    writeFileSync(join(elsewhere, 'memory.jsonl'), '');
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual([]);
  });
});
