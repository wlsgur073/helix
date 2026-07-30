// Holds the ledger lock for HOLD_MS, signalling via barrier files (ASCII only). Argv:
//   node worker.mjs <target> <barrierDir> <holdMs>
// Writes <barrierDir>/acquired once inside the lock, <barrierDir>/released after a clean exit.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { withFileLock } from '../src/memory/lock.js';

const [target, barrierDir, holdMs] = [process.argv[2]!, process.argv[3]!, Number(process.argv[4] ?? '2000')];
withFileLock(target, () => {
  writeFileSync(join(barrierDir, 'acquired'), String(process.pid));
  // MONOTONIC, not Date.now(): the hold bounds how long the test's `released` barrier has to wait,
  // and a wall clock that steps BACKWARD across a scheduling boundary (measured on this project's
  // primary platform, WSL2) pushes `until` out of reach — the hold then over-runs `holdMs` by the
  // size of the jump and the barrier misses its budget. performance.now() cannot step backward.
  const until = performance.now() + holdMs;
  while (performance.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
});
writeFileSync(join(barrierDir, 'released'), 'ok');
