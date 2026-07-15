import { describe, it, expect, beforeAll } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactLedger, parseLedgerText } from '../../src/memory/ledger.js';
import { lockPathOf } from '../../src/memory/lock.js';
import { realFsOps, type DurableFsOps } from '../../src/memory/fs-ops.js';
import type { MemoryRecord } from '../../src/types.js';

const rec = (id: string, content = 'c'): MemoryRecord => ({ id, tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null, type: 'assert', state: 'Fresh', content, provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' });
const seed = (f: string, ...rs: MemoryRecord[]): void => writeFileSync(f, rs.map((r) => JSON.stringify(r) + '\n').join(''));
const noKeep = { keepValidVerify: () => false } as const;

let fenceWorker: string;
beforeAll(async () => {
  fenceWorker = join(mkdtempSync(join(tmpdir(), 'fence-w-')), 'fence.mjs');
  await build({ entryPoints: ['scripts/fence-compactor-worker.ts'], outfile: fenceWorker, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
}, 30_000);

describe('compaction fence', () => {
  it('DETERMINISM: a compactor whose lock was lost renames into ENOENT; the successor result stands (no resurrection)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'fence-'));
    const ledger = join(d, 'memory.jsonl');
    seed(ledger, rec('m_keep'), rec('m_secret', 'THE SECRET'));
    const w = spawn(process.execPath, [fenceWorker, ledger, d], { stdio: 'ignore' });
    const waitFor = async (p: string): Promise<void> => { const until = Date.now() + 10_000; while (!existsSync(join(d, p))) { if (Date.now() > until) throw new Error('timeout ' + p); await new Promise((r) => setTimeout(r, 25)); } };
    await waitFor('tmp-created');
    rmSync(lockPathOf(ledger));                                        // simulate the lost lock
    compactLedger(ledger, { erasedIds: new Set(['m_secret']), ...noKeep }); // successor sweeps + erases
    expect(readFileSync(ledger, 'utf8')).not.toContain('THE SECRET');  // the erase landed
    writeFileSync(join(d, 'go'), '1');
    await waitFor('fenced');
    expect(readFileSync(join(d, 'fenced'), 'utf8')).toBe('ENOENT');    // the stale rename was fenced
    expect(existsSync(join(d, 'renamed'))).toBe(false);
    expect(readFileSync(ledger, 'utf8')).not.toContain('THE SECRET');  // NO resurrection
    w.kill();
  }, 20_000);

  it('order: tmp exists BEFORE the ledger read; fsync(tmp) -> close -> rename -> fsyncDir, lock held throughout', () => {
    const d = mkdtempSync(join(tmpdir(), 'fence2-'));
    const ledger = join(d, 'memory.jsonl');
    seed(ledger, rec('m_a'));
    const ops: string[] = [];
    const recOps: DurableFsOps = { ...realFsOps,
      openSync: (p, fl, m) => { ops.push(p.endsWith('.tmp') ? 'open-tmp' : 'open-other'); return realFsOps.openSync(p, fl, m); },
      fsyncSync: (fd) => { ops.push('fsync-fd'); realFsOps.fsyncSync(fd); },
      closeSync: (fd) => { ops.push('close'); realFsOps.closeSync(fd); },
      renameSync: (a, b) => { ops.push('rename'); realFsOps.renameSync(a, b); },
      fsyncDir: (p) => { ops.push('fsyncDir'); realFsOps.fsyncDir(p); },
      readdirSync: (p) => { ops.push('sweep'); return realFsOps.readdirSync(p); },
    };
    compactLedger(ledger, { erasedIds: new Set(), ...noKeep, fsOps: recOps });
    const i = (n: string): number => ops.indexOf(n);
    expect(i('sweep')).toBeLessThan(i('open-tmp'));                     // sweep first
    expect(i('fsync-fd')).toBeLessThan(i('close'));
    expect(i('close')).toBeLessThan(i('rename'));
    expect(ops.lastIndexOf('fsyncDir')).toBeGreaterThan(i('rename'));   // dir fsync AFTER rename
  });
  it('mode preservation: a 0600 ledger stays 0600 through compaction (umask-proof fchmod)', () => {
    const d = mkdtempSync(join(tmpdir(), 'fence3-'));
    const ledger = join(d, 'memory.jsonl');
    seed(ledger, rec('m_a'));
    chmodSync(ledger, 0o600);
    compactLedger(ledger, { erasedIds: new Set(), ...noKeep });
    expect(statSync(ledger).mode & 0o777).toBe(0o600);
  });
  it('nlink guard: compacting a hard-linked ledger throws and changes nothing', () => {
    const d = mkdtempSync(join(tmpdir(), 'fence4-'));
    const ledger = join(d, 'memory.jsonl');
    seed(ledger, rec('m_a'));
    linkSync(ledger, join(d, 'alias.jsonl'));
    const before = readFileSync(ledger, 'utf8');
    expect(() => compactLedger(ledger, { erasedIds: new Set(['m_a']), ...noKeep })).toThrow(/hard link/i);
    expect(readFileSync(ledger, 'utf8')).toBe(before);
  });
  it('failure cleanup: a write failure unlinks the tmp and rethrows (no plaintext orphan from OUR failure)', () => {
    const d = mkdtempSync(join(tmpdir(), 'fence5-'));
    const ledger = join(d, 'memory.jsonl');
    seed(ledger, rec('m_a'));
    const failing = { ...realFsOps, fsyncSync: () => { throw new Error('ENOSPC fake'); } };
    expect(() => compactLedger(ledger, { erasedIds: new Set(), ...noKeep, fsOps: failing })).toThrow(/ENOSPC fake/);
    expect(realFsOps.readdirSync(d).filter((n) => n.includes('.c-'))).toHaveLength(0);
  });
  it('permanent-erase honesty: an unremovable plaintext orphan makes the compaction THROW (sweep aborts it)', () => {
    const d = mkdtempSync(join(tmpdir(), 'fence6-'));
    const ledger = join(d, 'memory.jsonl');
    seed(ledger, rec('m_a'));
    writeFileSync(join(d, `memory.jsonl.c-${'a'.repeat(32)}.tmp`), 'orphan with plaintext');
    const failing = { ...realFsOps, unlinkSync: (p: string) => { if (p.endsWith('.tmp')) throw new Error('EACCES fake'); realFsOps.unlinkSync(p); } };
    expect(() => compactLedger(ledger, { erasedIds: new Set(['m_a']), ...noKeep, fsOps: failing })).toThrow(/EACCES fake/);
  });
});
