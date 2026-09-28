// IT-H4: the three ledger readers used readFileSync and never asked WHAT the path is. A FIFO with no
// writer blocks open(2) forever and a character device reads without bound; neither is an I/O
// *error*, so no catch saw them: an unadopted cwd project's FIFO ledger stalled server startup, and so
// did a ledger symlinked to /dev/zero, which a repository can carry (spec §11, probe s7b).
// reality-check.ts already had the safe pattern: open non-blocking, fstat the descriptor, regular
// files only. /dev/null stands in for the character-device class here, because reading /dev/zero
// through pre-fix code allocates without bound.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { parseLedger, readLedgerBytes, readLedgerRaw, isLedgerNotRegularError } from '../../src/memory/ledger.js';
import { MemoryStore } from '../../src/memory/store.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'helix-ledgertype-'));

function store(home: string, ledger: string = join(home, 'memory.jsonl')): MemoryStore {
  let n = 0;
  return new MemoryStore(ledger, { sessionId: 's', home, now: () => '2026-09-27T00:00:00.000Z', genId: () => `m_${++n}` });
}

function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (e) { return e; }
  return undefined;
}

// A pre-fix reader blocks FOREVER on a writer-less FIFO (a synchronous open(2) that no vitest timeout
// can interrupt), so a FIFO case must never reach a reader until the file-type check exists. The
// predicate ships with the check, so its presence is the precondition.
function requireFileTypeCheck(): void {
  if (typeof isLedgerNotRegularError !== 'function') {
    throw new Error('the ledger file-type check is not implemented yet: refusing to open a FIFO through a blocking reader');
  }
}

const mkfifo = (p: string): void => { execFileSync('mkfifo', [p]); };

const posixOnly = describe.skipIf(process.platform === 'win32');

posixOnly('ledger readers refuse a path that is not a regular file (IT-H4)', () => {
  const cases: Array<[string, boolean, (dir: string) => string]> = [
    ['a FIFO with no writer', true, (dir) => { const p = join(dir, 'memory.jsonl'); mkfifo(p); return p; }],
    ['a directory', false, (dir) => { const p = join(dir, 'memory.jsonl'); mkdirSync(p); return p; }],
    ['a symlink to a character device', false, (dir) => { const p = join(dir, 'memory.jsonl'); symlinkSync('/dev/null', p); return p; }],
  ];
  for (const [label, isFifo, make] of cases) {
    it(`${label}: all three readers throw LedgerNotRegularError without blocking`, () => {
      if (isFifo) requireFileTypeCheck();
      const dir = tmp();
      try {
        const p = make(dir);
        for (const read of [parseLedger, readLedgerBytes, readLedgerRaw] as Array<(x: string) => unknown>) {
          const e = thrown(() => read(p));
          expect(isLedgerNotRegularError(e), `${label} via ${read.name}`).toBe(true);
          expect((e as Error).message).toContain('is not a regular file');
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 10_000);
  }

  it('a commit into a FIFO ledger is refused before anything is appended', () => {
    requireFileTypeCheck();
    const home = tmp();
    const ledgerDir = tmp();
    const p = join(ledgerDir, 'memory.jsonl');
    mkfifo(p);
    try {
      expect(isLedgerNotRegularError(thrown(() => store(home, p).commit({ content: 'the queue is sqs', source: 'user' })))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('a permanent erase refuses a FIFO candidate ledger instead of blocking on it', () => {
    requireFileTypeCheck();
    const home = tmp();
    mkfifo(join(home, 'memory.jsonl'));
    try {
      expect(isLedgerNotRegularError(thrown(() => store(home).erase('m_1', { permanent: true })))).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 10_000);

  it('a UNIX socket at the ledger path: all three readers throw LedgerNotRegularError', async () => {
    const dir = mkdtempSync('/tmp/hl-');   // short on purpose: a socket path must fit sun_path (108 bytes)
    const p = join(dir, 'memory.jsonl');
    const srv = createServer();
    await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(p, resolve); });
    try {
      for (const read of [parseLedger, readLedgerBytes, readLedgerRaw] as Array<(x: string) => unknown>) {
        const e = thrown(() => read(p));
        expect(isLedgerNotRegularError(e), `socket via ${read.name}`).toBe(true);
        expect((e as Error).message).toContain('is not a regular file');
      }
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('regular files read exactly as readFileSync read them (IT-H4)', () => {
  it('an absent ledger keeps each reader\'s empty convention', () => {
    const dir = tmp();
    const p = join(dir, 'memory.jsonl');
    try {
      expect(parseLedger(p)).toEqual([]);
      expect(readLedgerBytes(p).length).toBe(0);
      expect(readLedgerRaw(p)).toEqual({ bytes: Buffer.alloc(0), records: [], skippedNonBlank: 0 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a 0-byte file, a torn tail and a symlink to a regular file return the same bytes as readFileSync', () => {
    const dir = tmp();
    try {
      const empty = join(dir, 'empty.jsonl');
      writeFileSync(empty, '');
      const torn = join(dir, 'torn.jsonl');
      writeFileSync(torn, '{"id":"m_1"}\n{"id":"m_2"');
      const link = join(dir, 'link.jsonl');
      symlinkSync(torn, link);
      for (const p of [empty, torn, link]) {
        expect(readLedgerBytes(p).equals(readFileSync(p)), p).toBe(true);
        expect(readLedgerRaw(p).bytes.equals(readFileSync(p)), p).toBe(true);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a ledger symlinked to a regular file still reads and commits (a legitimate alias)', () => {
    const home = tmp();
    const realDir = tmp();
    const real = join(realDir, 'memory.jsonl');
    writeFileSync(real, '');
    const link = join(home, 'memory.jsonl');
    symlinkSync(real, link);
    try {
      const s = store(home, link);
      s.commit({ content: 'the deploy target is staging', source: 'user' });
      expect(readFileSync(real, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(s.inspect().map((r) => r.record.content)).toEqual(['the deploy target is staging']);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(realDir, { recursive: true, force: true });
    }
  });
});
