// Adopts a batch of projects into a SHARED home registry, gated on a barrier file so every worker
// begins its read-modify-write at ~the same instant (maximizing contention). Test-only (bundled by
// ownership-concurrency.test.ts, never shipped in bin/). ASCII only. Argv:
//   node adopt.mjs <home> <goFile> <readyFile> <projectRoot...>
import { existsSync, writeFileSync } from 'node:fs';
import { stampOwnership } from '../src/memory/ownership.js';

const home = process.argv[2]!;
const goFile = process.argv[3]!;
const readyFile = process.argv[4]!;
const roots = process.argv.slice(5);

writeFileSync(readyFile, 'ready');
// Spin-wait for the barrier so all workers race their first stampOwnership together.
while (!existsSync(goFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
for (const root of roots) stampOwnership(root, home);
