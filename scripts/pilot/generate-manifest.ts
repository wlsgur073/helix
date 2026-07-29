/** Manifest generator (protocol §enumeration). Ledger-side probes are fully mechanical; oracle-side
 *  probes take a MANUAL entry→record mapping supplied as a JSON file (adjudicated once, frozen with
 *  the manifest). Two shapes:
 *
 *    frozen   generate-manifest <snapshotDir> <oracleMd> <mappingJson> <out>
 *    holdout  generate-manifest --after <tx> <snapshotDir> <out>
 *
 *  Structure note (C5.1 block 1-4, 2026-07-28): the enumeration was lifted out of module top level
 *  into `buildProbes` behind a `main()` guard. It previously ran on import, so it could not be
 *  imported — no test could reach it, and it stayed outside the typecheck program (tsconfig covers
 *  src + test, and files enter only by being imported from there), which made C2.3's typecheck gate
 *  vacuous for exactly the file C5.1 items 3 and 4 rewrite.
 *
 *  Items 3 and 4 (2026-07-29) both hinge on ONE correction: the old code used a single row set for
 *  two different jobs. `live` was simultaneously the set probes are ENUMERATED FROM and the set a
 *  probe is checked for AMBIGUITY against, and those are not the same set.
 *
 *  - item 4 widens the COMPETITOR set to every scope. `run-pilot.ts` ranks against the merged
 *    global+project universe production recall actually serves, so a global near-duplicate is a
 *    real competitor; the project-only denominator called probes unambiguous that are not.
 *  - item 3 narrows the SOURCE by transaction time, and only the source: a record minted before
 *    the cutoff still competes for rank at scoring time, so removing it from the denominator would
 *    flatter the holdout precisely where the holdout is supposed to be hardest.
 *
 *  Merging scopes creates a cross-scope id collision surface the project-only set never had, so
 *  identity is handled two ways at once: the term map is keyed by the ROW OBJECT (exact by
 *  construction, never last-wins) and a colliding corpus is refused outright.
 *
 *  The only import from `src/` is a TYPE, erased at compile time. That is deliberate: the manifest
 *  stays a pure function of the pilot scripts' own bytes, so the protocol's §9a blob-hash pins
 *  still cover the whole frozen surface. Where that costs fidelity it is paid for explicitly —
 *  `liveRows` below carries the one closer type it used to be missing rather than importing
 *  `src/memory/projection.ts` for it. Behaviour is locked by test/pilot/generate-manifest.test.ts,
 *  test/pilot/generate-manifest-scope-cutoff.test.ts, and byte reproduction of both frozen
 *  manifests. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryScope } from '../../src/types.js';
import { topicTerms } from './derive.js';
import { segmentOracle } from './segment-oracle.js';

/** Production recall bound, pinned by the protocol (§9a, K = 20). */
export const K = 20;

/** The scope probes are enumerated FROM. Competitors come from every scope; probes do not —
 *  the pilot measures whether the project's own decisions are retrievable. */
export const ENUMERATED_SCOPE: MemoryScope = 'project';

export interface LedgerRow { id: string; type: string; content: string; supersedes: string | null; tx?: string }
export interface ScopedLedger { scope: MemoryScope; rows: LedgerRow[] }
export interface OracleInput { md: string; mapping: Record<string, string[]> }
export interface Probe { id: string; query: string; relevant: string[]; unambiguous: boolean; side: string }

interface ScopedRow extends LedgerRow { scope: MemoryScope }

/** Rows still open: an assert or supersede that nothing later closes.
 *
 *  `invalidate` belongs here for the same reason `supersede` and `erase` do — it is a marker that
 *  removes its referent, not a fact (`src/memory/projection.ts:26`). This function is a deliberate
 *  re-statement of that rule rather than a call into it: see the header note on staying a pure
 *  function of pinned bytes. It is the ONE place the two could drift, so it is written to agree. */
export const liveRows = (rows: LedgerRow[]): LedgerRow[] => {
  const closed = new Set(rows
    .filter((r) => r.type === 'supersede' || r.type === 'invalidate' || r.type === 'erase')
    .map((r) => r.supersedes).filter(Boolean) as string[]);
  return rows.filter((r) => (r.type === 'assert' || r.type === 'supersede') && !closed.has(r.id));
};

/** `YYYY-MM-DDTHH:MM:SS.sssZ` — the fixed-width UTC form `Date.prototype.toISOString` emits.
 *  Only in that form does string `>` order instants correctly, which is why anything else is
 *  refused rather than coerced: a shorter or offset-bearing stamp would compare silently wrong. */
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const canonical = (label: string, value: string | undefined): string => {
  // The round-trip catches what the pattern cannot: `2026-02-30T00:00:00.000Z` is well-formed and
  // not a date, and Date would quietly roll it forward into March.
  if (value === undefined || !CANONICAL_UTC.test(value) || new Date(value).toISOString() !== value) {
    throw new Error(`non-canonical-${label}: ${String(value)} is not a canonical UTC instant ` +
      '(YYYY-MM-DDTHH:MM:SS.sssZ); the cutoff comparison is a string comparison and only that form orders correctly');
  }
  return value;
};

/** The frozen enumeration: ledger-side probes, then the mapped oracle entries.
 *
 *  Pure over its inputs — no filesystem — so the cutoff and the denominator can be driven from
 *  tests instead of from a CLI. `txAfter` selects the temporal holdout (`pilot-protocol.md` §7):
 *  ledger records whose `tx` is strictly later than the method-freeze commit's authored time. */
export const buildProbes = (ledgers: ScopedLedger[], oracle: OracleInput | null, txAfter?: string): Probe[] => {
  if (txAfter !== undefined && oracle !== null) {
    throw new Error('holdout-with-oracle: a transaction-time cutoff selects a ledger-only population ' +
      '(pilot-protocol.md §7). Oracle entries are not ledger records and carry no tx, so no cutoff can date them');
  }

  // Liveness resolves WITHIN a scope: each scope is its own ledger file and a closer never reaches
  // across them, so merging first would let one scope's supersede row close another's record.
  const competitors: ScopedRow[] = ledgers.flatMap(({ scope, rows }) =>
    liveRows(rows).map((r) => ({ ...r, scope })));

  const byId = new Map<string, ScopedRow>();
  for (const r of competitors) {
    const prior = byId.get(r.id);
    if (prior !== undefined) {
      throw new Error(`identity-collision: record id ${r.id} is live more than once (${prior.scope}, ${r.scope}). ` +
        'A bare id no longer identifies one record, so neither the competitor test nor the manifest\'s ' +
        '`relevant` ids can name what they mean');
    }
    byId.set(r.id, r);
  }

  // Keyed by the row OBJECT, not its id: an id-keyed map is last-wins, and with two scopes merged
  // that would drop one competitor's vocabulary and move a probe INTO the unambiguous subset —
  // breaking monotonicity in the flattering direction. Same defect class as src/memory/store.ts:523.
  const termsOf = new Map<ScopedRow, Set<string>>(competitors.map((r) => [r, new Set(topicTerms(r.content))]));
  const unambiguous = (relevant: string[], q: string[]): boolean => {
    if (relevant.length !== 1) return false;
    const target = byId.get(relevant[0]!);
    return !competitors.some((r) => r !== target && q.filter((t) => termsOf.get(r)!.has(t)).length >= 3);
  };

  let source = competitors.filter((r) => r.scope === ENUMERATED_SCOPE);
  if (txAfter !== undefined) {
    const after = canonical('cutoff', txAfter);
    source = source.filter((r) => canonical('tx', r.tx) > after);   // STRICT: the cutoff instant is not in the holdout
  }

  const probes: Probe[] = source.map((r) => {
    const q = topicTerms(r.content);
    return { id: `L_${r.id}`, query: q.join(' '), relevant: [r.id], unambiguous: unambiguous([r.id], q), side: 'ledger' };
  });
  if (oracle !== null) {
    const { entries } = segmentOracle(oracle.md);
    entries.forEach((e, i) => {
      if (e.excluded) return;
      // Keyed on the FULL entry index, excluded entries included — an exclusion must not renumber
      // the entries after it, or the frozen mapping file stops addressing the same entries.
      const relevant = oracle.mapping[String(i)] ?? [];
      const q = topicTerms(e.text);
      probes.push({ id: `O_${i}`, query: q.join(' '), relevant, unambiguous: unambiguous(relevant, q), side: 'oracle' });
    });
  }
  return probes;
};

/** One scope's ledger. ABSENT is fatal, not empty: a snapshot copied without its global ledger
 *  produces a well-formed manifest whose probes are unambiguous only because their competitors
 *  were never read — indistinguishable, afterwards, from a corpus that genuinely has none. */
export const readLedger = (path: string): LedgerRow[] => {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`ledger-unreadable: ${path} (${(e as Error).message}). Every scope recall serves must be ` +
      'present, or the unambiguity denominator is narrower than the universe the runner ranks against');
  }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as LedgerRow);
};

/** The snapshot layout run-pilot.ts also reads: home/ is the global scope, proj/ the project. */
export const readSnapshot = (snapshotDir: string): ScopedLedger[] => [
  { scope: 'global', rows: readLedger(join(snapshotDir, 'home', 'memory.jsonl')) },
  { scope: 'project', rows: readLedger(join(snapshotDir, 'proj', '.helix', 'memory.jsonl')) },
];

const USAGE = 'usage: generate-manifest <snapshotDir> <oracleMd> <mappingJson> <out>\n' +
  '       generate-manifest --after <tx> <snapshotDir> <out>';

/** Key order is part of the artifact's bytes. The frozen form is exactly `{ k, probes }` and must
 *  stay byte-reproducible, so `txAfter` appears only when a cutoff was actually given — which is
 *  also how a holdout manifest self-identifies. */
const write = (outPath: string, probes: Probe[], txAfter?: string): void => {
  writeFileSync(outPath, JSON.stringify(txAfter === undefined ? { k: K, probes } : { k: K, txAfter, probes }, null, 1) + '\n');
  const ledgerCount = probes.filter((p) => p.side === 'ledger').length;
  console.log(`probes: ${probes.length} (ledger ${ledgerCount}, oracle ${probes.length - ledgerCount}); unambiguous: ${probes.filter((p) => p.unambiguous).length}`);
};

const main = (): void => {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf('--after');
  if (flag !== -1) {
    // The holdout form takes NO oracle arguments: "the holdout has no oracle side" is then a
    // property of the interface rather than a rule someone has to remember. Arity is checked
    // EXACTLY, not as a minimum — the two shapes overlap such that passing the frozen form's
    // arguments here would line the oracle path up with the output slot and overwrite a
    // hash-pinned artifact.
    const txAfter = argv[flag + 1];
    const rest = [...argv.slice(0, flag), ...argv.slice(flag + 2)];
    const [snapshotDir, outPath] = rest;
    if (rest.length !== 2 || !txAfter || !snapshotDir || !outPath) { console.error(USAGE); process.exit(2); }
    write(outPath, buildProbes(readSnapshot(snapshotDir), null, txAfter), txAfter);
    return;
  }
  const [snapshotDir, oraclePath, mappingPath, outPath] = argv;
  if (argv.length !== 4 || !snapshotDir || !oraclePath || !mappingPath || !outPath) { console.error(USAGE); process.exit(2); }
  const mapping = JSON.parse(readFileSync(mappingPath, 'utf8')) as Record<string, string[]>; // entryIndex -> record ids
  write(outPath, buildProbes(readSnapshot(snapshotDir), { md: readFileSync(oraclePath, 'utf8'), mapping }));
};
if (process.argv[1] && process.argv[1].endsWith('generate-manifest.ts')) main();
