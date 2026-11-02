// Third fix batch B1, task B9b (design section 14 item 21, 4.3 step 2): an error raised through a held folder names the
// folder's judged path, not the descriptor path /proc/self/fd/<n> it was reached by. The error stays the same object, so its
// code, its markers and the stored mark survive.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRecordUnlocked, compactLedgerUnlocked } from '../../src/memory/ledger.js';
import { withFileLock } from '../../src/memory/lock.js';
import { realFsOps, type DurableFsOps } from '../../src/memory/fs-ops.js';
import { unbindError, closeHeldDir, type HeldDir } from '../../src/memory/dir-bound.js';
import { openOwnerDir, stampOwnership } from '../../src/memory/ownership.js';
import { isRecordStoredError } from '../../src/memory/witness-store.js';
import { handleCommit } from '../../src/server/handlers.js';
import type { MemoryRecord } from '../../src/types.js';
import { fixture, cleanupFixtures, rowsIn, keepWritable, NOW } from '../helpers/first-write-fixture.js';

const HAS_PROC = process.platform === 'linux' && existsSync('/proc/self/fd');
const AS_ROOT = process.getuid?.() === 0;
const made: string[] = [];
afterEach(() => { cleanupFixtures(); for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

const tmp = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'hd-'))); made.push(d); return d; };
const rec = (id: string): MemoryRecord => ({
  id, tx: NOW, validFrom: NOW, validTo: null, type: 'assert', state: 'Fresh', content: `fact ${id}`,
  provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
});
const seed = (f: string, ...rs: MemoryRecord[]): void => writeFileSync(f, rs.map((r) => JSON.stringify(r) + '\n').join(''));
const noKeep = { keepValidVerify: () => false, provesKey: () => false } as const;
const thrown = (f: () => unknown): Error & NodeJS.ErrnoException => {
  try { f(); } catch (e) { return e as Error & NodeJS.ErrnoException; }
  throw new Error('expected a throw');
};
/** An errno error the way node builds one for a failed syscall on a path. */
const errnoAt = (code: string, text: string, syscall: string, path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: ${text}, ${syscall} '${path}'`), { code, syscall, path });

describe('a commit to a memory file the kernel refuses to open (the append through the held folder)', () => {
  it.skipIf(!HAS_PROC || AS_ROOT)('(a) a second commit to a file at mode 0444: EACCES naming the file, never /proc/self/fd, and nothing appended', () => {
    const fx = fixture();
    expect(fx.store().commitScoped({ content: 'first fact', source: 'user' }).scope).toBe('project');
    chmodSync(fx.ledger, 0o444);
    const real = realpathSync(fx.ledger);
    const e = thrown(() => fx.store('b').commitScoped({ content: 'second fact', source: 'user' }));
    expect(e.code).toBe('EACCES');
    expect(e.message).toContain(real);
    expect(e.message).not.toContain('/proc/self/fd');
    expect(e.path).toBe(real);
    expect(rowsIn(fx.ledger)).toEqual(['first fact']);
  });

  it.skipIf(!HAS_PROC || AS_ROOT)('(b) the commit tool: the response text names the file, never /proc/self/fd', () => {
    const fx = fixture();
    handleCommit(fx.store(), { content: 'first fact', source: 'user', scope: 'project' });
    chmodSync(fx.ledger, 0o444);
    const text = thrown(() => handleCommit(fx.store('b'), { content: 'second fact', source: 'user', scope: 'project' })).message;
    expect(text).toContain(realpathSync(fx.ledger));
    expect(text).not.toContain('/proc/self/fd');
  });
});

describe('a fault after the row is durable (14 decision 10)', () => {
  it.skipIf(!HAS_PROC)('(c) the directory fsync through the descriptor fails: the same error, its code and the stored mark kept, naming the judged folder', () => {
    const dir = tmp(); const ledger = join(dir, 'memory.jsonl'); seed(ledger, rec('m_1'));
    let raised: NodeJS.ErrnoException | null = null;
    const fsOps: DurableFsOps = {
      ...realFsOps,
      fsyncDir: (d) => {
        if (!d.startsWith('/proc/self/fd/')) { realFsOps.fsyncDir(d); return; }
        raised = Object.assign(new Error(`EIO: i/o error, fsync '${d}'`), { code: 'EIO', errno: -5, syscall: 'fsync', path: d });
        throw raised;
      },
    };
    const e = thrown(() => appendRecordUnlocked(ledger, rec('m_2'), fsOps));
    expect(raised).not.toBeNull();
    expect(e).toBe(raised);
    expect(isRecordStoredError(e)).toBe(true);
    expect(e.code).toBe('EIO');
    expect(e.message).toBe(`EIO: i/o error, fsync '${dir}'`);
    expect(e.path).toBe(dir);
    expect(readFileSync(ledger, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
  });
});

describe('the rewrite through the held folder', () => {
  it.skipIf(!HAS_PROC)('(d) the tmp cannot be created: the error names <judged folder>/memory.jsonl.c-<hex>.tmp, and the ledger is byte-identical', () => {
    const dir = tmp(); const ledger = join(dir, 'memory.jsonl'); seed(ledger, rec('m_1'), rec('m_2'));
    const before = readFileSync(ledger);
    let given: string | null = null;
    const fsOps: DurableFsOps = {
      ...realFsOps,
      openSync: (p, f, m) => {
        if (/\.c-[0-9a-f]{32}\.tmp$/.test(p)) { given = p; throw errnoAt('EACCES', 'permission denied', 'open', p); }
        return realFsOps.openSync(p, f, m);
      },
    };
    const e = thrown(() => withFileLock(ledger, (ctx) => compactLedgerUnlocked(ledger, { erasedIds: new Set(['m_1']), ...noKeep, fsOps }, ctx)));
    expect(given).toMatch(/^\/proc\/self\/fd\/\d+\/memory\.jsonl\.c-[0-9a-f]{32}\.tmp$/);
    expect(e.code).toBe('EACCES');
    expect(e.message).toMatch(new RegExp(`^EACCES: permission denied, open '${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/memory\\.jsonl\\.c-[0-9a-f]{32}\\.tmp'$`));
    expect(e.message).not.toContain('/proc/self/fd');
    expect(e.path).toMatch(new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/memory\\.jsonl\\.c-[0-9a-f]{32}\\.tmp$`));
    expect(readFileSync(ledger).equals(before)).toBe(true);
  });
});

describe('the .owner write through the held .helix folder', () => {
  // The first write and the adopt turn a failed .owner write into a fixed text with the error as its cause
  // (FIRST_WRITE_FAILED_UNDONE, ADOPT_RECORD_FAILED_UNDONE), so this asserts at the stamp's own boundary.
  it.skipIf(!HAS_PROC || AS_ROOT)('(e) the .owner tmp cannot be created in the held folder: the error names a path under the judged .helix, never /proc/self/fd', () => {
    const fx = fixture();
    const opened = openOwnerDir(fx.root, {}, realFsOps);
    expect(opened.kind).toBe('bound');
    if (opened.kind !== 'bound') return;
    const helix = realpathSync(fx.helix);
    chmodSync(fx.helix, 0o555); keepWritable(fx.helix);
    try {
      const e = thrown(() => stampOwnership(fx.root, fx.home, { now: () => NOW, ownerDir: opened.dir }));
      expect(e.code).toBe('EACCES');
      expect(e.message).toContain(`${helix}/.owner.`);
      expect(e.message).not.toContain('/proc/self/fd');
      expect(e.path?.startsWith(`${helix}/.owner.`)).toBe(true);
    } finally { closeHeldDir(opened.dir, realFsOps); }
    expect(existsSync(join(fx.helix, '.owner'))).toBe(false);
  });
});

describe('unbindError (the helper)', () => {
  const held: HeldDir = { dir: '/x/.helix', fd: 2 };

  it('(f) the prefix is replaced only before /, a quote or the end; dest is rewritten like path', () => {
    const other = errnoAt('EACCES', 'permission denied', 'open', '/proc/self/fd/21/memory.jsonl');
    expect(unbindError(other, held)).toBe(other);
    expect(other.message).toBe("EACCES: permission denied, open '/proc/self/fd/21/memory.jsonl'");
    expect(other.path).toBe('/proc/self/fd/21/memory.jsonl');

    const file = Object.assign(errnoAt('EACCES', 'permission denied', 'rename', '/proc/self/fd/2/memory.jsonl'), { dest: '/proc/self/fd/2/memory.jsonl.c-1.tmp' });
    file.message = "EACCES: permission denied, rename '/proc/self/fd/2/memory.jsonl' -> '/proc/self/fd/2/memory.jsonl.c-1.tmp'";
    expect(unbindError(file, held)).toBe(file);
    expect(file.message).toBe("EACCES: permission denied, rename '/x/.helix/memory.jsonl' -> '/x/.helix/memory.jsonl.c-1.tmp'");
    expect(file.path).toBe('/x/.helix/memory.jsonl');
    expect((file as { dest?: string }).dest).toBe('/x/.helix/memory.jsonl.c-1.tmp');
    expect(file.code).toBe('EACCES');

    const folder = errnoAt('EIO', 'i/o error', 'fsync', '/proc/self/fd/2');
    expect(unbindError(folder, held)).toBe(folder);
    expect(folder.message).toBe("EIO: i/o error, fsync '/x/.helix'");
    expect(folder.path).toBe('/x/.helix');
  });

  it('(g) an error with no path, and a held folder without a descriptor, come back as the same object with the same message', () => {
    const nospc = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' });
    expect(unbindError(nospc, held)).toBe(nospc);
    expect(nospc.message).toBe('ENOSPC: no space left on device, write');

    const plain = errnoAt('EACCES', 'permission denied', 'open', '/proc/self/fd/2/memory.jsonl');
    expect(unbindError(plain, { dir: '/x/.helix', fd: null })).toBe(plain);
    expect(plain.message).toBe("EACCES: permission denied, open '/proc/self/fd/2/memory.jsonl'");
    expect(plain.path).toBe('/proc/self/fd/2/memory.jsonl');
  });
});
