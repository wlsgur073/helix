// Test-only worker (bundled by test/memory/first-commit-race.test.ts, never shipped in bin/). ASCII only.
// Commits one fact to a project through its own MemoryStore once the barrier file exists, and writes the outcome to
// a result file. Argv: node worker.mjs <home> <root> <goFile> <readyFile> <resultFile> <tag>
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/store.js';
import { projectLedgerPath } from '../src/memory/ownership.js';

const [home, root, goFile, readyFile, resultFile, tag] = process.argv.slice(2) as [string, string, string, string, string, string];
const store = new MemoryStore(join(home, 'memory.jsonl'), {
  home, sessionId: `s-${tag}`, genId: () => `m_${tag}`, project: { root, ledger: projectLedgerPath(root) },
});
writeFileSync(readyFile, 'ready');
while (!existsSync(goFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
try {
  store.commit({ content: `fact ${tag}`, source: 'user' });
  writeFileSync(resultFile, JSON.stringify({ ok: true }));
} catch (e) {
  writeFileSync(resultFile, JSON.stringify({ ok: false, text: String((e as Error).message).slice(0, 300) }));
}
