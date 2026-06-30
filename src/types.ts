// Shared types for Helix's deterministic core. Plain data, no behavior.

/** How dangerous it is to be wrong about, or to act on, an item (spec §7.5). */
export type BlastRadius =
  | 'read-only'
  | 'local-reversible'
  | 'hard-to-reverse'
  | 'external';

/** Trust state of a memory item (spec §7.4). */
export type MemoryState = 'Fresh' | 'Corroborated' | 'Verified' | 'Suspect';

/** Ledger event kinds (spec §7.4). */
export type RecordType = 'assert' | 'verify' | 'supersede' | 'invalidate' | 'erase';

/** Where a record's authority comes from. `user` is the only *human-authoritative* item source;
 *  `reality-check` is a verify-EVENT source that caps at Corroborated (never Verified) — see
 *  firewall.resolveTransition. Classified by set membership (firewall.isVerifyingSource); unknown/
 *  legacy values fall non-authoritative (fail-closed). */
export const PROVENANCE_SOURCES = ['user', 'user-relayed', 'agent-inference', 'reality-check', 'codex-agree'] as const;
export type ProvenanceSource = typeof PROVENANCE_SOURCES[number];

/** Content classification for the erasure/secret paths (spec §7.4). */
export type Classification = 'normal' | 'secret-redacted' | 'personal';

export interface Provenance {
  source: ProvenanceSource;
  sessionId: string;
  /** A human/agent/check identifier; optional for plain asserts. */
  verifier?: string;
}

/** A descriptor of the mechanical observation that should flip an item to Suspect. */
export interface ReverifyTrigger {
  kind: string; // e.g. 'file-mtime', 'exit-code'
  [key: string]: unknown;
}

/** One immutable ledger record (one JSONL line). Spec §7.4. */
export interface MemoryRecord {
  id: string;
  tx: string;             // transaction time (ISO 8601)
  validFrom: string;      // valid time start (ISO 8601)
  validTo: string | null; // valid time end, null = still valid
  type: RecordType;
  state: MemoryState;
  content: string;
  provenance: Provenance;
  supersedes: string | null;
  blastRadius: BlastRadius | null;     // set by the tagger (Task 4)
  reverifyTrigger: ReverifyTrigger | null;
  classification: Classification;
  // --- ledger-HMAC (optional; populated on signed `verify` records) ---
  mac?: string;          // hex HMAC-SHA256 over the canonical encoding (Task 3)
  gen?: number;          // per-target monotonic generation (Task 4)
  targetDigest?: string; // hex sha-256 of the target content at sign time (Task 3/5)
  keyId?: string;        // hex id of the subkey that signed this (Task 2)
  macVersion?: number;   // MAC scheme version (currently 1)
}

/** In-memory scope tag for a recalled item — derived from its source ledger, never persisted. */
export type MemoryScope = 'global' | 'project';

/** A record paired with the scope it was loaded from. */
export interface ScopedRecord {
  record: MemoryRecord;
  scope: MemoryScope;
  /** Verifying-replay integrity verdict for this item. Set by the store's verified projection;
   *  optional because plain pairings (pre-HMAC callers) may omit it. 'compromised' = equal-gen MAC
   *  conflict on the target. */
  integrity?: 'ok' | 'compromised';
}

/** A ledger record paired with its DERIVED system-time end. Produced only by buildHistory at read
 *  time; NEVER written to the ledger. Mirrors ScopedRecord — derived attrs on a wrapper, not on
 *  the persisted MemoryRecord. txTo===null <=> closedBy===null <=> the row is live. */
export interface HistoricalRecord {
  record: MemoryRecord;
  /** System-time end — a DECLARED/display ISO-8601 value (not authenticated), or null if live. */
  txTo: string | null;
  /** The closing marker (kind + its id, for audit), or null if live. */
  closedBy: { kind: 'supersede' | 'invalidate' | 'erase'; markerId: string } | null;
}

/** A HistoricalRecord tagged with its scope. `integrity` is carried for live rows (from the
 *  verified projection); closed rows default to 'ok'. */
export interface ScopedHistoricalRecord extends HistoricalRecord {
  scope: MemoryScope;
  integrity?: 'ok' | 'compromised';
}
