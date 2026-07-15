// Same protocol as lock-hold-worker, but runs the FROZEN pre-redesign lock (age-stealing mkdir
// mutex) — this IS what old installed bundles do. Used to pin the documented mixed-window behavior.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock } from './legacy-lock-frozen.js';

const [target, barrierDir, holdMs] = [process.argv[2]!, process.argv[3]!, Number(process.argv[4] ?? '2000')];
withFileLock(target, () => {
  writeFileSync(join(barrierDir, 'acquired'), String(process.pid));
  const until = Date.now() + holdMs;
  while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
});
writeFileSync(join(barrierDir, 'released'), 'ok');
