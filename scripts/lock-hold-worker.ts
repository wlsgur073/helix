// Holds the ledger lock for HOLD_MS, signalling via barrier files (ASCII only). Argv:
//   node worker.mjs <target> <barrierDir> <holdMs>
// Writes <barrierDir>/acquired once inside the lock, <barrierDir>/released after a clean exit.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock } from '../src/memory/lock.js';

const [target, barrierDir, holdMs] = [process.argv[2]!, process.argv[3]!, Number(process.argv[4] ?? '2000')];
withFileLock(target, () => {
  writeFileSync(join(barrierDir, 'acquired'), String(process.pid));
  const until = Date.now() + holdMs;
  while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
});
writeFileSync(join(barrierDir, 'released'), 'ok');
