// ALIAS-DOTDOT (second fix batch, D4), the identity half: lock identity and the append target are the
// file the kernel opens, while registry and witness scope keys keep their pre-D4 computation. Link
// bodies holding `dl/..` are joined with '/' by hand: `path.join` would collapse `dl/..` before the
// link is ever planted.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { projectLedgerPath, canonicalRoot, isOwned } from '../../src/memory/ownership.js';
import { canonical, lockPathOf, withFileLock } from '../../src/memory/lock.js';
import { appendRecord, parseLedger } from '../../src/memory/ledger.js';
import { scopeKeyOf } from '../../src/memory/witness-store.js';
import type { MemoryRecord } from '../../src/types.js';

const home = (): string => mkdtempSync(join(tmpdir(), 'helix-d4-home-'));
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
