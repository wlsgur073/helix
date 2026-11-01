// Third fix batch B1, task A4 (design 4.1 item 3): the append opens the resolved path with O_NOFOLLOW, checks the
// descriptor before the first byte, and creates the file exclusively when the destination was absent when it was
// judged. Faults are injected through the DurableFsOps seam; the verdicts are computed from the consequence
// (where the row landed, what the other directory holds), never from the error alone.
import { describe, it, expect } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync,
  existsSync, realpathSync, lstatSync, constants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendRecordUnlocked, isLedgerDestinationChangedError, DESTINATION_CHANGED_REFUSAL, type JudgedDestination,
} from '../../src/memory/ledger.js';
import { realFsOps, type DurableFsOps } from '../../src/memory/fs-ops.js';
import type { MemoryRecord } from '../../src/types.js';

const rec = (id: string): MemoryRecord => ({
  id, tx: '2026-10-12T00:00:00.000Z', validFrom: '2026-10-12T00:00:00.000Z', validTo: null, type: 'assert',
  state: 'Fresh', content: `fact ${id}`, provenance: { source: 'user', sessionId: 's' }, supersedes: null,
  blastRadius: null, reverifyTrigger: null, classification: 'normal',
});

interface Fx { base: string; ledger: string; data: string; dataOrig: string; other: string }
function fixture(): Fx {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'aw-')));
  const fx: Fx = { base, ledger: join(base, 'proj', 'data', 'm.jsonl'), data: join(base, 'proj', 'data'), dataOrig: join(base, 'proj', 'data.orig'), other: join(base, 'other') };
  mkdirSync(fx.data, { recursive: true });
  mkdirSync(fx.other);
  return fx;
}
const existing = (fx: Fx): void => { writeFileSync(fx.ledger, JSON.stringify(rec('m_old')) + '\n', { mode: 0o600 }); };
/** data/ becomes a link to other/, the real directory moves aside. */
const swapDir = (fx: Fx): void => { renameSync(fx.data, fx.dataOrig); symlinkSync(fx.other, fx.data); };
const putBack = (fx: Fx): void => { unlinkSync(fx.data); renameSync(fx.dataOrig, fx.data); };
/** Where the judged ledger really is now. */
const judgedFile = (fx: Fx): string => join(existsSync(fx.dataOrig) ? fx.dataOrig : fx.data, 'm.jsonl');
const holds = (p: string, id: string): boolean => { try { return readFileSync(p, 'utf8').includes(`"id":"${id}"`); } catch { return false; } };
const noRowAnywhere = (fx: Fx): boolean =>
  !holds(judgedFile(fx), 'm_new') && !readdirSync(fx.other).some((n) => holds(join(fx.other, n), 'm_new'));

interface Hooks { beforeLedgerOpen?: () => void; afterLedgerOpen?: () => void }
interface Seen { ledgerOpens: Array<{ path: string; flags: unknown; mode: number | undefined }>; readdirs: number }
/** The first open of a path that ends in /m.jsonl is the hook point; the real open runs in between. */
function opsFor(hooks: Hooks): { ops: DurableFsOps; seen: Seen } {
  const seen: Seen = { ledgerOpens: [], readdirs: 0 };
  const ops: DurableFsOps = {
    ...realFsOps,
    readdirSync: (d) => { seen.readdirs++; return realFsOps.readdirSync(d); },   // the orphan sweep lists the directory
    openSync: (p, flags, mode) => {
      if (!p.endsWith('/m.jsonl')) return realFsOps.openSync(p, flags, mode);
      seen.ledgerOpens.push({ path: p, flags, mode });
      const first = seen.ledgerOpens.length === 1;
      if (first) hooks.beforeLedgerOpen?.();
      try { return realFsOps.openSync(p, flags, mode); }
      finally { if (first) hooks.afterLedgerOpen?.(); }
    },
  };
  return { ops, seen };
}
function run(fx: Fx, ops: DurableFsOps, judged?: JudgedDestination): unknown {
  try { appendRecordUnlocked(fx.ledger, rec('m_new'), ops, judged); return null; } catch (e) { return e; }
}

const APPEND = constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW;
const REFUSAL_TEXT = "commit: this project's memory file was replaced while the write waited for its lock — nothing was written. Try the commit again; if it happens again, tell the user.";

describe('append: the open and the create mode (4.1 item 3)', () => {
  it('C1 control: an existing ledger is opened with O_RDWR|O_APPEND|O_NOFOLLOW, without O_CREAT, and gets the row', () => {
    const fx = fixture(); existing(fx);
    const { ops, seen } = opsFor({});
    expect(run(fx, ops)).toBeNull();
    expect(holds(fx.ledger, 'm_new')).toBe(true);
    expect(seen.ledgerOpens).toHaveLength(1);
    expect(seen.ledgerOpens[0]!.flags).toBe(APPEND);
    expect(seen.readdirs).toBe(1);   // the sweep still runs on a healthy append, once, after the check
  });

  it('C2 control: an absent ledger is created exclusively (O_CREAT|O_EXCL|O_NOFOLLOW), mode 0o600 requested', () => {
    const fx = fixture();
    const { ops, seen } = opsFor({});
    expect(run(fx, ops)).toBeNull();
    expect(holds(fx.ledger, 'm_new')).toBe(true);
    expect(seen.ledgerOpens).toHaveLength(1);
    expect(seen.ledgerOpens[0]!.flags).toBe(APPEND | constants.O_CREAT | constants.O_EXCL);
    expect(seen.ledgerOpens[0]!.mode).toBe(0o600);
  });

  it('EEXIST: a file that appeared after the destination was judged absent is opened a second time, with O_NOFOLLOW and without O_CREAT, and gets the row', () => {
    const fx = fixture();
    const { ops, seen } = opsFor({ beforeLedgerOpen: () => writeFileSync(fx.ledger, JSON.stringify(rec('m_appeared')) + '\n', { mode: 0o600 }) });
    expect(run(fx, ops)).toBeNull();
    expect(seen.ledgerOpens.map((o) => o.flags)).toEqual([APPEND | constants.O_CREAT | constants.O_EXCL, APPEND]);
    expect(holds(fx.ledger, 'm_appeared')).toBe(true);
    expect(holds(fx.ledger, 'm_new')).toBe(true);
  });

  it('the refusal text is the 4.9 draft row verbatim, and the error is read by its property marker', () => {
    expect(DESTINATION_CHANGED_REFUSAL).toBe(REFUSAL_TEXT);
    const fx = fixture(); existing(fx);
    const { ops } = opsFor({ beforeLedgerOpen: () => { renameSync(fx.ledger, `${fx.ledger}.moved`); mkdirSync(fx.ledger); } });
    const err = run(fx, ops) as Error;
    expect(isLedgerDestinationChangedError(err)).toBe(true);
    expect(err.message).toBe(REFUSAL_TEXT);
    expect(isLedgerDestinationChangedError(new Error('x'))).toBe(false);
  });
});

describe('append: a destination that changes between the judgement and the open (4.1 item 3, FW-R9)', () => {
  it('E5a: a link planted at the final name of an existing ledger: ELOOP becomes the changed-destination refusal, the link target is untouched', () => {
    const fx = fixture(); existing(fx);
    writeFileSync(join(fx.other, 'victim.jsonl'), 'VICTIM\n');
    const { ops } = opsFor({ beforeLedgerOpen: () => { renameSync(fx.ledger, `${fx.ledger}.moved`); symlinkSync(join(fx.other, 'victim.jsonl'), fx.ledger); } });
    expect(isLedgerDestinationChangedError(run(fx, ops))).toBe(true);
    expect(readFileSync(join(fx.other, 'victim.jsonl'), 'utf8')).toBe('VICTIM\n');
    expect(holds(`${fx.ledger}.moved`, 'm_new')).toBe(false);
  });

  it('E5b: a dangling link planted at the name of an absent ledger: the exclusive open meets EEXIST, the plain open ELOOP; the link target is not created', () => {
    const fx = fixture();
    const { ops, seen } = opsFor({ beforeLedgerOpen: () => symlinkSync(join(fx.other, 'new.jsonl'), fx.ledger) });
    expect(isLedgerDestinationChangedError(run(fx, ops))).toBe(true);
    expect(seen.ledgerOpens).toHaveLength(2);
    expect(existsSync(join(fx.other, 'new.jsonl'))).toBe(false);
  });

  it('E5c: a directory planted at the name of an existing ledger: EISDIR becomes the changed-destination refusal', () => {
    const fx = fixture(); existing(fx);
    const { ops } = opsFor({ beforeLedgerOpen: () => { renameSync(fx.ledger, `${fx.ledger}.moved`); mkdirSync(fx.ledger); } });
    expect(isLedgerDestinationChangedError(run(fx, ops))).toBe(true);
    expect(holds(`${fx.ledger}.moved`, 'm_new')).toBe(false);
  });

  it('ENOENT: an existing ledger that is gone at the open is a changed destination, never a file to create afresh', () => {
    const fx = fixture(); existing(fx);
    const { ops, seen } = opsFor({ beforeLedgerOpen: () => unlinkSync(fx.ledger) });
    expect(isLedgerDestinationChangedError(run(fx, ops))).toBe(true);
    expect(existsSync(fx.ledger)).toBe(false);
    expect(seen.ledgerOpens.map((o) => o.flags)).toEqual([APPEND]);
  });

  it('E4a: data/ replaced by a link to other/ right before the open and left so: the descriptor is the foreign m.jsonl, the check refuses, nothing is written', () => {
    const fx = fixture(); existing(fx);
    writeFileSync(join(fx.other, 'm.jsonl'), 'OTHER\n');
    const { ops } = opsFor({ beforeLedgerOpen: () => swapDir(fx) });
    expect(isLedgerDestinationChangedError(run(fx, ops))).toBe(true);
    expect(readFileSync(join(fx.other, 'm.jsonl'), 'utf8')).toBe('OTHER\n');
    expect(noRowAnywhere(fx)).toBe(true);
  });

  it('E4b: the same with an EMPTY other/: the open without O_CREAT meets ENOENT and other/ stays empty', () => {
    const fx = fixture(); existing(fx);
    const { ops } = opsFor({ beforeLedgerOpen: () => swapDir(fx) });
    expect(isLedgerDestinationChangedError(run(fx, ops))).toBe(true);
    expect(readdirSync(fx.other)).toEqual([]);
  });

  it('E4c: an ABSENT ledger, data/ replaced right before the open: the exclusive create lands in other/, the check refuses, and the file this call created is removed again', () => {
    const fx = fixture();
    const { ops } = opsFor({ beforeLedgerOpen: () => swapDir(fx) });
    expect(isLedgerDestinationChangedError(run(fx, ops))).toBe(true);
    expect(readdirSync(fx.other)).toEqual([]);
  });

  it('E4d: an absent ledger and a FOREIGN other/m.jsonl: the exclusive open meets EEXIST, the plain open reaches the foreign file, the check refuses; the foreign file is neither written nor removed', () => {
    const fx = fixture();
    writeFileSync(join(fx.other, 'm.jsonl'), 'OTHER\n');
    const { ops } = opsFor({ beforeLedgerOpen: () => swapDir(fx) });
    expect(isLedgerDestinationChangedError(run(fx, ops))).toBe(true);
    expect(readFileSync(join(fx.other, 'm.jsonl'), 'utf8')).toBe('OTHER\n');
  });

  it('R2: data/ replaced right before the open and put back right after it: the descriptor is the foreign file, the check refuses, nothing is written (A6 turns this into a write in the judged directory)', () => {
    const fx = fixture(); existing(fx);
    writeFileSync(join(fx.other, 'm.jsonl'), 'OTHER\n');
    const { ops } = opsFor({ beforeLedgerOpen: () => swapDir(fx), afterLedgerOpen: () => putBack(fx) });
    expect(isLedgerDestinationChangedError(run(fx, ops))).toBe(true);
    expect(readFileSync(join(fx.other, 'm.jsonl'), 'utf8')).toBe('OTHER\n');
    expect(noRowAnywhere(fx)).toBe(true);
  });

  it('R3: the same for an absent ledger: no row lands anywhere (the empty file left in other/ is A6\'s, not asserted here)', () => {
    const fx = fixture();
    const { ops } = opsFor({ beforeLedgerOpen: () => swapDir(fx), afterLedgerOpen: () => putBack(fx) });
    expect(isLedgerDestinationChangedError(run(fx, ops))).toBe(true);
    expect(noRowAnywhere(fx)).toBe(true);
  });

  it('the orphan sweep runs after the check: a refused append lists no directory and so removes no tmp-named file from the directory the path came to lead to (v-identity-03)', () => {
    const fx = fixture(); existing(fx);
    writeFileSync(join(fx.other, 'm.jsonl'), 'OTHER\n');
    const orphan = join(fx.other, `m.jsonl.c-${'a'.repeat(32)}.tmp`);
    writeFileSync(orphan, 'stale');
    const { ops, seen } = opsFor({ beforeLedgerOpen: () => swapDir(fx) });
    expect(isLedgerDestinationChangedError(run(fx, ops))).toBe(true);
    expect(seen.readdirs).toBe(0);
    expect(existsSync(orphan)).toBe(true);
  });
});

describe('append: the destination as the caller judged it (4.1 item 3, 4.3 step 3)', () => {
  const sample = (p: string): { dev: bigint; ino: bigint } | null => {
    try { const st = lstatSync(p, { bigint: true }); return { dev: st.dev, ino: st.ino }; } catch { return null; }
  };

  it('P1 control: a judged destination sampled with nothing replaced is written', () => {
    const fx = fixture(); existing(fx);
    const { ops } = opsFor({});
    expect(run(fx, ops, { path: fx.ledger, identity: sample(fx.ledger) })).toBeNull();
    expect(holds(fx.ledger, 'm_new')).toBe(true);
  });

  it('P2 control: an absent judged destination (identity null) is created exclusively', () => {
    const fx = fixture();
    const { ops, seen } = opsFor({});
    expect(run(fx, ops, { path: fx.ledger, identity: null })).toBeNull();
    expect(seen.ledgerOpens[0]!.flags).toBe(APPEND | constants.O_CREAT | constants.O_EXCL);
  });

  it('a judged path that the memory path no longer resolves to is refused before anything is opened', () => {
    const fx = fixture(); existing(fx);
    const { ops, seen } = opsFor({});
    const err = run(fx, ops, { path: join(fx.base, 'elsewhere', 'm.jsonl'), identity: null });
    expect(isLedgerDestinationChangedError(err)).toBe(true);
    expect(seen.ledgerOpens).toHaveLength(0);
    expect(holds(fx.ledger, 'm_new')).toBe(false);
  });

  it('J4 (v-identity-06): a judgement sampled while data/ led to other/, with data/ left replaced: the resolved path is not the judged one, refused, the foreign file untouched', () => {
    const fx = fixture(); existing(fx);
    writeFileSync(join(fx.other, 'm.jsonl'), 'OTHER\n');
    swapDir(fx);
    const judged: JudgedDestination = { path: fx.ledger, identity: sample(join(fx.other, 'm.jsonl')) };
    const { ops } = opsFor({});
    expect(isLedgerDestinationChangedError(run(fx, ops, judged))).toBe(true);
    expect(readFileSync(join(fx.other, 'm.jsonl'), 'utf8')).toBe('OTHER\n');
  });

  it('the descriptor is compared with the JUDGED identity: another file at the same path than the one that was judged is refused after the open', () => {
    const fx = fixture(); existing(fx);
    writeFileSync(join(fx.other, 'm.jsonl'), 'OTHER\n');
    const { ops } = opsFor({});
    const err = run(fx, ops, { path: fx.ledger, identity: sample(join(fx.other, 'm.jsonl')) });
    expect(isLedgerDestinationChangedError(err)).toBe(true);
    expect(holds(fx.ledger, 'm_new')).toBe(false);
  });
});

describe('append: the file at the name changes while the append holds the descriptor (4.1 item 3, section 14 item 13)', () => {
  /** `fire` runs around each seam call of one append, as `<call>:before` and `<call>:after`. The open points are
   *  the ledger's, the fstat points the ledger descriptor's. */
  function seamOps(fire: (point: string) => void): { ops: DurableFsOps; writes: () => number } {
    let ledgerFd: number | undefined;
    let writes = 0;
    const around = <A extends unknown[], R>(name: string, call: (...a: A) => R) => (...a: A): R => {
      fire(`${name}:before`);
      const r = call(...a);
      fire(`${name}:after`);
      return r;
    };
    const ops: DurableFsOps = {
      ...realFsOps,
      readdirSync: around('readdir', realFsOps.readdirSync),
      openSync: (p, flags, mode) => {
        if (!p.endsWith('/m.jsonl')) return realFsOps.openSync(p, flags, mode);
        ledgerFd = around('open', realFsOps.openSync)(p, flags, mode);
        return ledgerFd;
      },
      fstatSync: (fd) => (fd === ledgerFd ? around('fstat', realFsOps.fstatSync)(fd) : realFsOps.fstatSync(fd)),
      readSync: around('read', realFsOps.readSync),
      writeSync: (...a) => { writes++; return around('write', realFsOps.writeSync)(...a); },
      fsyncSync: around('fsync', realFsOps.fsyncSync),
    };
    return { ops, writes: () => writes };
  }

  // The sweep removes the tmp, so behind it the rename fails ENOENT: `lands` is false from there on.
  it.each([
    { point: 'open:before', lands: true },
    { point: 'open:after', lands: true },
    { point: 'fstat:before', lands: true },
    { point: 'fstat:after', lands: true },
    { point: 'readdir:before', lands: true },
    { point: 'readdir:after', lands: true },
    { point: 'read:before', lands: false },
    { point: 'write:before', lands: false },
    { point: 'write:after', lands: false },
    { point: 'fsync:before', lands: false },
  ])("a lock-losing compactor's rename at $point (lands: $lands): the call never returns with the row missing from the file at the name", ({ point, lands }) => {
    const fx = fixture(); existing(fx);
    const orphan = `${fx.ledger}.c-${'b'.repeat(32)}.tmp`;
    writeFileSync(orphan, JSON.stringify(rec('m_old')) + '\n', { mode: 0o600 });
    let rename = 'not reached';
    const { ops, writes } = seamOps((p) => {
      if (p !== point || rename !== 'not reached') return;
      try { renameSync(orphan, fx.ledger); rename = 'landed'; }
      catch (e) { rename = (e as NodeJS.ErrnoException).code ?? 'failed'; }
    });
    const thrown = run(fx, ops);
    expect(rename).toBe(lands ? 'landed' : 'ENOENT');
    if (lands) {
      expect(isLedgerDestinationChangedError(thrown)).toBe(true);
      expect(holds(fx.ledger, 'm_new')).toBe(false);
      expect(writes()).toBe(0);
    } else {
      expect(thrown).toBeNull();
      expect(holds(fx.ledger, 'm_new')).toBe(true);
    }
  });

  it('a file this call created, moved aside for a different file between the open and the check: refused, nothing written, the file at the name left alone', () => {
    const fx = fixture();
    const moved = `${fx.ledger}.moved`;
    let replaced = false;
    const { ops, writes } = seamOps((p) => {
      if (p !== 'fstat:after' || replaced) return;
      replaced = true;
      renameSync(fx.ledger, moved);   // the created inode keeps its link, so only the comparison with the name can tell
      writeFileSync(fx.ledger, 'OTHER\n');
    });
    expect(isLedgerDestinationChangedError(run(fx, ops))).toBe(true);
    expect(replaced).toBe(true);
    expect(writes()).toBe(0);
    expect(readFileSync(fx.ledger, 'utf8')).toBe('OTHER\n');
    expect(readFileSync(moved, 'utf8')).toBe('');
  });
});
