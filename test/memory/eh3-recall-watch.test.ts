// EH-3 watch — recall returns a SUBSET of the oracle (regression guardrail).
//
// Backlog: docs/superpowers/plans/2026-06-18-engine-hardening-backlog.md (EH-3).
// Provenance: the tinytask dogfood (2026-06-18, two autonomous runs). The agent's
// helix_memory_recall returned fewer items than the STATE.md oracle held — "fewer
// items than STATE holds, but nothing stale or wrong" (HELIX-FEEDBACK.md). It was
// filed as an OBSERVATION, not a confirmed defect: top-k lexical recall is SUPPOSED
// to return what is relevant to the query, not dump the whole ledger.
//
// This test freezes the real dogfood scenario — the exact 7-record ledger
// (.helix/memory.jsonl) and the two exact recall queries the agent issued — so the
// "subset" behavior is pinned and any drift forces a conscious review.
//
// WHAT WOULD PROMOTE EH-3 TO A REAL DEFECT (and fail this test):
//   recall stops returning an item the agent then NEEDS for the task. The "benign
//   subset" here omits only conventions that share ZERO query tokens AND whose facts
//   are not needed (or are carried redundantly by a returned record). If a future
//   scorer change drops `mutator`/`rm`/`verbfirst` for the rm-task query, that is the
//   EH-3 failure mode, and `recall surfaces every item the rm task needs` will fail.
//
// If the characterization snapshot below changes, that is a DELIBERATE scorer change:
// update the expected set AND re-evaluate whether EH-3 should be promoted or closed.

import { describe, it, expect } from 'vitest';
import {
  rankRecords, coverageScore, phraseScore, tokenize, meaningfulTokens,
} from '../../src/memory/retrieval.js';
import type { MemoryRecord } from '../../src/types.js';
import { loadExpansion, EXP_THETA, EXP_K, SEM_DISCOUNT, SEM_GATE } from '../../src/memory/expansion.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Verbatim record from the dogfood ledger (all Fresh, source=user, real tx for faithful tie-break). */
function ledgerRec(id: string, content: string, tx: string): MemoryRecord {
  return {
    id, tx, validFrom: tx, validTo: null, type: 'assert', state: 'Fresh', content,
    provenance: { source: 'user', sessionId: 'cli' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
  };
}

// Exact ledger from /mnt/c/Users/kim/helix-dogfood/tinytask/.helix/memory.jsonl (2026-06-18).
const LEDGER: MemoryRecord[] = [
  ledgerRec('storage', 'Storage is a local JSON file at ~/.tinytask/tasks.json.', '2026-06-18T12:51:01.954Z'),
  ledgerRec('iso', 'Timestamps are ISO 8601.', '2026-06-18T12:51:02.828Z'),
  ledgerRec('verbfirst', 'CLI commands are verb-first (add, list).', '2026-06-18T12:51:03.776Z'),
  ledgerRec('nodeps', 'No runtime dependencies; tests use vitest.', '2026-06-18T12:51:04.798Z'),
  ledgerRec('exit2', 'Exit code 2 on usage error.', '2026-06-18T12:51:05.618Z'),
  ledgerRec(
    'mutator',
    'tinytask: store mutator functions reject an unknown task id by throwing Error("task #<id> not found"); the CLI catches this and exits with code 2. First applied in completeTask for the `done <id>` command.',
    '2026-06-18T13:52:13.625Z',
  ),
  ledgerRec(
    'rm',
    'tinytask: `rm <id>` command hard-deletes a task. Implemented via store mutator removeTask(tasks, id), which throws Error("task #<id> not found") on unknown id (same contract as completeTask); the CLI catches and exits 2. removeTask filters the id out (true deletion), distinct from `done` which only marks done:true.',
    '2026-06-18T14:01:55.720Z',
  ),
];

// The two verbatim queries the dogfood agent issued (transcripts:
// ~/.claude/projects/C--Users-kim-helix-dogfood-tinytask).
const QUERY_RM_RUN = 'tinytask CLI conventions decisions commands store mutators';
const QUERY_NEXT_RUN = 'tinytask CLI conventions decisions storage commands done rm tags';

const idsOf = (recs: MemoryRecord[]): string[] => recs.map((r) => r.id).sort();
const ALL_IDS = idsOf(LEDGER);

describe('EH-3 watch: recall returns a subset of the oracle', () => {
  // (1) CHARACTERIZATION — freeze the real dogfood subset. Both queries return the
  // same 4 of 7 conventions and omit the same 3. This reproduces the observation.
  // A change here is a deliberate scorer change → update + re-evaluate EH-3.
  const RETURNED = ['mutator', 'rm', 'storage', 'verbfirst'];
  const OMITTED = ['exit2', 'iso', 'nodeps'];

  it('rm-task query returns exactly the 4-of-7 subset seen in the dogfood', () => {
    expect(idsOf(rankRecords(LEDGER, QUERY_RM_RUN))).toEqual(RETURNED);
  });

  it('next-run query returns the same 4-of-7 subset', () => {
    expect(idsOf(rankRecords(LEDGER, QUERY_NEXT_RUN))).toEqual(RETURNED);
  });

  // (2) PROMOTE-TRIGGER INVARIANT — the live watch. The dogfood agent was implementing
  // `rm <id>`; recall MUST surface the conventions that task needs: the verb-first
  // naming rule and the throw-on-unknown-id -> exit-2 store-mutator contract. If a
  // future scorer change drops these NEEDED items, EH-3 has become a real defect.
  it('recall surfaces every item the rm task needs (verb-first + the exit-2 throw contract)', () => {
    const got = rankRecords(LEDGER, QUERY_RM_RUN);
    const gotIds = got.map((r) => r.id);
    expect(gotIds).toContain('verbfirst');
    // the exit-2 / throw-on-unknown-id contract must be reachable via at least one record
    const hasExit2Contract = got.some(
      (r) => /exit/i.test(r.content) && /\b2\b/.test(r.content) && /throw/i.test(r.content),
    );
    expect(hasExit2Contract).toBe(true);
    expect(gotIds).toEqual(expect.arrayContaining(['mutator', 'rm']));
  });

  // (3) THE SUBSET IS BENIGN, NOT A SCORING ARTIFACT. Every omitted convention shares
  // ZERO meaningful tokens with both task queries (coverage 0 AND phrase 0) — it is
  // genuinely off-topic for these tasks, so dropping it is working-as-designed, not the
  // backlog's feared "coverage under-weights short single-fact items".
  it('every omitted convention has zero query overlap (genuine non-relevance, not a gate artifact)', () => {
    for (const q of [QUERY_RM_RUN, QUERY_NEXT_RUN]) {
      const qTerms = [...new Set(meaningfulTokens(tokenize(q)))];
      for (const id of OMITTED) {
        const rec = LEDGER.find((r) => r.id === id)!;
        expect(coverageScore(qTerms, tokenize(rec.content)), `${id} coverage for "${q}"`).toBe(0);
        expect(phraseScore(q, rec.content), `${id} phrase for "${q}"`).toBe(0);
      }
    }
  });

  it('no information loss: the dropped standalone exit-2 fact is carried by a returned record', () => {
    // `exit2` ("Exit code 2 on usage error.") drops, but the same fact lives inside the
    // returned mutator/rm records ("...the CLI catches this and exits with code 2"),
    // which is why the dogfood agent still had what it needed for the rm task.
    const got = rankRecords(LEDGER, QUERY_RM_RUN);
    expect(got.some((r) => /exits?\b.*\bcode 2\b|exits 2/i.test(r.content))).toBe(true);
  });

  // (4) COVERAGE-UNDER-WEIGHTING GUARD — the backlog's specific hypothesis. A short
  // single-fact item is NOT structurally penalized: when a query actually overlaps it,
  // `exit2` scores full coverage and is recalled. So shortness alone never drops an item.
  it('a short single-fact item survives when the query is on-topic for it', () => {
    const q = 'exit code on usage error';
    const qTerms = [...new Set(meaningfulTokens(tokenize(q)))];
    const exit2 = LEDGER.find((r) => r.id === 'exit2')!;
    expect(coverageScore(qTerms, tokenize(exit2.content))).toBeGreaterThan(0.5);
    expect(rankRecords(LEDGER, q).map((r) => r.id)).toContain('exit2');
  });

  it('sanity: the frozen ledger is the full 7-record oracle', () => {
    expect(ALL_IDS).toHaveLength(7);
  });
});

// EH-3 semantic recall (the new feature) layered on the SAME dogfood ledger. The lexical
// characterization above is unchanged (it passes no expansion); this block exercises the
// committed neighbor table. Per this file's contract, any change here is a DELIBERATE scorer change.
const EXP = loadExpansion(
  readFileSync(fileURLToPath(new URL('../../data/semantic-neighbors.json', import.meta.url)), 'utf8'),
  EXP_THETA, EXP_K);
const semOpts = { expansion: EXP, semDiscount: SEM_DISCOUNT, semGate: SEM_GATE };

describe('EH-3 with semantic expansion (the new feature)', () => {
  it('MONOTONIC: never drops a record the lexical engine returned (semantic only ADDS recall)', () => {
    // 7-record ledger < maxItems, so no top-k truncation can displace a lexical hit.
    const lex = new Set(rankRecords(LEDGER, QUERY_RM_RUN).map((r) => r.id));
    const sem = new Set(rankRecords(LEDGER, QUERY_RM_RUN, semOpts).map((r) => r.id));
    for (const id of lex) expect(sem.has(id), `dropped lexical hit ${id}`).toBe(true);
  });
  it('still satisfies the promote-trigger invariant (rm task needs verb-first + the throw contract)', () => {
    const ids = rankRecords(LEDGER, QUERY_RM_RUN, semOpts).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['mutator', 'rm', 'verbfirst']));
  });
  it('is deterministic: identical inputs -> identical ranking (exact replay)', () => {
    const a = rankRecords(LEDGER, QUERY_RM_RUN, semOpts).map((r) => r.id);
    const b = rankRecords(LEDGER, QUERY_RM_RUN, semOpts).map((r) => r.id);
    expect(a).toEqual(b);
  });
  it('FALLBACK: no expansion => byte-identical ranking to the lexical engine', () => {
    const withUndef = rankRecords(LEDGER, QUERY_RM_RUN, { expansion: undefined }).map((r) => r.id);
    const plain = rankRecords(LEDGER, QUERY_RM_RUN).map((r) => r.id);
    expect(withUndef).toEqual(plain);
  });
});
