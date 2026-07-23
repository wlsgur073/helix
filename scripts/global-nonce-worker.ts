// Calls globalScopeNonce(home) once (racing a barrier) and writes the result to outFile, to test the
// double-checked mint under REAL cross-process concurrency. Test-only (bundled by
// ownership-concurrency.test.ts, never shipped in bin/). ASCII only. Argv:
//   node worker.mjs <home> <goFile> <readyFile> <outFile>
import { existsSync, writeFileSync } from 'node:fs';
import { globalScopeNonce } from '../src/memory/ownership.js';

const home = process.argv[2]!;
const goFile = process.argv[3]!;
const readyFile = process.argv[4]!;
const outFile = process.argv[5]!;

writeFileSync(readyFile, 'ready');
while (!existsSync(goFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
writeFileSync(outFile, String(globalScopeNonce(home)));
