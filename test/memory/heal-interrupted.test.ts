// A crash — power loss, SIGKILL, a container stop — between openTransition() and renameSync() left
// the scope `transition-interrupted` forever: reads excluded it, writes threw, and startup heal did
// nothing for it. Recovery was an operator-only TTY ceremony, and on the global scope that darkened
// all memory until a human ran it.
//
// The reasoning that left it there was that "ledger bytes still hash to the predecessor" cannot be
// told apart from a rewrite that landed and was then deliberately rolled back. True, and it does not
// matter: the correct action is the SAME in both cases. Retracting the pending journal returns the
// scope to exactly the bytes it holds. If the rename never landed, that is the pre-rewrite state; if
// a rollback restored those bytes on purpose, that is what the rollback asked for. Nothing is
// re-driven, so nothing a rollback removed can come back.
//
// What startup must NOT do is retract a transition that actually completed — see
// interruptedAtPredecessor in witness-core for the lineage split this depends on.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { planTransition, openTransition, readScopeWitness } from '../../src/memory/witness-store.js';
import { readLedgerWitnessed } from '../../src/memory/witness-read.js';
import { sha256Hex } from '../../src/memory/witness-core.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'helix-heal-'));
  const ledger = join(home, 'memory.jsonl');
  const store = new MemoryStore(ledger, { home, sessionId: 's1' });
  store.commit({ content: 'the deploy runbook lives in docs/release', source: 'user' });
  return { home, ledger, store };
}

/** Journal a transition and then stop, exactly as a process death between open and rename leaves it. */
function strandAt(home: string, expectedBytes: Buffer): void {
  const p = planTransition(home, '@global', 'compaction');
  openTransition(home, '@global', {
    kind: 'compaction', epoch: p.epoch, nonce: p.nonce, predecessor: p.predecessor,
    supersedes: p.supersedes,
    expected: { byteLength: expectedBytes.length, prefixHash: sha256Hex(expectedBytes) },
    tx: '2026-08-11T00:00:00.000Z',
  });
}

describe('healWitness — a crashed compaction is retracted, not left dark', () => {
  it('retracts a transition whose rewrite never landed, and the scope works again', () => {
    const { home, ledger, store } = fixture();
    strandAt(home, Buffer.from('bytes this rewrite never produced\n', 'utf8'));

    expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('transition-interrupted');
    expect(readScopeWitness(home, '@global').journal).not.toBeNull();

    store.healWitness();

    expect(readScopeWitness(home, '@global').journal).toBeNull();      // retracted
    expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('in-sync');
    expect(store.inspect()).toHaveLength(1);                           // the scope is readable again
    expect(() => store.commit({ content: 'a fact written after recovery', source: 'user' })).not.toThrow();
  });

  it('does NOT retract when the bytes are on the expected lineage — that rewrite completed', () => {
    const { home, ledger, store } = fixture();
    // `expected` is a strict PREFIX of what the ledger holds, so the bytes carry the expected
    // lineage (a rewrite that landed and was appended to) as well as the predecessor's. Both
    // lineages match, the state is undecidable from disk, and startup must leave it for the
    // ceremony rather than guess. An `expected` equal to the current bytes would not test this —
    // that is an exact match, which classifies as transition-heal and completes.
    const current = readFileSync(ledger);
    strandAt(home, current.subarray(0, current.length - 1));

    store.healWitness();

    expect(readScopeWitness(home, '@global').journal).not.toBeNull();  // left alone, deliberately
    expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('transition-interrupted');
  });
});
