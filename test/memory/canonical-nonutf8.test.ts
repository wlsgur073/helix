// A link whose kernel destination is not valid UTF-8 is unresolvable (third fix batch B1, design 4.1): the resolver
// answers no path, so the lock, the append and the rewrite refuse it with UnresolvablePathError and nothing appears
// under a decoded name. Names are planted and listed as Buffers.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { lockPathOf, withFileLock } from '../../src/memory/lock.js';
import { resolvedPathOrThrow, isUnresolvablePathError } from '../../src/memory/path-identity.js';
import { appendRecord } from '../../src/memory/ledger.js';
import { isGlobalLedgerReadOnlyError, GLOBAL_WRITE_REFUSAL } from '../../src/memory/global-ledger.js';
import type { MemoryRecord } from '../../src/types.js';

const ff = Buffer.from([0xff]);
const ffName = Buffer.concat([Buffer.from('re'), ff, Buffer.from('l.jsonl')]);
const replacement = String.fromCharCode(0xfffd);
const rec = (id: string): MemoryRecord => ({
  id, tx: '2026-10-01T00:00:00.000Z', validFrom: '2026-10-01T00:00:00.000Z', validTo: null, type: 'assert', state: 'Fresh',
  content: `fact ${id}`, provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
});
const thrownBy = (f: () => unknown): unknown => { try { f(); } catch (e) { return e; } return undefined; };
/** A directory's entries as latin1 strings, so a name holding 0xff and one holding U+FFFD's three bytes differ. */
const names = (dir: string): string[] => readdirSync(dir, { encoding: 'buffer' }).map((b) => b.toString('latin1')).sort();

/** `target/re<0xff>l.jsonl` (empty) and `home/memory.jsonl`, a link to it, both under one temp directory. */
function plantLinkToFfName(): { d: string; link: string; target: Buffer; targetDir: string } {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'helix-ffname-')));
  const targetDir = join(d, 'target');
  mkdirSync(targetDir);
  mkdirSync(join(d, 'home'));
  const target = Buffer.concat([Buffer.from(`${targetDir}/`), ffName]);
  writeFileSync(target, '');
  const link = join(d, 'home', 'memory.jsonl');
  symlinkSync(target, link);
  return { d, link, target, targetDir };
}

describe('a link whose kernel destination is not valid UTF-8 is unresolvable: nothing is locked, written or created (D3, F-2 retired)', () => {
  it('resolvedPathOrThrow and lockPathOf throw UnresolvablePathError for it, never a decoded name', () => {
    const { link } = plantLinkToFfName();
    for (const call of [() => resolvedPathOrThrow(link), () => lockPathOf(link)]) {
      const e = thrownBy(call);
      expect(isUnresolvablePathError(e)).toBe(true);
      expect((e as Error).message).not.toContain(replacement);
    }
  });

  it('an append through the link is refused; the planted file stays empty and no file appears beside it', () => {
    const { link, target, targetDir } = plantLinkToFfName();
    expect(isUnresolvablePathError(thrownBy(() => appendRecord(link, rec('m_1'))))).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('');
    expect(names(targetDir)).toEqual([ffName.toString('latin1')]);        // nothing under a decoded name
  });

  it('no lock is published for the link', () => {
    const { d, link, targetDir } = plantLinkToFfName();
    expect(isUnresolvablePathError(thrownBy(() => withFileLock(link, () => undefined)))).toBe(true);
    expect(readdirSync(join(d, 'home')).filter((n) => n.endsWith('.lock'))).toEqual([]);
    expect(names(targetDir)).toEqual([ffName.toString('latin1')]);
  });

  it('a global ledger linked to such a file: a commit is refused and nothing is written', () => {
    const { d, link, target, targetDir } = plantLinkToFfName();
    const s = new MemoryStore(link, { home: join(d, 'home'), sessionId: 's' });
    const e = thrownBy(() => s.commit({ content: 'alpha deploy fact', source: 'user' }));
    expect(isGlobalLedgerReadOnlyError(e)).toBe(true);
    expect((e as Error).message).toBe(GLOBAL_WRITE_REFUSAL.commit);
    expect(readFileSync(target, 'utf8')).toBe('');
    expect(names(targetDir)).toEqual([ffName.toString('latin1')]);
    expect(readdirSync(join(d, 'home')).filter((n) => n.endsWith('.lock'))).toEqual([]);
  });

  it('a link through a DIRECTORY named <0xff>: unresolvable too, and the append is refused', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'helix-ffdir-')));
    const ffDir = Buffer.concat([Buffer.from(`${d}/`), ff, Buffer.from('dir')]);
    mkdirSync(ffDir);
    const target = Buffer.concat([ffDir, Buffer.from('/real.jsonl')]);
    writeFileSync(target, '');
    const link = join(d, 'ledger.jsonl');
    symlinkSync(target, link);
    expect(isUnresolvablePathError(thrownBy(() => resolvedPathOrThrow(link)))).toBe(true);
    expect(isUnresolvablePathError(thrownBy(() => appendRecord(link, rec('m_1'))))).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('');
  });

  it('control: a destination with a valid multi-byte UTF-8 name still resolves to the file it reaches', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'helix-utf8name-')));
    const target = Buffer.concat([Buffer.from(`${d}/`), Buffer.from([0xea, 0xb8, 0xb0]), Buffer.from('.jsonl')]);   // one three-byte character
    writeFileSync(target, '');
    const link = join(d, 'ledger.jsonl');
    symlinkSync(target, link);
    expect(resolvedPathOrThrow(link)).toBe(target.toString('utf8'));
    expect(lockPathOf(link)).toBe(`${target.toString('utf8')}.lock`);
  });

  it('a DANGLING link to a <0xff> name is unresolvable as well: nothing is created', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'helix-ffdangling-')));
    mkdirSync(join(d, 'target'));
    const target = Buffer.concat([Buffer.from(`${join(d, 'target')}/`), ffName]);
    const link = join(d, 'ledger.jsonl');
    symlinkSync(target, link);
    expect(isUnresolvablePathError(thrownBy(() => resolvedPathOrThrow(link)))).toBe(true);
    expect(isUnresolvablePathError(thrownBy(() => appendRecord(link, rec('m_1'))))).toBe(true);
    expect(names(join(d, 'target'))).toEqual([]);
  });
});
