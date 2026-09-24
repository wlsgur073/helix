import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { stampOwnership, projectLedgerPath, projectDispositionOf, aliasesAdoptedLedger } from '../../src/memory/ownership.js';
import { resolveScopeTarget } from '../../src/memory/scope-target.js';

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

// Final review I-1 (ruling R24): the WHOLE symlink chain is followed by hand, bounded, not one link.
// Expected values from the final review's probe B (cases 3, 4, 5, 6, 8) plus the loop R24 names.
describe('aliasesAdoptedLedger follows the whole symlink chain (item 7, final review I-1)', () => {
  it('a two-hop DANGLING chain inside the linking project is aliased before the first write', () => {
    // A/.helix/memory.jsonl -> A/.helix/hop -> B/.helix/memory.jsonl (absent): both links live in A.
    const h = home(); const a = project(h); const b = project(h);
    const hop = join(a, '.helix', 'hop');
    symlinkSync(projectLedgerPath(b), hop);
    symlinkSync(hop, projectLedgerPath(a));
    expect(existsSync(projectLedgerPath(b))).toBe(false);
    expect(aliasesAdoptedLedger(desc(a, h))).toBe(true);
    expect(projectDispositionOf(desc(a, h))).toBe('aliased');
  });

  it("a two-hop chain to the other project's EXISTING ledger is aliased", () => {
    const h = home(); const a = project(h); const b = project(h);
    writeFileSync(projectLedgerPath(b), '');
    const hop = join(a, '.helix', 'hop');
    symlinkSync(projectLedgerPath(b), hop);
    symlinkSync(hop, projectLedgerPath(a));
    expect(projectDispositionOf(desc(a, h))).toBe('aliased');
    expect(projectDispositionOf(desc(b, h))).toBe('owned');
  });

  it('a RELATIVE link target is aliased', () => {
    // Both roots are mkdtemp siblings, so `../../<B>` from A's `.helix` names B's root.
    const h = home(); const a = project(h); const b = project(h);
    writeFileSync(projectLedgerPath(b), '');
    symlinkSync(join('..', '..', basename(b), '.helix', 'memory.jsonl'), projectLedgerPath(a));
    expect(projectDispositionOf(desc(a, h))).toBe('aliased');
  });

  it("a DANGLING link whose target path crosses a symlinked ancestor of the other project is aliased", () => {
    const h = home(); const a = project(h); const b = project(h);
    const viaLink = join(mkdtempSync(join(tmpdir(), 'helix-p2p-via-')), 'via');
    symlinkSync(dirname(b), viaLink);               // viaLink -> the directory holding B's root
    symlinkSync(join(viaLink, basename(b), '.helix', 'memory.jsonl'), projectLedgerPath(a));
    expect(existsSync(projectLedgerPath(b))).toBe(false);
    expect(projectDispositionOf(desc(a, h))).toBe('aliased');
  });

  it('a project root reached through a symlinked ANCESTOR directory, holding its own regular ledger, stays owned', () => {
    const h = home(); const b = project(h);
    writeFileSync(projectLedgerPath(b), '');
    const realParent = mkdtempSync(join(tmpdir(), 'helix-p2p-anc-'));
    mkdirSync(join(realParent, 'proj'));
    const linkedParent = join(mkdtempSync(join(tmpdir(), 'helix-p2p-anclink-')), 'parent');
    symlinkSync(realParent, linkedParent);
    const a = join(linkedParent, 'proj');           // A's root spelled THROUGH the linked ancestor
    stampOwnership(a, h, {});
    writeFileSync(projectLedgerPath(a), '');
    expect(aliasesAdoptedLedger(desc(a, h))).toBe(false);
    expect(projectDispositionOf(desc(a, h))).toBe('owned');
  });

  it('a symlink LOOP ends the walk without throwing and reports no alias', () => {
    const h = home(); const a = project(h); const b = project(h);
    writeFileSync(projectLedgerPath(b), '');
    const x = join(a, '.helix', 'x');
    symlinkSync(x, projectLedgerPath(a));
    symlinkSync(projectLedgerPath(a), x);
    expect(() => aliasesAdoptedLedger(desc(a, h))).not.toThrow();
    expect(aliasesAdoptedLedger(desc(a, h))).toBe(false);
    expect(projectDispositionOf(desc(a, h))).toBe('owned');
  });

  // A relative target is resolved from the link's PHYSICAL directory, as the kernel resolves it. Here
  // the second link sits in a directory reached through a directory link (`A/.helix/dl -> A/x/y/z`),
  // and its relative target climbs out of it: the kernel's `../../../..` from `A/x/y/z` is the
  // roots' shared parent, so an append through A's ledger lands in B's file (measured 2026-09-24).
  // Resolved from the textual `A/.helix/dl` instead, the same climb goes one level too high and
  // names nothing — which also missed the EXISTING-file case that realpath alone catches.
  it.each([['EXISTING', true], ['DANGLING', false]])(
    'a relative hop that climbs out of a directory link is followed from its physical directory (%s target)',
    (_label, existing) => {
      const h = home(); const a = project(h); const b = project(h);
      if (existing) writeFileSync(projectLedgerPath(b), '');
      mkdirSync(join(a, 'x', 'y', 'z'), { recursive: true });
      symlinkSync(join(a, 'x', 'y', 'z'), join(a, '.helix', 'dl'));
      symlinkSync(join('..', '..', '..', '..', basename(b), '.helix', 'memory.jsonl'), join(a, 'x', 'y', 'z', 'hop'));
      symlinkSync(join(a, '.helix', 'dl', 'hop'), projectLedgerPath(a));
      expect(projectDispositionOf(desc(a, h))).toBe('aliased');
    },
  );
});

describe('resolveScopeTarget refuses an aliased project scope (item 7)', () => {
  it('reports aliases-project for the linking side and resolves the real side', () => {
    const h = home(); const a = project(h); const b = project(h);
    writeFileSync(projectLedgerPath(b), '');
    symlinkSync(projectLedgerPath(b), projectLedgerPath(a));
    const globalLedger = join(h, 'memory.jsonl');
    expect(resolveScopeTarget(h, globalLedger, a)).toMatchObject({ ok: false, reason: 'aliases-project' });
    expect(resolveScopeTarget(h, globalLedger, b)).toMatchObject({ ok: true });
  });
});
