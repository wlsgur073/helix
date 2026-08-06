import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
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

  // F1B-DETECTOR-DOS: the five predicates above are weak enough that a repo-writing adversary
  // (the same threat model F1 itself assumes — see docs/issues/repros/f1-detector-startup-dos.ts)
  // can plant a file that reads as "ours" and trigger the startup refusal. Each case below is the
  // planted artifact from that probe, translated 1:1.

  it('does not treat a one-byte ledger-mac-master.key as ours', () => {
    // The real key is exactly 32 bytes (ledger-mac.ts's MASTER_LEN); size > 0 alone lets one
    // arbitrary byte impersonate it.
    const { home, elsewhere } = layout();
    writeFileSync(join(elsewhere, 'ledger-mac-master.key'), 'x');
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual([]);
  });

  it('does not treat projects.json with non-string stamp/macNonce as ours', () => {
    // The real registry validator (ownership.ts) requires stamp/adoptedAt/macNonce to be strings;
    // a predicate that only checks key PRESENCE accepts a file the real reader would reject as corrupt.
    const { home, elsewhere } = layout();
    writeFileSync(join(elsewhere, 'projects.json'), JSON.stringify({ anything: { stamp: 1, macNonce: 1 } }));
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual([]);
  });

  it('does not treat witness.json {"scopes":1} as ours', () => {
    // `scopes` must be an object (a scope-keyed map) in the real witness store shape; a bare
    // property-presence check accepts any type at all, including a number.
    const { home, elsewhere } = layout();
    writeFileSync(join(elsewhere, 'witness.json'), JSON.stringify({ scopes: 1 }));
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual([]);
  });

  it('does not treat an empty witness-log.jsonl as ours', () => {
    const { home, elsewhere } = layout();
    writeFileSync(join(elsewhere, 'witness-log.jsonl'), '');
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual([]);
  });

  it('does not treat a symlinked projects.json as ours', () => {
    // existsSync/statSync/readFileSync all FOLLOW symlinks, so a planted link can point at
    // Helix-shaped content living anywhere on disk without the bytes ever touching the repo.
    const { home, elsewhere } = layout();
    const outside = join(home, '..', 'somewhere-else.json');
    writeFileSync(outside, JSON.stringify({ a: { stamp: 'x', adoptedAt: '2026-01-01T00:00:00.000Z', macNonce: 'y' } }));
    symlinkSync(outside, join(elsewhere, 'projects.json'));
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual([]);
  });

  // Reverse-direction lock: tightening the predicates must not blind the detector to the genuine
  // article, or the fix regresses F1 (the original defect this detector exists to catch). The other
  // four real file shapes are already exercised above; witness.json's genuine shape is the one gap.
  it('still reports a genuine witness.json (object scopes) beside a relocated ledger', () => {
    const { home, elsewhere } = layout();
    writeFileSync(join(elsewhere, 'witness.json'), JSON.stringify({ v: 1, scopes: {} }));
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual(['witness.json']);
  });
});
