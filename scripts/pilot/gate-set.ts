/** Shared declarations for the two-phase reducer — types and frozen constants, no behaviour.
 *
 *  Both phases need these, and neither may import the other: `prepare-gate.ts` and `score-gate.ts`
 *  are both guarded by `isEntryPoint(import.meta.url)`, and that guard does not survive bundling
 *  (see `snapshot.ts` for the full account and `test/pilot/entry-point-isolation.test.ts` for the
 *  lock). Declaration modules have nothing to guard, so they are where shared surface lives. */
import type { MemoryScope } from '../../src/types.js';

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
 *  only as strong as that: §5's chain calls for an append-only or externally attested receipt. */
export interface GateSet {
  artifact: 'gate-set';
  payloadSha256: string;
  payload: GateSetPayload;
  receipts: { preparedAt: string; attestation: string };
}

/** §3b: a starvation floor, not a statistical minimum — the smallest count at which no single
 *  event decides the verdict. Evaluated once at the fixed close (§3c), never as a stopping rule. */
export const HIT1_MINIMUM = 2;

export const RULE = 'v2-gate-composition-2026-07-29';
