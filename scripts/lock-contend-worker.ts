// Test worker (spawned as a separate OS process by test/memory/lock-concurrency.test.ts).
// Increments a counter file ITERS times, each increment a read-modify-write under withFileLock.
// If the cross-process lock works, N concurrent workers yield exactly N*ITERS; a broken lock loses
// updates (final < N*ITERS). Bundled by the test via esbuild so it runs under plain `node`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { withFileLock } from '../src/memory/lock.js';

const target = process.argv[2]!;
const iters = Number(process.argv[3] ?? '20');
const counter = target + '.count';

for (let i = 0; i < iters; i++) {
  withFileLock(target, () => {
    const cur = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
    writeFileSync(counter, String(cur + 1));
  });
}
