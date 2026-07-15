import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, linkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRecord, appendRecordUnlocked, parseLedgerText, parseLedgerHealth } from '../../src/memory/ledger.js';
import { realFsOps, type DurableFsOps } from '../../src/memory/fs-ops.js';
import type { MemoryRecord } from '../../src/types.js';

const rec = (id: string): MemoryRecord => ({ id, tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null, type: 'assert', state: 'Fresh', content: 'c', provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' });
const dir = (): string => mkdtempSync(join(tmpdir(), 'append-'));

describe('tail repair (torn-tail-swallow regression, probe-confirmed pre-existing defect)', () => {
  it('an acknowledged append after a NEWLINE-LESS torn tail still parses (was swallowed before)', () => {
    const f = join(dir(), 'memory.jsonl');
    writeFileSync(f, JSON.stringify(rec('m_a')) + '\n' + '{"id":"m_torn","content":"secr');
    appendRecord(f, rec('m_b'));
    const rows = parseLedgerText(readFileSync(f, 'utf8'));
    expect(rows.some((r) => r.id === 'm_b')).toBe(true);              // the NEW record is visible
    expect(parseLedgerHealth(readFileSync(f, 'utf8')).skippedNonBlank).toBe(1); // the fragment is isolated + counted
  });
  it('a VALID body missing only its newline COMMITS on repair (at-least-once rule, spec Layer 5)', () => {
    const f = join(dir(), 'memory.jsonl');
    writeFileSync(f, JSON.stringify(rec('m_unacked')));                // complete JSON, no trailing newline
    appendRecord(f, rec('m_next'));
    const ids = parseLedgerText(readFileSync(f, 'utf8')).map((r) => r.id);
    expect(ids).toEqual(['m_unacked', 'm_next']);
    expect(parseLedgerHealth(readFileSync(f, 'utf8')).skippedNonBlank).toBe(0);
  });
  it('every byte-cut of a record stays isolated: the following append always parses', () => {
    const full = JSON.stringify(rec('m_cut'));
    for (let cut = 1; cut < full.length; cut += 7) {                   // stride keeps the matrix fast
      const f = join(dir(), 'memory.jsonl');
      writeFileSync(f, JSON.stringify(rec('m_first')) + '\n' + full.slice(0, cut));
      appendRecord(f, rec('m_after'));
      const ids = parseLedgerText(readFileSync(f, 'utf8')).map((r) => r.id);
      expect(ids).toContain('m_first');
      expect(ids).toContain('m_after');
    }
  });
  it('a cut inside a multi-byte UTF-8 sequence stays malformed and isolated', () => {
    const f = join(dir(), 'memory.jsonl');
    const utf8 = Buffer.from(JSON.stringify({ ...rec('m_ko'), content: '한국어 내용' }), 'utf8');
    writeFileSync(f, Buffer.concat([Buffer.from(JSON.stringify(rec('m_a')) + '\n'), utf8.subarray(0, utf8.length - 4)]));
    appendRecord(f, rec('m_b'));
    const ids = parseLedgerText(readFileSync(f, 'utf8')).map((r) => r.id);
    expect(ids).toEqual(['m_a', 'm_b']);
  });
  it('first append to a MISSING ledger works (no tail probe on an empty file)', () => {
    const f = join(dir(), 'sub', 'memory.jsonl');
    appendRecord(f, rec('m_first'));
    expect(parseLedgerText(readFileSync(f, 'utf8'))).toHaveLength(1);
  });
});

describe('fsync order + failure propagation (the seam is the only observable for durability)', () => {
  it('append issues: open -> write -> fsync(fd) -> close -> fsyncDir(parent), in that order', () => {
    const f = join(dir(), 'memory.jsonl');
    const ops: string[] = [];
    const recOps: DurableFsOps = { ...realFsOps,
      openSync: (p, fl, m) => { ops.push('open'); return realFsOps.openSync(p, fl, m); },
      writeSync: (fd, b, o, l) => { ops.push('write'); return realFsOps.writeSync(fd, b, o, l); },
      fsyncSync: (fd) => { ops.push('fsync'); realFsOps.fsyncSync(fd); },
      closeSync: (fd) => { ops.push('close'); realFsOps.closeSync(fd); },
      fsyncDir: (d2) => { ops.push('fsyncDir'); realFsOps.fsyncDir(d2); },
    };
    appendRecordUnlocked(f, rec('m_a'), recOps);
    const i = (name: string): number => ops.indexOf(name);
    expect(i('write')).toBeGreaterThan(i('open'));
    expect(i('fsync')).toBeGreaterThan(i('write'));
    expect(i('close')).toBeGreaterThan(i('fsync'));
    expect(i('fsyncDir')).toBeGreaterThan(i('close'));
  });
  it('a write/fsync failure PROPAGATES (success is never reported after a failed step)', () => {
    const f = join(dir(), 'memory.jsonl');
    const failing = { ...realFsOps, fsyncSync: () => { throw new Error('EIO fake'); } };
    expect(() => appendRecordUnlocked(f, rec('m_a'), failing)).toThrow(/EIO fake/);
  });
});

describe('nlink guard (writer mutual exclusion vs pre-existing hard-link aliases)', () => {
  it('append to a hard-linked ledger throws a descriptive error and writes nothing', () => {
    const d = dir();
    const f = join(d, 'memory.jsonl');
    writeFileSync(f, JSON.stringify(rec('m_a')) + '\n');
    linkSync(f, join(d, 'alias.jsonl'));
    expect(() => appendRecord(f, rec('m_b'))).toThrow(/hard link/i);
    expect(readFileSync(f, 'utf8')).not.toContain('m_b');
  });
});

describe('sweep integration (every lock entry sweeps — appends included)', () => {
  it('an orphaned compaction tmp is removed by a plain append, and a sweep failure ABORTS the append', () => {
    const d = dir();
    const f = join(d, 'memory.jsonl'); writeFileSync(f, '');
    const orphan = join(d, `memory.jsonl.c-${'a'.repeat(32)}.tmp`);
    writeFileSync(orphan, 'stale pre-erase snapshot');
    appendRecord(f, rec('m_a'));
    expect(existsSync(orphan)).toBe(false);                            // fence hygiene on the append path
    writeFileSync(orphan, 'again');
    const failing = { ...realFsOps, unlinkSync: () => { throw new Error('EACCES fake'); } };
    expect(() => appendRecordUnlocked(f, rec('m_b'), failing)).toThrow(/EACCES fake/);
    expect(readFileSync(f, 'utf8')).not.toContain('m_b');              // aborted BEFORE writing
  });
});
