/** Candidate-universe artifact (C5.1 closure item 2).
 *
 *  `o67-class-rule-2026-07.md` §6 requires that at window close, BEFORE scoring, the candidate
 *  universe be generated and hashed — hashing what the system COULD have returned before anyone
 *  reads what it DID rank. Nothing emitted it: the classifier built its pool inline and wrote only
 *  verdicts. This module is that emission capability; the artifact itself is still produced at
 *  window close.
 *
 *  Identity is the PAIR (scope, record-id) per rule §4, carried as the canonical string
 *  `<scope>:<id>`. That form is unambiguous — MemoryScope is 'global' | 'project' and record ids
 *  are `m_<uuid>`, so neither side contains a colon and the first colon always splits it — and it
 *  keeps set semantics (dedup, ordering, equality) obviously correct.
 */
import { readFileSync } from 'node:fs';
import type { MemoryScope } from '../../src/types.js';

export interface Candidate { id: string; scope: MemoryScope }

/** The rule's exposure unit as one comparable token. Split at the FIRST colon to invert. */
export const qualifiedId = (scope: MemoryScope, id: string): string => `${scope}:${id}`;

/** The per-probe identity SET of a full-size recall, sorted by IDENTITY.
 *
 *  Rule §3: "order is discarded and never recorded". That is an anti-peeking device, not a style
 *  choice — this artifact is hashed before scoring, so ordering it by rank would leak ranking into
 *  it. Sorting by code unit (never `localeCompare`, which is locale-dependent and would make the
 *  hash environment-dependent) gives a stable total order that carries no retrieval information.
 *
 *  Fails closed on a repeated record id: `store.recall` resolves an item's scope through an
 *  id-keyed, last-wins map (`src/memory/store.ts:523,529`), so when one id appears twice BOTH
 *  copies carry a single scope tag. Emitting either would assert something the code cannot
 *  justify, and this artifact's whole purpose is to be relied on later.
 */
export const probeUniverse = (candidates: Candidate[]): string[] => {
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.id)) {
      throw new Error(`candidate-id-collision: record id ${c.id} appears more than once in one probe's recall; ` +
        'its scope tag is not trustworthy (store.ts resolves scope through an id-keyed map), so the universe is not emitted');
    }
    seen.add(c.id);
  }
  return candidates.map((c) => qualifiedId(c.scope, c.id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};

/** Non-empty lines of one scope's ledger — ABSENT is empty, UNREADABLE is fatal.
 *
 *  Rule §3 requires a full-size recall, and the bound that makes it full-size is the physical row
 *  count. Because every live record is exactly one row, a CORRECT bound can never truncate. So the
 *  hazard is a bound computed too SMALL, and `classify-o67.ts` used to produce exactly that: it
 *  caught every read error and returned 0, letting an unreadable or relocated ledger silently
 *  shrink the recall. Absent is still zero (a snapshot need not carry a global ledger); unreadable
 *  is refused. This closes one loss channel, not the largest — see assertScopeParticipated.
 */
const readLedgerLines = (path: string): string[] => {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`ledger-unreadable: ${path} exists but could not be read (${(e as Error).message}); ` +
      'counting it as zero rows would silently shrink the recall bound');
  }
  return text.split('\n').filter(Boolean);
};

/** Physical row count of one scope's ledger. */
export const countLedgerRows = (path: string): number => readLedgerLines(path).length;

/** Snapshot preconditions, checked ONCE before any probe runs.
 *
 *  Identity uniqueness is a property of the CORPUS, not of one recall result. Checking it per probe
 *  is unsound: the scope tag is decided by an id-keyed, last-wins map built BEFORE recall's
 *  relevance filter (`store.ts:523` then `retrieval.ts:373`), so when a colliding id has only one
 *  copy survive that filter, no duplicate is ever visible downstream and the emitted identity
 *  carries the scope of the copy that did NOT survive. Rule §4 makes any snapshot error a gate
 *  failure, so a colliding corpus is refused outright rather than classified.
 */
export const corpusPrecondition = (
  ledgers: Array<{ scope: MemoryScope; path: string }>,
): { bound: number; rowsByScope: Record<string, number> } => {
  const rowsByScope: Record<string, number> = {};
  const owner = new Map<string, MemoryScope>();
  for (const { scope, path } of ledgers) {
    const ids = readLedgerLines(path).map((l) => (JSON.parse(l) as { id: string }).id);
    rowsByScope[scope] = ids.length;
    for (const id of ids) {
      const prior = owner.get(id);
      if (prior !== undefined && prior !== scope) {
        throw new Error(`corpus-id-collision: record id ${id} appears in both the ${prior} and ${scope} ledgers; ` +
          'the store resolves an item\'s scope through an id-keyed map, so neither copy can be identified reliably');
      }
      owner.set(id, scope);
    }
  }
  const bound = Object.values(rowsByScope).reduce((a, b) => a + b, 0);
  if (bound === 0) {
    throw new Error(`empty-recall-bound: no rows found across ${ledgers.length} ledger path(s); ` +
      'there is no corpus to enumerate a candidate universe from');
  }
  return { bound, rowsByScope };
};

/** Refuse a run whose bound counts rows from a scope that never actually served.
 *
 *  This is the LARGER loss channel, and it hides on the path rule §6 prescribes: window close says
 *  "snapshot the cutoff corpus", but ownership is keyed on the canonical ABSOLUTE path
 *  (`src/memory/ownership.ts`), so copying a snapshot un-adopts its project scope. Recall then drops
 *  that scope entirely while its rows still count toward the bound — producing a well-formed,
 *  correctly-hashed artifact that is indistinguishable from a genuinely small corpus.
 */
export const assertScopeParticipated = (
  rowsByScope: Record<string, number>,
  projectDisposition: string,
): void => {
  if ((rowsByScope.project ?? 0) > 0 && projectDisposition !== 'owned') {
    throw new Error(`scope-did-not-participate: the project ledger contributed ${rowsByScope.project} rows to the ` +
      `recall bound but its disposition is '${projectDisposition}', so recall served none of them. ` +
      'A relocated or un-adopted snapshot yields a global-only universe that looks like a small corpus');
  }
};
