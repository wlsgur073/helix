// ALIAS-DOTDOT and ALIAS-NONUTF8 (second fix batch, D4): lock identity, the append target, both alias
// rules and their comparison sides are computed the kernel's way; a path Helix cannot resolve that way
// is excluded like an alias, while registry and witness scope keys keep their pre-D4 computation. Link
// bodies holding `dl/..` are joined with '/' by hand: `path.join` would collapse `dl/..` before the
// link is ever planted.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, readdirSync, realpathSync, appendFileSync, lstatSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { stampOwnership, projectLedgerPath, projectDispositionOf, ledgerDestination, canonicalRoot, isOwned } from '../../src/memory/ownership.js';
import { aliasesGlobalLedger, resolveScopeTarget } from '../../src/memory/scope-target.js';
import { resolveProjectLayer } from '../../src/memory/project-root.js';
import { canonical, lockPathOf, withFileLock } from '../../src/memory/lock.js';
import { appendRecord, parseLedger } from '../../src/memory/ledger.js';
import { scopeKeyOf } from '../../src/memory/witness-store.js';
import type { MemoryRecord } from '../../src/types.js';

const home = (): string => mkdtempSync(join(tmpdir(), 'helix-d4-home-'));
const project = (h: string): string => { const r = mkdtempSync(join(tmpdir(), 'helix-d4-proj-')); stampOwnership(r, h, {}); return r; };
const desc = (root: string, h: string) => ({ root, home: h, ledger: projectLedgerPath(root) });
const storeFor = (h: string, root: string) =>
  new MemoryStore(join(h, 'memory.jsonl'), { home: h, sessionId: 's', project: { root, ledger: projectLedgerPath(root) } });
const rec = (id: string): MemoryRecord => ({
  id, tx: '2026-10-01T00:00:00.000Z', validFrom: '2026-10-01T00:00:00.000Z', validTo: null, type: 'assert', state: 'Fresh',
  content: `fact ${id}`, provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
});

/** `dir/dl -> dir/p/q` (two levels down), so the kernel's `dl/..` is `dir/p` while the textual reading is
 *  `dir` itself: the two readings name different directories. */
function plantDeepDirLink(dir: string): void {
  mkdirSync(join(dir, 'p', 'q'), { recursive: true });
  symlinkSync(join(dir, 'p', 'q'), join(dir, 'dl'));
}

describe('lock identity and the append target follow the kernel through `dl/..` (ALIAS-DOTDOT)', () => {
  it('a ledger link through `dl/..` and the physical file share ONE lock path', () => {
    const d = mkdtempSync(join(tmpdir(), 'helix-d4-lock-'));
    plantDeepDirLink(d);
    writeFileSync(join(d, 'p', 'real.jsonl'), '');     // the kernel's `dl/../real.jsonl`
    writeFileSync(join(d, 'real.jsonl'), '');          // a decoy where the textual reading lands
    const link = join(d, 'ledger.jsonl');
    symlinkSync('dl/../real.jsonl', link);
    expect(realpathSync.native(link)).toBe(join(realpathSync(d), 'p', 'real.jsonl'));
    expect(canonical(link)).toBe(canonical(join(d, 'p', 'real.jsonl')));
    expect(lockPathOf(link)).toBe(lockPathOf(join(d, 'p', 'real.jsonl')));
    withFileLock(link, () => {
      expect(existsSync(lockPathOf(join(d, 'p', 'real.jsonl')))).toBe(true);   // the lock landed at the KERNEL's path
      expect(existsSync(join(d, 'real.jsonl.lock'))).toBe(false);              // never beside the decoy
    });
  });

  it('an append through a `dl/..` link lands in the file the kernel opens, never the textual decoy', () => {
    const d = mkdtempSync(join(tmpdir(), 'helix-d4-append-'));
    plantDeepDirLink(d);
    writeFileSync(join(d, 'p', 'real.jsonl'), '');
    writeFileSync(join(d, 'real.jsonl'), '');
    const link = join(d, 'ledger.jsonl');
    symlinkSync('dl/../real.jsonl', link);
    appendRecord(link, rec('m_1'));
    expect(parseLedger(join(d, 'p', 'real.jsonl')).map((r) => r.id)).toEqual(['m_1']);
    expect(readFileSync(join(d, 'real.jsonl'), 'utf8')).toBe('');
    expect(parseLedger(link).map((r) => r.id)).toEqual(['m_1']);                // reads open the same file
  });
});

describe('the global rule compares where both appends land (ALIAS-DOTDOT)', () => {
  /** A project's ledger reaching the global ledger `<h>/memory.jsonl` through `A/.helix/dl -> A/x`:
   *  the kernel's `A/x/../..` is the shared tmp parent; the textual reading names `A/<home>/...`. */
  const plantDotdotToGlobal = (a: string, h: string): void => {
    mkdirSync(join(a, 'x'));
    symlinkSync(join(a, 'x'), join(a, '.helix', 'dl'));
    symlinkSync(['dl', '..', '..', basename(h), 'memory.jsonl'].join('/'), projectLedgerPath(a));
  };

  it.each([['EXISTING', true], ['ABSENT', false]] as const)('a `dl/..` link into the %s global ledger is the global ledger', (_l, existing) => {
    const h = home(); const a = mkdtempSync(join(tmpdir(), 'helix-d4-proj-'));
    mkdirSync(join(a, '.helix'));
    if (existing) writeFileSync(join(h, 'memory.jsonl'), '');
    plantDotdotToGlobal(a, h);
    expect(aliasesGlobalLedger(projectLedgerPath(a), join(h, 'memory.jsonl'))).toBe(true);
    expect(resolveProjectLayer({ cwd: a, userHome: '/nonexistent-home', globalLedger: join(h, 'memory.jsonl') })).toBeUndefined();
    expect(resolveScopeTarget(h, join(h, 'memory.jsonl'), a)).toMatchObject({ ok: false, reason: 'aliases-global' });
  });

  it('a plain DANGLING link into a global ledger that does not exist yet is the global ledger', () => {
    const h = home(); const a = mkdtempSync(join(tmpdir(), 'helix-d4-proj-'));
    mkdirSync(join(a, '.helix'));
    symlinkSync(join(h, 'memory.jsonl'), projectLedgerPath(a));
    expect(existsSync(join(h, 'memory.jsonl'))).toBe(false);
    expect(aliasesGlobalLedger(projectLedgerPath(a), join(h, 'memory.jsonl'))).toBe(true);
  });

  it('two ordinary files stay distinct', () => {
    const h = home(); const a = mkdtempSync(join(tmpdir(), 'helix-d4-proj-'));
    mkdirSync(join(a, '.helix'));
    writeFileSync(projectLedgerPath(a), '');
    expect(aliasesGlobalLedger(projectLedgerPath(a), join(h, 'memory.jsonl'))).toBe(false);
  });
});

describe('the project-to-project comparison side is read the kernel\'s way (ALIAS-DOTDOT, Q3)', () => {
  it.each([['ABSENT', false], ['EXISTING', true]] as const)(
    "B's own ledger reaches a %s third file through `dl/..` and A links to B's ledger: both are aliased",
    (_l, existing) => {
      const h = home(); const a = project(h); const b = project(h);
      plantDeepDirLink(join(b, '.helix'));                                   // B/.helix/dl -> B/.helix/p/q
      if (existing) writeFileSync(join(b, '.helix', 'p', 'third.jsonl'), '');
      symlinkSync('dl/../third.jsonl', projectLedgerPath(b));              // kernel: B/.helix/p/third.jsonl
      symlinkSync(projectLedgerPath(b), projectLedgerPath(a));
      expect(projectDispositionOf(desc(a, h))).toBe('aliased');
      expect(projectDispositionOf(desc(b, h))).toBe('aliased');
      expect(() => storeFor(h, a).commit({ content: 'a fact for A', source: 'user' })).toThrow(/resolves to another adopted project/);
      expect(() => storeFor(h, b).commit({ content: 'a fact for B', source: 'user' })).toThrow(/resolves to another adopted project/);
      expect(existsSync(join(b, '.helix', 'p', 'third.jsonl'))).toBe(existing);
    },
  );

  it('two projects linked to one third file that does not exist yet are both aliased before any write (Q3)', () => {
    const h = home(); const a = project(h); const b = project(h);
    const third = join(mkdtempSync(join(tmpdir(), 'helix-d4-third-')), 'shared.jsonl');
    symlinkSync(third, projectLedgerPath(a));
    symlinkSync(third, projectLedgerPath(b));
    expect(projectDispositionOf(desc(a, h))).toBe('aliased');
    expect(projectDispositionOf(desc(b, h))).toBe('aliased');
    expect(() => storeFor(h, a).commit({ content: 'a fact for A', source: 'user' })).toThrow(/resolves to another adopted project/);
    expect(existsSync(third)).toBe(false);
  });
});

describe('a path Helix cannot resolve the kernel\'s way is excluded like an alias (ALIAS-NONUTF8, ALIAS-DOTDOT)', () => {
  const ff = Buffer.from([0xff]);
  const inHelix = (root: string, name: Buffer): Buffer => Buffer.concat([Buffer.from(`${join(root, '.helix')}/`), name]);

  it.each([['EXISTING', true], ['ABSENT', false]] as const)(
    "U1: A's ledger -> <0xff> -> B's %s ledger is aliased; the commit is refused and B's file is untouched",
    (_l, existing) => {
      const h = home(); const a = project(h); const b = project(h);
      if (existing) writeFileSync(projectLedgerPath(b), '');
      symlinkSync(Buffer.from(`../../${basename(b)}/.helix/memory.jsonl`), inHelix(a, ff));
      symlinkSync(ff, projectLedgerPath(a));
      expect(ledgerDestination(projectLedgerPath(a))).toBeNull();
      expect(projectDispositionOf(desc(a, h))).toBe('aliased');
      expect(() => storeFor(h, a).commit({ content: 'a fact for A', source: 'user' })).toThrow(/resolves to another adopted project/);
      expect(existsSync(projectLedgerPath(b))).toBe(existing);
      if (existing) expect(readFileSync(projectLedgerPath(b), 'utf8')).toBe('');
      else expect(readdirSync(join(b, '.helix'))).toEqual(['.owner']);
    },
  );

  it("U3: a `dl/..` whose directory link is named <0xff> is aliased", () => {
    const h = home(); const a = project(h); const b = project(h);
    writeFileSync(projectLedgerPath(b), '');
    mkdirSync(join(a, 'x'));
    symlinkSync(join(a, 'x'), inHelix(a, ff));
    symlinkSync(Buffer.concat([ff, Buffer.from(`/../../${basename(b)}/.helix/memory.jsonl`)]), projectLedgerPath(a));
    expect(projectDispositionOf(desc(a, h))).toBe('aliased');
    // Non-vacuity: the kernel really follows this link into B's file.
    appendFileSync(projectLedgerPath(a), 'kernel marker\n');
    expect(readFileSync(projectLedgerPath(b), 'utf8')).toBe('kernel marker\n');
  });

  it('a realpath RESULT that is not valid UTF-8 (a directory named <0xff> behind a directory link) is unresolvable', () => {
    const h = home(); const a = project(h);
    mkdirSync(inHelix(a, Buffer.concat([ff, Buffer.from('dir')])));
    symlinkSync(Buffer.concat([ff, Buffer.from('dir')]), join(a, '.helix', 'dl'));
    symlinkSync('dl/mem.jsonl', projectLedgerPath(a));
    expect(ledgerDestination(projectLedgerPath(a))).toBeNull();
    expect(projectDispositionOf(desc(a, h))).toBe('aliased');
  });

  /** A real directory tree physically deeper than PATH_MAX inside A, built through a short directory
   *  link so no single path string passed to mkdir or symlink exceeds it. Returns the link body that
   *  climbs out of the tree into B's ledger. */
  function plantDeepClimb(a: string, b: string): string {
    const n = (i: number): string => `${String(i).padStart(3, '0')}${'d'.repeat(197)}`;
    const first = Array.from({ length: 10 }, (_, i) => n(i + 1));
    const second = Array.from({ length: 11 }, (_, i) => n(i + 11));
    mkdirSync(join(a, 'deep', ...first), { recursive: true });
    symlinkSync(join('..', 'deep', ...first), join(a, '.helix', 'dk'));             // A/.helix/dk -> A/deep/n1..n10
    mkdirSync(join(a, '.helix', 'dk', ...second), { recursive: true });             // physically A/deep/n1..n21
    symlinkSync(join(...second), join(a, '.helix', 'dk', 'dk2'));                   // n10/dk2 -> n11..n21
    return `dk/dk2/${'../'.repeat(23)}${basename(b)}/.helix/memory.jsonl`;          // n21 up 21 + A + parent
  }

  it.each([['EXISTING', true], ['ABSENT', false]] as const)(
    "a link that climbs out through a directory deeper than PATH_MAX into B's %s ledger is aliased and refused",
    (_l, existing) => {
      const h = home(); const a = project(h); const b = project(h);
      if (existing) writeFileSync(projectLedgerPath(b), '');
      symlinkSync(plantDeepClimb(a, b), projectLedgerPath(a));
      expect(() => realpathSync.native(join(a, '.helix', 'dk', 'dk2'))).toThrow(/ENAMETOOLONG/);
      expect(ledgerDestination(projectLedgerPath(a))).toBeNull();
      expect(projectDispositionOf(desc(a, h))).toBe('aliased');
      expect(() => storeFor(h, a).commit({ content: 'a fact for A', source: 'user' })).toThrow(/resolves to another adopted project/);
      expect(existsSync(projectLedgerPath(b))).toBe(existing);
      // Non-vacuity: the kernel resolves the same link into B's ledger.
      appendFileSync(projectLedgerPath(a), 'kernel marker\n');
      expect(readFileSync(projectLedgerPath(b), 'utf8')).toBe('kernel marker\n');
    },
  );

  it.each([['EXISTING', true], ['ABSENT', false]] as const)(
    "a hop whose directory resolves while the hop's own path is past PATH_MAX, into B's %s ledger, is aliased and refused",
    (_l, existing) => {
      const h = home(); const a = project(h); const b = project(h);
      if (existing) writeFileSync(projectLedgerPath(b), '');
      // A real directory 4000 characters deep (below PATH_MAX, so realpath answers it) holding a
      // 200-character link to B's ledger: the directory plus the link's name is 4201 characters.
      const base = join(realpathSync.native(a), 'deep');
      const names: string[] = [];
      for (let rem = 4000 - base.length; rem > 0;) {
        const len = rem >= 206 ? 200 : rem - 1;
        names.push(`${String(names.length + 1).padStart(3, '0')}${'d'.repeat(len - 3)}`);
        rem -= len + 1;
      }
      const deep = join(base, ...names);
      const hop = `hop${'h'.repeat(197)}`;
      mkdirSync(deep, { recursive: true });
      symlinkSync(deep, join(a, '.helix', 'dk'));                         // A/.helix/dk -> the deep directory
      symlinkSync(projectLedgerPath(b), join(a, '.helix', 'dk', hop));    // planted through the short link
      symlinkSync(`dk/${hop}`, projectLedgerPath(a));
      expect(realpathSync.native(join(a, '.helix', 'dk'))).toBe(deep);    // the hop's directory resolves
      expect(() => lstatSync(join(deep, hop))).toThrow(/ENAMETOOLONG/);   // the hop's own path does not
      expect(ledgerDestination(projectLedgerPath(a))).toBeNull();
      expect(projectDispositionOf(desc(a, h))).toBe('aliased');
      expect(() => storeFor(h, a).commit({ content: 'a fact for A', source: 'user' })).toThrow(/through a path Helix cannot resolve/);
      expect(existsSync(projectLedgerPath(b))).toBe(existing);
      // Non-vacuity: the kernel resolves the same chain into B's ledger.
      appendFileSync(projectLedgerPath(a), 'kernel marker\n');
      expect(readFileSync(projectLedgerPath(b), 'utf8')).toBe('kernel marker\n');
    },
  );

  it("a project whose root lies behind a directory named <0xff>: no ledger yet is unresolvable, and a relative link into B's ledger is aliased and refused", () => {
    const h = home(); const b = project(h);
    writeFileSync(projectLedgerPath(b), '');
    const outer = mkdtempSync(join(tmpdir(), 'helix-d4-outer-'));
    const ffDir = Buffer.concat([ff, Buffer.from('dir')]);
    mkdirSync(Buffer.concat([Buffer.from(`${outer}/`), ffDir]));
    symlinkSync(ffDir, join(outer, 'link'));                                             // <outer>/link -> <0xff>dir
    const a = join(outer, 'link', 'proj');                                               // A's root, spelled through the link
    mkdirSync(a);
    stampOwnership(a, h, {});
    expect(isOwned(a, h)).toBe(true);                                                    // A/.helix is a real directory
    expect(ledgerDestination(projectLedgerPath(a))).toBeNull();                          // no ledger yet: its parent is not valid UTF-8
    symlinkSync(`../../../../${basename(b)}/.helix/memory.jsonl`, projectLedgerPath(a)); // resolved from A's PHYSICAL .helix
    expect(ledgerDestination(projectLedgerPath(a))).toBeNull();
    expect(projectDispositionOf(desc(a, h))).toBe('aliased');
    expect(() => storeFor(h, a).commit({ content: 'a fact for A', source: 'user' })).toThrow(/through a path Helix cannot resolve/);
    expect(readFileSync(projectLedgerPath(b), 'utf8')).toBe('');
    // Non-vacuity: the kernel follows the link into B's file.
    appendFileSync(projectLedgerPath(a), 'kernel marker\n');
    expect(readFileSync(projectLedgerPath(b), 'utf8')).toBe('kernel marker\n');
  });

  it('an unresolvable REGISTERED project is skipped as a comparison side, not matched', () => {
    const h = home(); const a = project(h); const b = project(h);
    const standalone = join(mkdtempSync(join(tmpdir(), 'helix-d4-solo-')), 'solo.jsonl');
    writeFileSync(standalone, '');
    symlinkSync(standalone, projectLedgerPath(a));                 // A links to its own standalone file
    symlinkSync(Buffer.from([0xff]), projectLedgerPath(b));         // B is unresolvable
    expect(projectDispositionOf(desc(b, h))).toBe('aliased');
    expect(projectDispositionOf(desc(a, h))).toBe('owned');
  });

  // Fail closed: an UNRESOLVABLE project ledger is not "the global ledger" either. Were it,
  // resolveProjectLayer would drop the layer and an omitted-scope commit would land in the GLOBAL
  // ledger; instead the layer stays configured, reads aliased, and the commit is refused. Only the
  // refusal's cause clause is matched here (the R7/P1 block below pins the whole text).
  it('an unresolvable project ledger keeps the layer configured, reads aliased, and its omitted-scope commit is refused (never routed to the global ledger)', () => {
    const h = home(); const a = project(h);
    const globalLedger = join(h, 'memory.jsonl');
    symlinkSync(ff, projectLedgerPath(a));                         // a link whose body is not valid UTF-8
    expect(ledgerDestination(projectLedgerPath(a))).toBeNull();
    expect(aliasesGlobalLedger(projectLedgerPath(a), globalLedger)).toBe(false);
    expect(resolveProjectLayer({ cwd: a, userHome: '/nonexistent-home', globalLedger })).toMatchObject({ root: a, ledger: projectLedgerPath(a) });
    expect(projectDispositionOf(desc(a, h))).toBe('aliased');
    expect(() => storeFor(h, a).commit({ content: 'a fact for A', source: 'user' })).toThrow(/through a path Helix cannot resolve/);
    expect(existsSync(globalLedger)).toBe(false);                  // nothing was widened to the global ledger
  });
});

describe('registry and witness scope keys keep the pre-D4 computation', () => {
  it('canonicalRoot stays Node JS realpath (a `dl/..` spelling keeps its old key), while canonical is the kernel\'s', () => {
    const d = mkdtempSync(join(tmpdir(), 'helix-d4-key-'));
    plantDeepDirLink(d);
    mkdirSync(join(d, 'proj'));
    mkdirSync(join(d, 'p', 'proj'));
    const spelled = `${d}/dl/../proj`;                                   // kernel: d/p/proj; JS: d/proj
    expect(canonicalRoot(spelled)).toBe(realpathSync(spelled));
    expect(canonicalRoot(spelled)).toBe(join(realpathSync(d), 'proj'));
    expect(canonical(spelled)).toBe(join(realpathSync(d), 'p', 'proj'));
    expect(scopeKeyOf('/unused-home', spelled)).toBe(canonicalRoot(spelled));
  });

  it('a registry written with the pre-D4 key by hand still reads the project as owned', () => {
    const h = home();
    const real = mkdtempSync(join(tmpdir(), 'helix-d4-reg-'));
    const linkedParent = join(mkdtempSync(join(tmpdir(), 'helix-d4-reglink-')), 'parent');
    symlinkSync(real, linkedParent);
    mkdirSync(join(real, 'proj', '.helix'), { recursive: true });
    const root = join(linkedParent, 'proj');                            // spelled THROUGH the linked parent
    const oldKey = realpathSync(root);                                  // the JS realpath key a pre-D4 build wrote
    writeFileSync(join(h, 'projects.json'), JSON.stringify({ [oldKey]: { stamp: 'stamp-1', adoptedAt: '2026-09-30T00:00:00.000Z', macNonce: 'nonce-1' } }), { mode: 0o600 });
    writeFileSync(join(real, 'proj', '.helix', '.owner'), 'stamp-1', { mode: 0o600 });
    expect(isOwned(root, h)).toBe(true);
    expect(storeFor(h, root).currentView().projectDisposition).toBe('owned');
    const out = storeFor(h, root).commitScoped({ content: 'a fact after the upgrade', source: 'user' });
    expect(out.scope).toBe('project');
    expect(statSync(join(real, 'proj', '.helix', 'memory.jsonl')).size).toBeGreaterThan(0);
  });
});

// Review Focus: the kernel reading must not turn a legitimate link inside the project's own tree into an
// alias — the project stays owned and writable, and the append and the lock name the file the kernel
// opens.
describe("a link inside the project's own tree is the project's own file", () => {
  it("a link inside the project's own tree through `dl/..` stays owned; the commit lands in the kernel's file under one lock", () => {
    const h = home(); const a = project(h);
    plantDeepDirLink(join(a, '.helix'));                                   // A/.helix/dl -> A/.helix/p/q
    writeFileSync(join(a, '.helix', 'p', 'mine.jsonl'), '');              // the kernel's `dl/../mine.jsonl`
    symlinkSync('dl/../mine.jsonl', projectLedgerPath(a));
    expect(projectDispositionOf(desc(a, h))).toBe('owned');
    expect(storeFor(h, a).commitScoped({ content: 'a fact for A', source: 'user' }).scope).toBe('project');
    expect(readFileSync(join(a, '.helix', 'p', 'mine.jsonl'), 'utf8')).toContain('a fact for A');
    expect(existsSync(join(a, '.helix', 'mine.jsonl'))).toBe(false);      // never the textual reading
    expect(lockPathOf(projectLedgerPath(a))).toBe(`${join(realpathSync(a), '.helix', 'p', 'mine.jsonl')}.lock`);
  });
});

// Ruling R7 with plan refinement P1 (second fix batch §4.4 item 5): one constant carries every alias
// write refusal, and its first sentence names every cause — another adopted project's memory file, the
// global memory file, or a path Helix cannot resolve the kernel's way (a non-UTF-8 name, a path past
// PATH_MAX, too many links). The erase-side refusal (an explicit `scope: 'project'` erase, reachable
// from the library only) names the same three.
describe('the alias refusals name every cause (R7, P1)', () => {
  const ALIAS_REFUSAL =
    "commit: this project's memory file resolves to another adopted project's memory file, to the global memory file, " +
    'or through a path Helix cannot resolve, so the project layer is disabled here — the write is refused rather than ' +
    "written into the other project's memory. Ask the user whether to store this fact in global memory, which every " +
    "project sees, or to replace the link with the project's own file; do not choose for them.";
  const ERASE_ALIAS_REFUSAL =
    "erase: this project's memory file resolves to another adopted project's memory file, to the global memory file, " +
    "or through a path Helix cannot resolve — the erase is refused rather than applied to the other project's memory.";
  const refusalOf = (f: () => unknown): string => {
    try { f(); } catch (e) { return (e as Error).message; }
    return '<no refusal>';
  };

  it("an owned project whose ledger leads to another adopted project's file: the exact text, omitted and explicit project scope", () => {
    const h = home(); const a = project(h); const b = project(h);
    symlinkSync(projectLedgerPath(b), projectLedgerPath(a));
    expect(refusalOf(() => storeFor(h, a).commit({ content: 'a fact for A', source: 'user' }))).toBe(ALIAS_REFUSAL);
    expect(refusalOf(() => storeFor(h, a).commit({ content: 'a fact for A', source: 'user', scope: 'project' }))).toBe(ALIAS_REFUSAL);
  });

  it('an owned project whose ledger is unresolvable (a non-UTF-8 link body): the same text', () => {
    const h = home(); const a = project(h);
    symlinkSync(Buffer.from([0xff]), projectLedgerPath(a));
    expect(refusalOf(() => storeFor(h, a).commit({ content: 'a fact for A', source: 'user' }))).toBe(ALIAS_REFUSAL);
  });

  it("the erase-side refusal names the same causes", () => {
    const h = home(); const a = project(h); const b = project(h);
    symlinkSync(projectLedgerPath(b), projectLedgerPath(a));
    expect(refusalOf(() => storeFor(h, a).erase('m_any', { scope: 'project' }))).toBe(ERASE_ALIAS_REFUSAL);
  });
});
