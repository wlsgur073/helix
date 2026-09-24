import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, realpathSync, appendFileSync, readFileSync } from 'node:fs';
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

  // MAX_SYMLINK_HOPS is Linux's MAXSYMLINKS (40). Each case also takes the kernel's own answer for the
  // same chain, so the boundary is pinned against the kernel rather than against the constant.
  it.each([
    [40, 'EXISTING', 'aliased'], [40, 'ABSENT', 'aliased'], [41, 'EXISTING', 'owned'], [41, 'ABSENT', 'owned'],
  ] as const)("a chain of %i links into the other project's %s ledger reads %s", (n, bLedger, expected) => {
    const h = home(); const a = project(h); const b = project(h);
    if (bLedger === 'EXISTING') writeFileSync(projectLedgerPath(b), '');
    // A's ledger (link 1) -> A/.helix/c2 -> ... -> A/.helix/c<n> -> B's ledger: n links in all.
    const c = (i: number): string => join(a, '.helix', `c${i}`);
    for (let i = 2; i <= n; i++) symlinkSync(i === n ? projectLedgerPath(b) : c(i + 1), c(i));
    symlinkSync(c(2), projectLedgerPath(a));
    expect(projectDispositionOf(desc(a, h))).toBe(expected);
    if (n === 40) {                                  // the kernel follows 40 links and appends into B
      appendFileSync(projectLedgerPath(a), 'kernel marker\n');
      expect(readFileSync(projectLedgerPath(b), 'utf8')).toBe('kernel marker\n');
    } else {                                         // and refuses a 41st
      expect(() => appendFileSync(projectLedgerPath(a), 'kernel marker\n')).toThrow(/ELOOP/);
    }
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

// Ruling R27 (owner, 2026-09-24): a `..` that FOLLOWS a symlinked directory. With `A/.helix/dl -> A/x`,
// the kernel reads `A/.helix/dl/../../<B>` as `A/x/../../<B>`: it follows `dl` first, applies `..` to
// the physical target and lands in B's ledger. `path.resolve` and Node's JS `realpathSync` collapse
// `dl/..` as text and name `A/<B>/...`, which does not exist, so the link read as A's own file and the
// first commit landed in (or created) B's ledger. Link targets here are joined with '/' by hand:
// `path.join` would collapse `dl/..` itself before the link is ever planted.
describe("a '..' after a symlinked directory is resolved the kernel's way (item 7, ruling R27)", () => {
  /** `A/.helix/dl -> A/x`, and A's ledger -> `dl/../../<B>/.helix/memory.jsonl`, spelled relative to
   *  A's `.helix` or as the same path from A's root (absolute). The roots are mkdtemp siblings. */
  const plantDotdotLink = (a: string, b: string, spelling: 'relative' | 'absolute'): void => {
    mkdirSync(join(a, 'x'));
    symlinkSync(join(a, 'x'), join(a, '.helix', 'dl'));
    const rel = ['dl', '..', '..', basename(b), '.helix', 'memory.jsonl'].join('/');
    symlinkSync(spelling === 'relative' ? rel : `${join(a, '.helix')}/${rel}`, projectLedgerPath(a));
  };

  it.each([
    ['relative', 'EXISTING'], ['relative', 'ABSENT'], ['absolute', 'EXISTING'], ['absolute', 'ABSENT'],
  ] as const)("A's %s link through `dl/..` into the other project's %s ledger is aliased", (spelling, bLedger) => {
    const h = home(); const a = project(h); const b = project(h);
    if (bLedger === 'EXISTING') writeFileSync(projectLedgerPath(b), '');
    plantDotdotLink(a, b, spelling);
    expect(projectDispositionOf(desc(a, h))).toBe('aliased');
    expect(resolveScopeTarget(h, join(h, 'memory.jsonl'), a)).toMatchObject({ ok: false, reason: 'aliases-project' });
    expect(projectDispositionOf(desc(b, h))).toBe('owned');
  });

  it.each([['EXISTING', true], ['ABSENT', false]])(
    "a second link reached through `dl/..` (`dl/../sub/hop2`) into the other project's %s ledger is aliased",
    (_label, existing) => {
      const h = home(); const a = project(h); const b = project(h);
      if (existing) writeFileSync(projectLedgerPath(b), '');
      mkdirSync(join(a, 'x'));
      mkdirSync(join(a, 'sub'));
      symlinkSync(join(a, 'x'), join(a, '.helix', 'dl'));                                     // A/.helix/dl -> A/x
      symlinkSync(join('..', '..', basename(b), '.helix', 'memory.jsonl'), join(a, 'sub', 'hop2'));
      symlinkSync('dl/../sub/hop2', projectLedgerPath(a));             // kernel: A/x/.. is A, so A/sub/hop2
      expect(projectDispositionOf(desc(a, h))).toBe('aliased');
    },
  );
});

// Ruling R28 (2026-09-24): each hop's directory part is resolved physically, leaving only the final
// name for lstat. The hop used to be ONE string, the link's physical directory plus `/` plus the link
// body: a body padded with `./` (a no-op for the kernel) past PATH_MAX made `lstatSync` throw
// ENAMETOOLONG on that string, the walk fell back to canonicalRoot(ledger) and a dangling chain read as
// A's own file, while the kernel, which resolves a link body from the link's directory without
// building such a string, appended into B (measured on the R27 commit: with B's ledger absent, one
// padded link read `owned` and A's first commit created B's ledger).
describe("a link body padded past PATH_MAX is still followed the kernel's way (item 7, ruling R28)", () => {
  /** `./` padding up to 4089-4090 chars: under symlink()'s 4095-byte limit for the body, while the
   *  link's physical directory plus `/` plus the body is past PATH_MAX (4095). */
  const padded = (tail: string): string => './'.repeat(Math.floor((4090 - tail.length) / 2)) + tail;

  it.each([
    ['a plain relative', 'ABSENT'], ['a plain relative', 'EXISTING'], ['the `dl/..`', 'ABSENT'], ['the `dl/..`', 'EXISTING'],
  ] as const)("%s target padded past PATH_MAX into the other project's %s ledger is aliased", (shape, bLedger) => {
    const h = home(); const a = project(h); const b = project(h);
    if (bLedger === 'EXISTING') writeFileSync(projectLedgerPath(b), '');
    let tail = join('..', '..', basename(b), '.helix', 'memory.jsonl');
    if (shape === 'the `dl/..`') {
      mkdirSync(join(a, 'x'));
      symlinkSync(join(a, 'x'), join(a, '.helix', 'dl'));           // A/.helix/dl -> A/x
      tail = `dl/${tail}`;                                           // joined by hand: path.join collapses dl/..
    }
    const body = padded(tail);
    expect(realpathSync(join(a, '.helix')).length + 1 + body.length).toBeGreaterThan(4095);
    symlinkSync(body, projectLedgerPath(a));
    expect(projectDispositionOf(desc(a, h))).toBe('aliased');
  });
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
