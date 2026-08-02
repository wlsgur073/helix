/** Shared declarations for the two-phase reducer — types and frozen constants, no behaviour.
 *
 *  Both phases need these, and neither may import the other: `prepare-gate.ts` and `score-gate.ts`
 *  are both guarded by `isEntryPoint(import.meta.url)`, and that guard does not survive bundling
 *  (see `snapshot.ts` for the full account and `test/pilot/entry-point-isolation.test.ts` for the
 *  lock). Declaration modules have nothing to guard, so they are where shared surface lives. */
import type { MemoryScope } from '../../src/types.js';
import type { ProjectDisposition } from '../../src/memory/ownership.js';

export interface ManifestProbe { id: string; query: string; relevant: string[]; unambiguous: boolean; side: string }
export interface ClassifierVerdict {
  id: string;
  status: string;
  reason?: string;
  targetId?: string;
  targetScope?: MemoryScope;
  hit1Eligible: boolean;
  witnesses?: { id: string; extraTerms: string[] }[];
}

/** The frozen Hit@1 denominator. §3a keeps its three roles apart even though a ledger-only holdout
 *  makes them coincide: `identities` is the exposure unit, `probeIds` the metric denominator, and
 *  the success rule (every one of those rows ranks 1) belongs to the score phase. Recording them
 *  separately means the artifact shows the coincidence held rather than assuming it. */
export interface EligibleSet {
  probeIds: string[];      // sorted
  identities: string[];    // sorted, distinct, `<scope>:<record-id>`
  exposure: number;        // = identities.length
  label: string;
}

/** §3e — the O_67 class, reported without a threshold. No `E` denominator and no
 *  `PARTIALLY EXERCISED` state: both are defined only relative to a blocking minimum, and owner
 *  decision D-a removed that minimum. `blocking` is a constant rather than a computed value,
 *  because the class must not participate in the close rule at all — if it did, a window with zero
 *  in-class cases could never close, reintroducing exactly the starvation D-a removes. */
export interface O67Census {
  census: number;
  cases: { probeId: string; identity: string; hit1Eligible: boolean; witnesses: { id: string; extraTerms: string[] }[] }[];
  distinctInClassIdentities: number;
  eligibleInClass: number;
  label: string;
  blocking: false;
}

export interface StaleExposure { closerRelationships: number; label: string; blocking: boolean }

export interface Manifest { k: number; txAfter?: string; txClose?: string; probes: ManifestProbe[] }
export interface ClassifierOutput { rule: string; manifest: string; probes: ClassifierVerdict[] }
export interface UniverseDisclosure {
  rowsByScope: Record<string, number>;
  projectDisposition: string;
  integrityAvailable: boolean;
  witnessNotes: string[];
  expansionAvailable: boolean;
}
export interface UniverseArtifact {
  rule: string; artifact: string; manifest: string; recallBound: number;
  disclosure: UniverseDisclosure; probes: { id: string; candidates: string[] }[];
}

/** The method identity the run is supposed to be measured under, taken from the freeze receipt.
 *  Everything against it is compared, never reconciled. */
export interface Pins { k: number; txAfter: string; txClose: string; inputs: Record<string, string> }

/** Deterministic half of the prepared artifact — the half stability compares and the provenance
 *  chain links. Key order is fixed by construction because it is hashed. */
export interface GateSetPayload {
  rule: string;
  k: number;
  window: { txAfter: string; txClose: string };
  eligible: EligibleSet;
  recallDenominator: string[];
  o67: O67Census;
  stale: StaleExposure;
  disclosure: UniverseDisclosure;
  inputs: Record<string, string>;
}

/** Volatile half — real wall-clock facts, deliberately outside the hash. §5a: demanding byte
 *  identity of the whole artifact across three runs would contradict the integrity condition,
 *  which requires retaining exactly these. So stability compares `payloadSha256`, and the receipts
 *  are hashed into the provenance chain instead. The timestamp is self-reported and is evidence
 *  only as strong as that: §9's chain, item 4, calls for an append-only or externally attested
 *  receipt. (Not §5 — that section is "Sample unit, minimum, close, and the reported bound" and
 *  contains no chain at all. The wrong citation shipped inside `receipts.attestation`.) */
export interface GateSet {
  artifact: 'gate-set';
  payloadSha256: string;
  payload: GateSetPayload;
  receipts: { preparedAt: string; attestation: string };
}

/** One probe's outcome. Outcome-side data in its entirety: the prepare phase never sees this shape,
 *  and the score phase reads ranks from it but takes its denominator from `GateSetPayload`. It lives
 *  here rather than in `score-gate.ts` because the runner produces it and the scorer consumes it,
 *  and neither guarded CLI may import the other. */
export interface RunResult {
  id: string; query: string; unambiguous: boolean;
  bestRank: number | null; hitAtK: boolean; hitAt1: boolean; returned: string[];
}

/** Deterministic half of a runner output — the half stability compares.
 *
 *  `prepareSha256` is IN THE PAYLOAD and `runId` is in the receipts, and the placement is the whole
 *  design. §9's evidence chain (item 5) wants a runner output that embeds both, but the two behave
 *  oppositely under re-execution: the prepare hash is identical across every honest re-run of the
 *  same prepared gate set, while a run id differs by construction. Putting the prepare hash in the
 *  payload is exactly what makes "three stable runs" mean "three runs of the SAME frozen method"
 *  rather than "three runs that happened to agree"; putting a run id there would make the payload
 *  differ on every run and the Stability condition (§4) fail on every honest attempt. That is the
 *  coupling §9b records — the split and the scorer's payload-hash comparison are one change.
 *
 *  `manifestSha256` names the QUESTIONS, and it is a separate pin from `prepareSha256` because the
 *  two artifacts can disagree without either being malformed. The gate set freezes a denominator of
 *  probe IDs; the manifest holds the queries those ids stand for. Two manifests identical in `k`,
 *  probe id and `relevant` and differing only in `query` produce different ranks under the same
 *  frozen denominator, and every id-level check in the score phase agrees with both. Carrying the
 *  manifest hash in the deterministic payload is what puts the queries inside the chain, and it is
 *  a payload field rather than a receipt because it is identical across every honest re-run.
 *
 *  `ledgers`, `trust`, `projectDisposition` and `expansionSha256` bind the CORPUS and the RUNTIME
 *  SURFACE, which `prepareSha256` and `manifestSha256` do not: the gate set pins those hashes as
 *  frozen inputs, but a run that never re-checked them could be measured against a substituted
 *  snapshot — same gate set, same manifest, different corpus — and pass every hash check above.
 *  The fields record what the runner verified before ranking: the two ledger files' utf8 hashes,
 *  the four trust files by raw bytes or the literal 'absent' (round 3 proved a macNonce swapped
 *  inside `projects.json` re-scores signed verify rows and a planted witness journal removes a
 *  whole scope, each with every narrower pin green), the ownership disposition the project scope
 *  actually resolved to (which must equal the gate set's disclosure), and the CONTENT hash of the
 *  resolved semantic-neighbor table. The content hash replaced a round-3 `expansionAvailable`
 *  boolean, which proved only that SOME table resolved — `{"neighbors":{}}` included, removing all
 *  query expansion under a green flag. All are payload fields because all are identical across
 *  honest re-runs. */
export interface RunPayload {
  rule: string;
  k: number;
  prepareSha256: string;
  manifestSha256: string;
  ledgers: { 'ledger:global': string; 'ledger:project': string };
  trust: {
    'ownership:registry': string;
    'ownership:owner': string;
    'trust:master-key': string;
    'trust:witness': string;
  };
  projectDisposition: ProjectDisposition;
  expansionSha256: string;
  results: RunResult[];
}

/** Volatile half — the run id and real wall clocks §9 requires retained and §4 excludes from the
 *  stability comparison. The timestamps are self-reported and are evidence only as strong as that:
 *  §9's chain, item 4, calls for an append-only or externally attested prepare-before-run receipt,
 *  which no field a program writes about itself can supply. */
export interface RunArtifact {
  artifact: 'run';
  payloadSha256: string;
  payload: RunPayload;
  receipts: { runId: string; startedAt: string; finishedAt: string; attestation: string };
}

/** §3b: a starvation floor, not a statistical minimum — the smallest count at which no single
 *  event decides the verdict. Evaluated once at the fixed close (§3c), never as a stopping rule. */
export const HIT1_MINIMUM = 2;

export const RULE = 'v2-gate-composition-2026-07-29';
