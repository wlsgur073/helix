// Task 6 — rewrites plant fences + journal with supersession; startup heal; erase/auto-compact
// integrated (spec 2026-07-17-high-water-counter-decision §4.9). These SIX tests are the
// release-blocking regression locks for the R1-F1 prefix-resurrection defense (and its siblings).
// Driven over a REAL MemoryStore + real ledger files, so a serialization drift, a missing fence, or a
// skipped witness transition is observable end to end.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryRecord } from '../../src/types.js';
import { MemoryStore } from '../../src/memory/store.js';
import {
  compactLedger, planCompaction, witnessFenceRecord, readLedgerBytes, parseLedger,
} from '../../src/memory/ledger.js';
import { realFsOps, type DurableFsOps } from '../../src/memory/fs-ops.js';
import {
  planTransition, openTransition, completeTransition, advanceWitness, readScopeWitness, scopeKeyOf,
  witnessPath, witnessLogPath, WitnessAdvanceError,
} from '../../src/memory/witness-store.js';
import { readLedgerWitnessed } from '../../src/memory/witness-read.js';
import { sha256Hex } from '../../src/memory/witness-core.js';

function newHome(): string { return mkdtempSync(join(tmpdir(), 'helix-witrewrite-')); }
const FIXED = '2026-07-18T00:00:00.000Z';

/** A store with a fixed clock over a fresh tmp home (no project layer, so scope key is '@global'). */
function makeStore(home: string): MemoryStore {
  return new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 't', now: () => FIXED });
}

describe('Task 6 — witnessed rewrites', () => {
  it('permanent erase on a witnessed scope: post-state in-sync, last row is a fence, erased row gone, epoch bumped, witness-log has the erase line', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = makeStore(home);
      const a = store.commit({ content: 'alpha fact', source: 'user' });
      const b = store.commit({ content: 'bravo fact', source: 'user' });
      const c = store.commit({ content: 'charlie tail fact', source: 'user' });
      const epochBefore = readScopeWitness(home, '@global').entry!.epoch;

      store.erase(c.id, { permanent: true, scope: 'global' });

      const records = parseLedger(ledger);
      // erased row + its plaintext gone; survivors present
      expect(records.some((r) => r.id === c.id)).toBe(false);
      expect(records.some((r) => r.content === 'charlie tail fact')).toBe(false);
      expect(records.some((r) => r.id === a.id)).toBe(true);
      expect(records.some((r) => r.id === b.id)).toBe(true);
      // last physical row is the epoch fence
      expect(records[records.length - 1]!.id.startsWith('witness_fence_')).toBe(true);
      // the rewrite advanced the witness with the file: in-sync, epoch bumped
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('in-sync');
      expect(readScopeWitness(home, '@global').entry!.epoch).toBeGreaterThan(epochBefore);
      // the witness-log carries the erase-kind transition line
      const log = readFileSync(witnessLogPath(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; scope: string });
      expect(log.some((l) => l.kind === 'erase' && l.scope === '@global')).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('R1-F1 prefix resurrection: restoring pre-erase bytes over a rewritten ledger yields MISMATCH (fence + rewrite make the old file non-prefix)', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = makeStore(home);
      store.commit({ content: 'alpha fact', source: 'user' });
      store.commit({ content: 'bravo fact', source: 'user' });
      const c = store.commit({ content: 'charlie tail fact', source: 'user' });

      // Capture the EXACT pre-erase file bytes and confirm the witness is in-sync with them.
      const preErase = readLedgerBytes(ledger);
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('in-sync');

      // Permanent-erase the TAIL row — a real witnessed rewrite (fence planted, witness advanced).
      store.erase(c.id, { permanent: true, scope: 'global' });
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('in-sync'); // witness moved with the rewrite

      // ATTACK: overwrite the ledger with the captured pre-erase bytes (resurrect the old superset,
      // erased plaintext and all). The witness now attests the post-rewrite head; the restored old file
      // is neither that head nor a prefix of it, so the resurrection is caught as a MISMATCH and never
      // laundered into an in-sync / unwitnessed-suffix (advance-allowed) state.
      writeFileSync(ledger, preErase);
      expect(preErase.toString('utf8')).toContain('charlie tail fact'); // the attack really landed
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('mismatch');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('crash window A (interrupted before rename): openTransition journaled, rename throws, ledger stays OLD -> transition-interrupted; re-drive supersedes the stale slot -> in-sync', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = makeStore(home);
      store.commit({ content: 'alpha fact deploy', source: 'user' });
      store.commit({ content: 'bravo fact deploy', source: 'user' });
      const oldBytes = readLedgerBytes(ledger);

      // Injected fsOps whose renameSync throws: compactLedger throws AFTER openTransition has journaled,
      // and its catch-block unlinks the tmp, leaving the ledger at OLD bytes (the new head never landed).
      const faultyFs: DurableFsOps = { ...realFsOps, renameSync: () => { throw new Error('injected rename failure (crash window A)'); } };
      expect(() => compactLedger(ledger, {
        erasedIds: new Set(),
        witness: { home, scopeKey: '@global', now: () => '2026-07-18T00:01:00.000Z', kind: 'compaction' },
        fsOps: faultyFs,
      })).toThrow(/injected rename failure/);

      expect(readLedgerBytes(ledger).equals(oldBytes)).toBe(true);                       // ledger untouched
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('transition-interrupted'); // journal pending, OLD bytes

      // RE-DRIVE the real compaction: planTransition sees the interrupted journal and SUPERSEDES it
      // (new epoch one past the stale slot), lands the new head, completes -> in-sync, slot cleared.
      compactLedger(ledger, {
        erasedIds: new Set(),
        witness: { home, scopeKey: '@global', now: () => '2026-07-18T00:02:00.000Z', kind: 'compaction' },
      });
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('in-sync');
      expect(readScopeWitness(home, '@global').journal).toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('crash window B (interrupted after rename, before complete): journal pending + NEW bytes -> transition-heal; the next witnessed append heals first, then lands its row', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = makeStore(home);
      store.commit({ content: 'alpha fact deploy', source: 'user' });
      store.commit({ content: 'bravo fact deploy', source: 'user' });

      // Simulate a crash AFTER the rename landed the new bytes but BEFORE completeTransition — plan +
      // open the transition, write the exact rewrite bytes to the ledger ourselves, and stop.
      const { kept } = planCompaction(parseLedger(ledger), { erasedIds: new Set() });
      const plan = planTransition(home, '@global', 'compaction');
      const fence = witnessFenceRecord(plan.epoch, plan.nonce, '2026-07-18T00:01:00.000Z');
      const finalText = kept.concat(fence).map((r) => JSON.stringify(r) + '\n').join('');
      const expected = { byteLength: Buffer.byteLength(finalText), prefixHash: sha256Hex(Buffer.from(finalText)) };
      const journal = openTransition(home, '@global', {
        kind: 'compaction', epoch: plan.epoch, nonce: plan.nonce, predecessor: plan.predecessor,
        supersedes: plan.supersedes, expected, tx: fence.tx,
      });
      writeFileSync(ledger, finalText);                                          // the rename "landed"
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('transition-heal');

      // A witnessed append (Task 5 store.commit) resolves the pending transition FIRST, then appends.
      const post = store.commit({ content: 'charlie fact deploy', source: 'user' });

      const after = readScopeWitness(home, '@global');
      expect(after.journal).toBeNull();                    // healed: slot cleared
      expect(after.entry!.epoch).toBe(journal.epoch);      // entry advanced to the journal's epoch
      expect(parseLedger(ledger).some((r) => r.id === post.id)).toBe(true); // then the new row landed
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('in-sync');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('R1-F2 stale/replayed journal: completeTransition refuses bytes that do not exactly match the journaled head, so a replayed OLD ledger can never lower or mis-set the witness', () => {
    // NOTE: a journal the witness has ALREADY passed (epoch <= entry) is refused by completeTransition's
    // staleness guard (entry.epoch >= journal.epoch), covered by witness-store.test.ts "journal never
    // lowers". This test locks the COMPLEMENTARY defense — the exact-bytes guard — because that is the
    // one Step-5's mutation drops: a still-pending journal AHEAD of the entry (so staleness does NOT
    // pre-empt) must not be completable by REPLAYED bytes that differ from its promised head.
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = makeStore(home);
      store.commit({ content: 'alpha fact', source: 'user' });
      store.commit({ content: 'bravo fact', source: 'user' });
      const b0 = readLedgerBytes(ledger);
      const e0 = readScopeWitness(home, '@global').entry!;   // the current witnessed head

      // Open a FRESH transition AHEAD of the entry (epoch e0+1) promising a NEW head T that never lands.
      const plan = planTransition(home, '@global', 'compaction');
      expect(plan.epoch).toBeGreaterThan(e0.epoch);          // ahead: the staleness guard cannot pre-empt
      const targetText = b0.toString('utf8')
        + JSON.stringify(witnessFenceRecord(plan.epoch, plan.nonce, '2026-07-18T00:05:00.000Z')) + '\n';
      const expected = { byteLength: Buffer.byteLength(targetText), prefixHash: sha256Hex(Buffer.from(targetText)) };
      openTransition(home, '@global', {
        kind: 'compaction', epoch: plan.epoch, nonce: plan.nonce, predecessor: plan.predecessor,
        supersedes: plan.supersedes, expected, tx: '2026-07-18T00:05:00.000Z',
      });

      // The ledger still holds the OLD bytes b0 (rewrite never landed) — a replay of the pre-transition
      // ledger. b0 does NOT match the journal's promised head T. verdict: transition-interrupted.
      expect(readLedgerBytes(ledger).equals(b0)).toBe(true);
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('transition-interrupted');

      // completeTransition MUST refuse b0: it is not the exact head the journal promised. Dropping the
      // exact-bytes equality (Step 5's mutation) would let the replayed b0 complete the journal and
      // mis-set the witness to T — a head that was never written.
      expect(() => completeTransition(home, '@global', b0, '2026-07-18T00:06:00.000Z')).toThrow(WitnessAdvanceError);

      // The witness entry is UNCHANGED and the journal is still pending (refused, not applied).
      const after = readScopeWitness(home, '@global');
      expect(after.entry!.epoch).toBe(e0.epoch);
      expect(after.entry!.byteLength).toBe(e0.byteLength);
      expect(after.entry!.prefixHash).toBe(e0.prefixHash);
      expect(after.journal).not.toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('healWitness: completes a pending transition-heal at startup; leaves a mismatch scope untouched', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = makeStore(home);
      store.commit({ content: 'alpha fact', source: 'user' });
      store.commit({ content: 'bravo fact', source: 'user' });

      // Case A: a pending transition-heal (crash window B state) -> healWitness completes it.
      const { kept } = planCompaction(parseLedger(ledger), { erasedIds: new Set() });
      const plan = planTransition(home, '@global', 'compaction');
      const fence = witnessFenceRecord(plan.epoch, plan.nonce, '2026-07-18T00:01:00.000Z');
      const finalText = kept.concat(fence).map((r) => JSON.stringify(r) + '\n').join('');
      const expected = { byteLength: Buffer.byteLength(finalText), prefixHash: sha256Hex(Buffer.from(finalText)) };
      const journal = openTransition(home, '@global', {
        kind: 'compaction', epoch: plan.epoch, nonce: plan.nonce, predecessor: plan.predecessor,
        supersedes: plan.supersedes, expected, tx: fence.tx,
      });
      writeFileSync(ledger, finalText);
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('transition-heal');

      store.healWitness();

      const healed = readScopeWitness(home, '@global');
      expect(healed.journal).toBeNull();
      expect(healed.entry!.epoch).toBe(journal.epoch);
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('in-sync');

      // Case B: a mismatch scope (old/forked bytes, no pending journal) -> healWitness does nothing.
      writeFileSync(ledger, 'not the witnessed bytes\n');
      const before = readScopeWitness(home, '@global');
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('mismatch');
      store.healWitness();
      expect(readScopeWitness(home, '@global')).toEqual(before);
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('mismatch');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  // Fix loop 1 (reviewer): the R1-F1 erase-path test above asserts mismatch, but that mismatch is
  // OVER-DETERMINED (the erase rewrite also adds a tombstone + horizon marker and shortens the head vs
  // the restored superset), so it stays green even with the fence removed. These two tests isolate the
  // fence's ACTUAL security property (spec §4.9): the unpredictable per-rewrite nonce is what makes the
  // post-rewrite head un-prefixable by any pre-existing file.

  it('R1-F1 fence ISOLATION: the fence row is the SOLE thing that converts a laundered-benign restore into a caught rollback', () => {
    const home = newHome();
    try {
      const mkRec = (id: string, content: string): MemoryRecord => ({
        id, tx: FIXED, validFrom: FIXED, validTo: null, type: 'assert', state: 'Fresh', content,
        provenance: { source: 'user', sessionId: 't' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
      });
      // Two real kept rows, serialized exactly as the ledger writes them.
      const kept = [mkRec('m_1', 'alpha kept row'), mkRec('m_2', 'bravo kept row')];
      const K = kept.map((r) => JSON.stringify(r) + '\n').join('');
      // A restored OLD file = the same two rows PLUS one extra (dead/resurrected) row. This is a benign
      // append-shaped restore: without a fence in the witnessed head it classifies as unwitnessed-suffix
      // (advance-allowed — laundered). extraRow is a real row, never equal to the fence.
      const extraRow = mkRec('m_extra', 'resurrected dead tail row');
      const oldFile = Buffer.from(K + JSON.stringify(extraRow) + '\n');

      // --- WITH the fence: witness a head that ENDS in an unpredictable fence, then restore oldFile. ---
      const ledger = join(home, 'memory.jsonl');
      const nonce = randomBytes(16).toString('hex');               // a real 32-hex per-rewrite nonce
      const fence = witnessFenceRecord(1, nonce, FIXED);
      const headBytes = Buffer.from(K + JSON.stringify(fence) + '\n');
      writeFileSync(ledger, headBytes);
      advanceWitness(home, scopeKeyOf(home), headBytes, FIXED);    // fresh scope -> first-contact -> witnesses K+fence
      writeFileSync(ledger, oldFile);
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('mismatch'); // the fence makes oldFile non-prefix -> CAUGHT

      // --- COUNTERFACTUAL: the SAME oldFile, but the witnessed head is K WITHOUT the fence. ---
      const projectRoot2 = join(home, 'proj2');                    // a distinct scope in the same home
      const scopeKey2 = scopeKeyOf(home, projectRoot2);
      const ledger2 = join(home, 'ledger2.jsonl');
      writeFileSync(ledger2, K);
      advanceWitness(home, scopeKey2, Buffer.from(K), FIXED);      // witnesses K only (no fence)
      writeFileSync(ledger2, oldFile);
      expect(readLedgerWitnessed(ledger2, home, projectRoot2).verdict.kind).toBe('unwitnessed-suffix'); // LAUNDERED
      // The ONLY difference between the two branches is whether the witnessed head ended in the fence —
      // so the fence bytes are provably the sole converter from 'unwitnessed-suffix' (benign) to 'mismatch'.
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('R1-F1 fence FRESHNESS: two successive production rewrites plant fences with DIFFERENT nonces and a strictly higher epoch (catches a constant nonce)', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = makeStore(home);
      const a = store.commit({ content: 'alpha fact', source: 'user' });
      void a;
      const b = store.commit({ content: 'bravo fact', source: 'user' });
      const c = store.commit({ content: 'charlie fact', source: 'user' });

      store.erase(c.id, { permanent: true, scope: 'global' });          // rewrite 1 (production path)
      const fence1 = parseLedger(ledger).find((r) => r.id.startsWith('witness_fence_'))!;
      store.erase(b.id, { permanent: true, scope: 'global' });          // rewrite 2 (production path)
      const fence2 = parseLedger(ledger).find((r) => r.id.startsWith('witness_fence_'))!;

      // id === witness_fence_<epoch>_<nonce>
      const epoch1 = Number(fence1.id.split('_')[2]!); const nonce1 = fence1.id.split('_')[3]!;
      const epoch2 = Number(fence2.id.split('_')[2]!); const nonce2 = fence2.id.split('_')[3]!;
      expect(fence1.id).not.toBe(fence2.id);
      expect(nonce1).not.toBe(nonce2);                 // the per-rewrite nonce is FRESH (RED under a constant nonce)
      expect(nonce1.length).toBe(32);                  // a real 16-byte hex nonce, not a fixed sentinel
      expect(epoch2).toBeGreaterThan(epoch1);          // epoch is strictly monotonic across rewrites
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
