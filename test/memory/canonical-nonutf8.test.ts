// A link whose kernel destination is not valid UTF-8: `canonical` reads realpath's answer as a Buffer and
// keeps the link's own location when the bytes do not survive a UTF-8 round trip, so every open follows
// the link instead of creating a file under the decoded name. Names are planted and listed as Buffers.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { canonical, lockPathOf, withFileLock } from '../../src/memory/lock.js';
import { appendRecord, parseLedger } from '../../src/memory/ledger.js';
import type { MemoryRecord } from '../../src/types.js';

const ff = Buffer.from([0xff]);
const ffName = Buffer.concat([Buffer.from('re'), ff, Buffer.from('l.jsonl')]);
const replacement = String.fromCharCode(0xfffd);
const rec = (id: string): MemoryRecord => ({
  id, tx: '2026-10-01T00:00:00.000Z', validFrom: '2026-10-01T00:00:00.000Z', validTo: null, type: 'assert', state: 'Fresh',
  content: `fact ${id}`, provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
});
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

describe("a link whose kernel destination is not valid UTF-8 keeps the link's own location", () => {
  it('canonical and lockPathOf name the link, never a decoded name', () => {
    const { link } = plantLinkToFfName();
    expect(canonical(link)).toBe(link);
    expect(canonical(link)).not.toContain(replacement);
    expect(lockPathOf(link)).toBe(`${link}.lock`);
  });

  it('an append through the link lands in the planted file, and no file appears beside it', () => {
    const { link, target, targetDir } = plantLinkToFfName();
    appendRecord(link, rec('m_1'));
    expect(parseLedger(link).map((r) => r.id)).toEqual(['m_1']);          // reads follow the link
    expect(readFileSync(target, 'utf8')).toContain('"m_1"');              // the kernel's file holds the row
    expect(names(targetDir)).toEqual([ffName.toString('latin1')]);        // nothing under a decoded name
  });

  it('the lock taken through the link lives beside the link', () => {
    const { link, targetDir } = plantLinkToFfName();
    withFileLock(link, () => {
      expect(lstatSync(`${link}.lock`).isFile()).toBe(true);
      expect(names(targetDir)).toEqual([ffName.toString('latin1')]);
    });
  });

  it('a global ledger linked to such a file: commits land in it and are read back', () => {
    const { d, link, target, targetDir } = plantLinkToFfName();
    const s = new MemoryStore(link, { home: join(d, 'home'), sessionId: 's' });
    const a = s.commit({ content: 'alpha deploy fact', source: 'user' });
    const b = s.commit({ content: 'beta deploy fact', source: 'user' });
    expect(s.inspect().map((r) => r.record.id).sort()).toEqual([a.id, b.id].sort());
    expect(readFileSync(target, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
    expect(names(targetDir)).toEqual([ffName.toString('latin1')]);
  });

  it('a link through a DIRECTORY named <0xff>: the same fallback, and the append reaches the file', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'helix-ffdir-')));
    const ffDir = Buffer.concat([Buffer.from(`${d}/`), ff, Buffer.from('dir')]);
    mkdirSync(ffDir);
    const target = Buffer.concat([ffDir, Buffer.from('/real.jsonl')]);
    writeFileSync(target, '');
    const link = join(d, 'ledger.jsonl');
    symlinkSync(target, link);
    expect(canonical(link)).toBe(link);
    appendRecord(link, rec('m_1'));
    expect(readFileSync(target, 'utf8')).toContain('"m_1"');
    expect(parseLedger(link).map((r) => r.id)).toEqual(['m_1']);
  });

  it('control: a destination with a valid multi-byte UTF-8 name still resolves to the file it reaches', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'helix-utf8name-')));
    const target = Buffer.concat([Buffer.from(`${d}/`), Buffer.from([0xea, 0xb8, 0xb0]), Buffer.from('.jsonl')]);   // one three-byte character
    writeFileSync(target, '');
    const link = join(d, 'ledger.jsonl');
    symlinkSync(target, link);
    expect(canonical(link)).toBe(target.toString('utf8'));
    expect(lockPathOf(link)).toBe(`${target.toString('utf8')}.lock`);
  });

  it('control: a DANGLING link to a <0xff> name is the link itself, and the first append creates the kernel\'s file', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'helix-ffdangling-')));
    mkdirSync(join(d, 'target'));
    const target = Buffer.concat([Buffer.from(`${join(d, 'target')}/`), ffName]);
    const link = join(d, 'ledger.jsonl');
    symlinkSync(target, link);
    expect(canonical(link)).toBe(link);
    appendRecord(link, rec('m_1'));
    expect(names(join(d, 'target'))).toEqual([ffName.toString('latin1')]);
    expect(parseLedger(link).map((r) => r.id)).toEqual(['m_1']);
  });
});
