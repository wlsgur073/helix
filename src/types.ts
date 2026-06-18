// Shared types for Helix's deterministic core. Plain data, no behavior.

/** How dangerous it is to be wrong about, or to act on, an item (spec §7.5). */
export type BlastRadius =
  | 'read-only'
  | 'local-reversible'
  | 'hard-to-reverse'
  | 'external';

/** Trust state of a memory item (spec §7.4). */
export type MemoryState = 'Fresh' | 'Verified' | 'Suspect';

/** Ledger event kinds (spec §7.4). */
export type RecordType = 'assert' | 'verify' | 'supersede' | 'invalidate' | 'erase';

/** Where a record's authority comes from. Only `user` + `reality-check` can verify. */
export type ProvenanceSource = 'user' | 'reality-check' | 'codex-agree';

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
}

/** In-memory scope tag for a recalled item — derived from its source ledger, never persisted. */
export type MemoryScope = 'global' | 'project';

/** A record paired with the scope it was loaded from. */
export interface ScopedRecord {
  record: MemoryRecord;
  scope: MemoryScope;
}
