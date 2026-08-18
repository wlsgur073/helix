// Holds the project-registry lock and plants a foreign ledger INSIDE the hold, so a commit that has
// already passed its own pre-check blocks on this lock and then meets the file under it. That window
// is the only way to reach stampOwnership's autoAdoptLedger re-check from the commit path: the
// pre-check in targetLedger refuses any ledger that is present BEFORE the lock is taken.
//
// Argv: node worker.mjs <registryPath> <ledgerPath> <barrierDir> <plantAfterMs> <holdMs>
// Barriers: <barrierDir>/acquired once inside the lock, /planted after the file lands, /released on exit.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { withFileLock } from '../src/memory/lock.js';

const [target, ledger, barrierDir] = [process.argv[2]!, process.argv[3]!, process.argv[4]!];
const plantAfterMs = Number(process.argv[5] ?? '300');
const holdMs = Number(process.argv[6] ?? '400');

// MONOTONIC, for the reason the sibling hold worker records: a wall clock that steps backward across
// a scheduling boundary on this project's primary platform pushes the deadline out of reach.
const spin = (ms: number): void => {
  const until = performance.now() + ms;
  while (performance.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
};

withFileLock(target, () => {
  writeFileSync(join(barrierDir, 'acquired'), String(process.pid));
  spin(plantAfterMs);                       // let the racing commit clear its pre-check first
  writeFileSync(ledger, '{"foreign":"not written by Helix"}\n');
  writeFileSync(join(barrierDir, 'planted'), 'ok');
  spin(holdMs);                             // keep the commit blocked a little longer
});
writeFileSync(join(barrierDir, 'released'), 'ok');
