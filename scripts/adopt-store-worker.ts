// Adopts a project through MemoryStore.adopt in its own process, gated on a barrier file so the test decides the moment.
// Test-only (bundled by adopt-gate.test.ts, never shipped in bin/). ASCII only. Argv:
//   node adopt-store-worker.mjs <home> <projectRoot> <goFile> <readyFile> <resultFile>
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/store.js';
import { projectLedgerPath } from '../src/memory/ownership.js';

const [home, root, goFile, readyFile, resultFile] = process.argv.slice(2) as [string, string, string, string, string];
writeFileSync(readyFile, 'ready');
while (!existsSync(goFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's-child', project: { root, ledger: projectLedgerPath(root) } });
try {
  store.adopt(root);
  writeFileSync(resultFile, 'adopted');
} catch (e) {
  writeFileSync(resultFile, `refused: ${String((e as Error).message).slice(0, 200)}`);
}
