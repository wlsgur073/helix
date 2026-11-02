// Holds the project-registry lock and plants a foreign ledger INSIDE the hold, so a first commit that
// has already passed its judgement under the ledger lock blocks on this lock and then meets the file.
// That window, between the judgement and the exclusive creation, is reached from the commit path only
// by holding the registry lock: the judgement refuses any ledger that is present BEFORE it is made.
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
