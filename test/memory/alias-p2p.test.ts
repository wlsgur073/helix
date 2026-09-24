import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stampOwnership, projectLedgerPath, projectDispositionOf, aliasesAdoptedLedger } from '../../src/memory/ownership.js';

// ALIAS-P2P (item 7): an adopted project's ledger that resolves to ANOTHER adopted project's ledger
// file. The global rule (scope-target.ts aliasesGlobalLedger) compared against the global ledger
// only; hard links are refused at the write layer by link count and are not this rule's business.

const home = (): string => mkdtempSync(join(tmpdir(), 'helix-p2p-home-'));
const project = (h: string): string => { const r = mkdtempSync(join(tmpdir(), 'helix-p2p-proj-')); stampOwnership(r, h, {}); return r; };
const desc = (root: string, h: string) => ({ root, home: h, ledger: projectLedgerPath(root) });

describe('aliasesAdoptedLedger / the aliased disposition', () => {
  it('only the LINKING project is aliased; the project holding the real file stays owned', () => {
    const h = home(); const a = project(h); const b = project(h);
    writeFileSync(projectLedgerPath(b), '');
    symlinkSync(projectLedgerPath(b), projectLedgerPath(a));
    expect(aliasesAdoptedLedger(desc(a, h))).toBe(true);
    expect(projectDispositionOf(desc(a, h))).toBe('aliased');
    expect(aliasesAdoptedLedger(desc(b, h))).toBe(false);
    expect(projectDispositionOf(desc(b, h))).toBe('owned');
  });

  it('two projects that both resolve to a third file are both aliased', () => {
    const h = home(); const a = project(h); const b = project(h);
    const third = join(mkdtempSync(join(tmpdir(), 'helix-p2p-shared-')), 'shared.jsonl');
    writeFileSync(third, '');
    symlinkSync(third, projectLedgerPath(a));
    symlinkSync(third, projectLedgerPath(b));
    expect(projectDispositionOf(desc(a, h))).toBe('aliased');
    expect(projectDispositionOf(desc(b, h))).toBe('aliased');
  });

  it('a DANGLING link into another project\'s not-yet-created ledger path is aliased before the first write', () => {
    const h = home(); const a = project(h); const b = project(h);
    expect(existsSync(projectLedgerPath(b))).toBe(false);
    symlinkSync(projectLedgerPath(b), projectLedgerPath(a));
    expect(projectDispositionOf(desc(a, h))).toBe('aliased');
  });

  it('a registry entry whose project is gone never matches, and never throws', () => {
    // A's ledger is a link to a standalone file, so the registry loop really runs (a project holding
    // its own real file returns before the loop) and meets the gone project's key.
    const h = home(); const a = project(h); const gone = project(h);
    const standalone = join(mkdtempSync(join(tmpdir(), 'helix-p2p-solo-')), 'solo.jsonl');
    writeFileSync(standalone, '');
    symlinkSync(standalone, projectLedgerPath(a));
    rmSync(gone, { recursive: true, force: true });
    expect(projectDispositionOf(desc(a, h))).toBe('owned');
  });

  it('two adopted projects with their own regular files are both owned', () => {
    const h = home(); const a = project(h); const b = project(h);
    writeFileSync(projectLedgerPath(a), '');
    writeFileSync(projectLedgerPath(b), '');
    expect(projectDispositionOf(desc(a, h))).toBe('owned');
    expect(projectDispositionOf(desc(b, h))).toBe('owned');
  });

  it('an UNOWNED project is never aliased: its dispositions are unchanged', () => {
    const h = home(); const b = project(h);
    writeFileSync(projectLedgerPath(b), '');
    const stranger = mkdtempSync(join(tmpdir(), 'helix-p2p-proj-'));
    expect(projectDispositionOf(desc(stranger, h))).toBe('inactive');
  });
});
