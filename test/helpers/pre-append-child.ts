// Child of test/memory/pre-append-checks.test.ts (never a *.test.ts). Bundled by bundleCli and run under plain node with a
// hard deadline by the test: a FIFO read by a plain open would stop this thread, and no vitest timeout interrupts open(2).
// usage: <mode> <path-or-home> [id]
//   look <lockPath>      -> lockPathHoldsForeignObject(lockPath)
//   assert <home>        -> assertWitnessWritable(home, 'commit', { homeUnchecked: true })
//   commit <home>        -> handleCommit over a MemoryStore on <home>/memory.jsonl (the global ledger), scope global
//   erase <home> <id>    -> handleErase, audit at <home>/audit.jsonl
//   confirm <home> <id>  -> handleConfirm, audit at <home>/audit.jsonl
// Prints ONE JSON line.
import { join } from 'node:path';
import * as lock from '../../src/memory/lock.js';
import { assertWitnessWritable, isRecordStoredError, isWitnessUnusableError } from '../../src/memory/witness-store.js';
import { MemoryStore } from '../../src/memory/store.js';
import { handleCommit, handleErase, handleConfirm } from '../../src/server/handlers.js';

const [mode, target, id] = process.argv.slice(2) as [string, string, string | undefined];
const out = (o: object): void => { process.stdout.write(JSON.stringify(o) + '\n'); };
let n = 0;
const storeOver = (home: string): MemoryStore =>
  new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 'pa-child', now: () => '2026-11-08T00:00:00.000Z', genId: () => `c_${++n}` });

try {
  if (mode === 'look') {
    if (typeof lock.lockPathHoldsForeignObject !== 'function') throw new TypeError('lockPathHoldsForeignObject is not exported');   // the namespace import keeps the child bundlable before the export exists
    out({ outcome: 'RETURNED', holds: lock.lockPathHoldsForeignObject(target) });
  } else {
    if (mode === 'assert') assertWitnessWritable(target, 'commit', { homeUnchecked: true });
    else if (mode === 'commit') handleCommit(storeOver(target), { content: 'a child fact', source: 'user', scope: 'global' });
    else if (mode === 'erase') handleErase(storeOver(target), { id: id! }, { auditPath: join(target, 'audit.jsonl') });
    else if (mode === 'confirm') handleConfirm(storeOver(target), { id: id! }, { auditPath: join(target, 'audit.jsonl') });
    else throw new Error(`unknown mode ${mode}`);
    out({ outcome: 'RETURNED' });
  }
} catch (e) {
  out({ outcome: 'THREW', name: (e as Error).name, message: (e as Error).message, foreign: lock.isLockForeignObjectError(e), stored: isRecordStoredError(e), unusable: isWitnessUnusableError(e) });
}
