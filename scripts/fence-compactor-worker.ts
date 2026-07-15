// Fence-determinism worker: acquires the ledger lock, creates its compaction tmp, then WAITS for
// the test's "go" signal before reading/renaming — a deterministic stand-in for "compactor whose
// lock was lost mid-section". Reports via barrier files (ASCII only).
//   node worker.mjs <ledger> <barrierDir>
import { writeFileSync, existsSync, readFileSync, openSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { withFileLock } from '../src/memory/lock.js';
import { writeAll, realFsOps } from '../src/memory/fs-ops.js';

const [ledger, barrierDir] = [process.argv[2]!, process.argv[3]!];
const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
try {
  withFileLock(ledger, () => {
    const tmp = `${ledger}.c-${randomBytes(16).toString('hex')}.tmp`;
    const fd = openSync(tmp, 'wx');
    const snapshot = readFileSync(ledger, 'utf8');            // the stale pre-erase snapshot
    writeFileSync(join(barrierDir, 'tmp-created'), tmp);
    while (!existsSync(join(barrierDir, 'go'))) sleep(25);    // test steals our lock + compacts meanwhile
    writeAll(realFsOps, fd, snapshot);
    closeSync(fd);
    try {
      renameSync(tmp, ledger);                                // must fail ENOENT if we were fenced
      writeFileSync(join(barrierDir, 'renamed'), 'BAD');
    } catch (e) {
      writeFileSync(join(barrierDir, 'fenced'), String((e as NodeJS.ErrnoException).code));
      try { unlinkSync(tmp); } catch { /* already gone */ }
    }
  });
} catch (e) {
  writeFileSync(join(barrierDir, 'worker-error'), String((e as Error).message));
}
