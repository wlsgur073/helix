import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ledgerMod from '../../src/memory/ledger.js';
import { judgeProjectLayer, projectLedgerPath, stampOwnership } from '../../src/memory/ownership.js';

const NOW = '2026-10-01T00:00:00.000Z';
const rec = (id: string): string => JSON.stringify({ id, tx: NOW, validFrom: NOW, validTo: null, type: 'assert', state: 'Fresh', content: `fact ${id}`, provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' }) + '\n';
const sleepMs = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** An ADOPTED project whose memory path is a link to data/mem.jsonl inside the project (the layout row 9a reads). */
function linked(content: string) {
  const b = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'jcm-'))); dirs.push(b);
  const root = join(b, 'proj'); const home = join(b, 'home');
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(join(root, 'data'), { recursive: true });
  stampOwnership(root, home, {});
  const target = join(root, 'data', 'mem.jsonl'); fs.writeFileSync(target, content);
  fs.symlinkSync(target, projectLedgerPath(root));
  const judge = (opts: { freshContent?: boolean } = {}) =>
    judgeProjectLayer({ root, ledger: projectLedgerPath(root), home, globalLedger: join(home, 'memory.jsonl'), origin: 'cwd' }, opts);
  return { target, judge };
}

describe('row 9a reads the first 1 MiB (decision 1)', () => {
  it('the first record past 1 MiB makes an in-project link target "not ledger rows": unusable, row 9a', () => {
    const w = linked('x\n'.repeat(600_000) + rec('a'));
    expect(w.judge()).toMatchObject({ state: 'unusable', row: '9a', cause: 'not-ledger-content' });
  });
  it('the same record below the bound is ledger rows: owned', () => {
    expect(linked('x\n'.repeat(100_000) + rec('a')).judge()).toMatchObject({ state: 'owned', row: '11' });
  });
  it('a Helix-written 98,584-byte first line is ledger rows: owned', () => {
    expect(linked(JSON.stringify({ id: 'm_big', tx: NOW, validFrom: NOW, validTo: null, type: 'assert', state: 'Fresh', content: '\u0001'.repeat(16_384), provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' }) + '\n').judge())
      .toMatchObject({ state: 'owned', row: '11' });
  });
});

describe('the per-process memory of row 9a (keyed by device, inode, size, mtime, ctime)', () => {
  it('a settled file is read once for the read side; a write (freshContent) always reads; a change of size reads again', () => {
    const spy = vi.spyOn(ledgerMod, 'ledgerContentKindOfFd');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);               // the file counts as older than the 2 s settling time
    const w = linked(rec('a'));
    expect(w.judge()).toMatchObject({ state: 'owned' }); expect(spy).toHaveBeenCalledTimes(1);
    expect(w.judge()).toMatchObject({ state: 'owned' }); expect(spy).toHaveBeenCalledTimes(1);               // answered from memory
    expect(w.judge({ freshContent: true })).toMatchObject({ state: 'owned' }); expect(spy).toHaveBeenCalledTimes(2);
    expect(w.judge()).toMatchObject({ state: 'owned' }); expect(spy).toHaveBeenCalledTimes(2);               // the write-side read filled nothing
    sleepMs(20);
    fs.appendFileSync(w.target, rec('b'));
    expect(w.judge()).toMatchObject({ state: 'owned' }); expect(spy).toHaveBeenCalledTimes(3);               // size moved
  });

  it('a file changed within the last 2 s is never remembered', () => {
    const spy = vi.spyOn(ledgerMod, 'ledgerContentKindOfFd');
    const w = linked(rec('a'));
    w.judge(); w.judge();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a change that tries to look unchanged (same size, mtime put back) is not answered from memory: ctime moved', () => {
    const spy = vi.spyOn(ledgerMod, 'ledgerContentKindOfFd');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    const text = rec('a');
    const w = linked(text);
    const stamp = new Date(1_700_000_000_000);                                 // whole seconds: utimesSync sets them to the nanosecond, so they can be put back exactly
    fs.utimesSync(w.target, stamp, stamp);
    const before = fs.statSync(w.target, { bigint: true });
    expect(w.judge()).toMatchObject({ state: 'owned' });                       // remembered as rows
    sleepMs(20);
    fs.writeFileSync(w.target, 'x'.repeat(text.length - 1) + '\n');           // plain text, same size
    fs.utimesSync(w.target, stamp, stamp);                                     // mtime put back
    const after = fs.statSync(w.target, { bigint: true });
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);                                // only ctime tells the two apart
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
    expect(w.judge()).toMatchObject({ state: 'unusable', row: '9a' });         // the stale verdict "rows" is not used
    expect(w.judge({ freshContent: true })).toMatchObject({ state: 'unusable', row: '9a' });
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('the memory is keyed by file: two settled files do not answer for each other', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    const rows = linked(rec('a')); const text = linked('plain text\n');
    expect(rows.judge()).toMatchObject({ state: 'owned' });
    expect(text.judge()).toMatchObject({ state: 'unusable', row: '9a' });
    expect(rows.judge()).toMatchObject({ state: 'owned' });
  });
});
