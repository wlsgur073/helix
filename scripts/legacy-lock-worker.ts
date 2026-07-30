// Same protocol as lock-hold-worker, but runs the FROZEN pre-redesign lock (age-stealing mkdir
// mutex) — this IS what old installed bundles do. Used to pin the documented mixed-window behavior.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { withFileLock } from './legacy-lock-frozen.js';

const [target, barrierDir, holdMs] = [process.argv[2]!, process.argv[3]!, Number(process.argv[4] ?? '2000')];
withFileLock(target, () => {
  writeFileSync(join(barrierDir, 'acquired'), String(process.pid));
  // MONOTONIC hold — see lock-hold-worker.ts for why. NOTE: this file deliberately runs the FROZEN
  // legacy lock, but the HOLD is test scaffolding, not part of the frozen algorithm, so timing it
  // honestly does not weaken what this worker pins.
  const until = performance.now() + holdMs;
  while (performance.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
});
writeFileSync(join(barrierDir, 'released'), 'ok');
