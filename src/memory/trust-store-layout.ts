import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { canonicalRoot } from './ownership.js';
import { tryReadMaster, verifyVerify } from './ledger-mac.js';
import { subkeyForScope, verifiedProjectionWithSubkey } from './verified-read.js';
import { readLedgerWitnessed } from './witness-read.js';
import { clampElevatedState } from './verified-projection.js';
import { scanLegacyElevated } from './legacy-scan.js';

/** Everything the trust store keeps under `home`. These are the files whose location SECURITY.md
 *  makes a promise about: the signing key, the ownership registry, and the rollback witness pair. */
export const TRUST_FILE_NAMES = ['ledger-mac-master.key', 'projects.json', 'witness.json', 'witness-log.jsonl'] as const;

/** The master key is exactly this many bytes (mirrors ledger-mac.ts's own MASTER_LEN — duplicated
 *  rather than imported so this detector stays a read-only content check, not a dependency on the
 *  module that mints keys). */
const MASTER_KEY_LEN = 32;

/** Does this file's CONTENT look like the Helix artifact its name claims?
 *
 *  `projects.json` and `witness.json` are ordinary names that an unrelated tool could plausibly use,
 *  and this predicate gates a refusal to start — so a bare existence check would let somebody else's
 *  file lock a user out of their own memory. The master key and the witness log are named
 *  distinctively enough that presence is the signal; the two generic names must parse and carry the
 *  right shape.
 *
 *  This is also, unavoidably, an attacker-facing surface: a repo-writing adversary can plant a file
 *  of any of these four names and shape it however they like, hoping to trip the startup refusal
 *  (see docs/issues/repros/f1-detector-startup-dos.ts). Every check below is sized to the REAL
 *  artifact's actual shape, not just "parses" — a one-byte key, a wrong-typed registry entry, or a
 *  `scopes` of the wrong type is content nobody's real trust store ever produces. `lstatSync` is used
 *  throughout (never `statSync`/`existsSync` on the path itself) so a symlink standing in for the
 *  file — bytes living anywhere else on disk — is rejected outright rather than followed. */
function looksLikeOurs(name: string, path: string): boolean {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return false;   // rejects symlinks, dirs, FIFOs, etc. — no dereferencing
    if (name === 'ledger-mac-master.key') return st.size === MASTER_KEY_LEN;
    if (name === 'witness-log.jsonl') return st.size > 0;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const obj = parsed as Record<string, unknown>;
    if (name === 'projects.json') {
      // scope key -> { stamp, adoptedAt, macNonce }, stamp/macNonce STRING-typed (ownership.ts's
      // own registry validator requires it; a same-keyed-but-wrong-typed entry is what a forger
      // produces when they copy the shape without the real minting code).
      const values = Object.values(obj);
      return values.length > 0 && values.every((v) =>
        typeof v === 'object' && v !== null &&
        typeof (v as Record<string, unknown>).stamp === 'string' &&
        typeof (v as Record<string, unknown>).macNonce === 'string');
    }
    // witness.json: `scopes` must be an object (a scope-keyed map), not merely present.
    return typeof obj.scopes === 'object' && obj.scopes !== null && !Array.isArray(obj.scopes);
  } catch {
    return false;   // unreadable or unparseable is not evidence of our state
  }
}

/**
 * Trust-store files that have been left BESIDE the ledger instead of under `home`.
 *
 * Before the trust store's location was pinned to `home`, it was derived as the ledger's own
 * directory — so anyone who pointed `HELIX_LEDGER` somewhere had their signing key, registry and
 * witness created there too. Pinning `home` now silently orphans that state: a fresh key mints,
 * every grade the old key conferred dies, and a witness that still attests to this scope is left
 * behind where a rollback can no longer be detected against it. That is a trust reset, and it must
 * be reported rather than performed.
 *
 * Returns the stray names in `TRUST_FILE_NAMES` order, or an empty array when there is nothing to
 * migrate — which includes the ordinary case where the ledger simply lives in `home`.
 *
 * The two directories are compared CANONICALLY. A textual compare would fire on a `HELIX_HOME` with
 * a trailing separator, since `dirname()` normalises one side and the environment variable does not
 * — refusing to start for a user whose configuration was correct all along.
 */
export function strayTrustFiles(home: string, globalLedger: string): string[] {
  const ledgerDir = dirname(globalLedger);
  if (canonicalRoot(ledgerDir) === canonicalRoot(home)) return [];
  return TRUST_FILE_NAMES.filter((name) => {
    const p = join(ledgerDir, name);
    return existsSync(p) && looksLikeOurs(name, p);
  });
}

/** Which of the three key-comparison outcomes decides the split-trust-store refusal in
 *  `server/index.ts`. Key PRESENCE beside the ledger is not the signal `strayTrustFiles`'s caller
 *  acts on any more (see `compareStrayMasterKey`'s own doc) — only whether HOME's own master key
 *  is byte-identical to whatever key, if any, sits beside the ledger. */
export type StrayKeyOutcome = 'no-home-key' | 'match' | 'mismatch';

/**
 * Decides whether starting on a split trust store is safe, by KEY COMPARISON rather than key
 * PRESENCE.
 *
 * The harm this exists to catch is not minting — it is the ledger being RE-GRADED under the wrong
 * key. History that breaks a presence-only gate: a user runs Helix normally (a master key mints
 * under HOME); later they set HELIX_LEDGER on a pre-pin version, which builds a second trust store
 * beside the relocated ledger. HOME now has A key, so a presence-only gate reads that as "nothing
 * to migrate" and lets the server start — but it then re-grades the ledger under HOME's key, which
 * is NOT the key that signed those records, so every elevated grade MAC-mismatches and
 * `store.ts`'s witness guard clamps it to Fresh. That is exactly the silent trust reset the
 * refusal exists to prevent, so key identity — not key presence — is what must gate it.
 *
 * - HOME has no valid master key of its own (absent, or unreadable/wrong-sized) → `'no-home-key'`:
 *   refuse, as before — starting would mint a fresh key over the stray files.
 * - HOME's key is byte-identical to the key sitting beside the ledger → `'match'`: the stray files
 *   are a genuine, inert leftover — re-grading under HOME's key is a no-op because it IS the key
 *   that signed them. Safe to start.
 * - Anything else (the keys differ, or the file beside the ledger cannot be confirmed to be the
 *   same key — missing, unreadable, wrong-sized) → `'mismatch'`: re-grading loss is imminent, or
 *   unproven safe, which this function treats the same way — refuse.
 *
 * Reads with `tryReadMaster` (exactly `MASTER_LEN` bytes — ledger-mac.ts's own strict reader,
 * reused here rather than `existsSync`): a wrong-sized HOME key must not read as "HOME has a key"
 * — that used to downgrade the refusal to a warning and then throw an uncaught `LedgerMacError`
 * once the store actually tried to use it. Both reads are wrapped: a corrupt/wrong-sized key at
 * EITHER path collapses to `null` rather than throwing through this decision. `tryReadMaster`
 * takes a directory and reads `<dir>/ledger-mac-master.key` from it — its parameter is named
 * `home` in ledger-mac.ts because that is its only other caller, but nothing about it is
 * home-specific, so passing `ledgerDir` here reads the stray key with the exact same strictness.
 */
export function compareStrayMasterKey(home: string, ledgerDir: string): StrayKeyOutcome {
  let homeKey: Buffer | null;
  try { homeKey = tryReadMaster(home); } catch { homeKey = null; }
  if (!homeKey) return 'no-home-key';
  let strayKey: Buffer | null;
  try { strayKey = tryReadMaster(ledgerDir); } catch { strayKey = null; }
  return strayKey !== null && timingSafeEqual(homeKey, strayKey) ? 'match' : 'mismatch';
}

/** Measures, not infers, whether starting would lose a trust grade `ledger` currently carries. Key
 *  presence (round 1) and key identity (`compareStrayMasterKey`, round 1's revision) are both
 *  PROXIES for this — and the second one is still too conservative: a healthy install with its own
 *  HOME key refuses the instant an adversary plants ONE shape-valid stray file (e.g. a bare
 *  `witness.json`), even though nothing whatsoever is at risk, because there is no stray key to
 *  compare against. That re-opens the startup denial of service this job exists to close. */
export interface GradeLossAssessment {
  /** True iff starting would lose at least one already-elevated grade, via EITHER path below. */
  loses: boolean;
  /** Path (a): ids of `verify`-type records that do NOT validate under HOME's own subkey (or a
   *  baked non-Fresh assert/supersede — see scanLegacyElevated) — their elevation never reaches
   *  the projection at all, silently, on every replay from here on. */
  unverifiableRecordIds: string[];
  /** HOME's rollback witness for this scope does not match `ledger`'s CURRENT bytes. */
  witnessMismatch: boolean;
  /** Path (b): ids of currently-elevated live records that `witnessMismatch` would clamp to Fresh
   *  (store.ts's mismatch guard) — empty even under a witness mismatch if nothing live is elevated,
   *  which is what lets an empty or ungraded ledger start regardless of witness state. */
  clampedRecordIds: string[];
}

/**
 * The refusal's actual ground, replacing both proxies tried before it: does STARTING on `ledger`,
 * read as HOME would read it, lose a trust grade it currently carries? Loss arrives by two
 * independent paths, mirroring store.ts's own read pipeline exactly, and BOTH must be checked:
 *
 *  (a) a `verify` record that does not validate under HOME's subkey never confers its grade in the
 *      first place (`buildVerifiedProjection`'s verify predicate) — the author's intended elevation
 *      silently vanishes on replay. Same predicate the pre-existing "Verifying integrity scan"
 *      warning in server/index.ts already uses (`scanLegacyElevated` + `verifyVerify`).
 *  (b) HOME's rollback witness for this scope does not match `ledger`'s CURRENT bytes — store.ts's
 *      mismatch guard (`clampElevatedState`) then clamps every already-elevated LIVE record to
 *      Fresh, regardless of whether its own verify validates. This is the path a presence/identity
 *      proxy cannot see: two stores can share the exact same key and still diverge here, because a
 *      witness is scoped to HOME + '@global', not to any one ledger file — pointing the SAME scope
 *      at a DIFFERENT ledger's bytes mismatches even when nothing was ever forged.
 *
 * A ledger with nothing elevated in play — empty, fresh, or every record still Fresh — takes
 * neither path regardless of key or witness state: this is what lets a bare stray file (nothing
 * behind it to lose) start instead of refusing, closing the DoS this measurement replaces.
 *
 * PURE READ, safe to call before any state-changing startup step: `readLedgerWitnessed`
 * (witness-read.ts) never mints a master key or advances a witness transition, and tolerates an
 * absent/empty/torn `ledger` (ENOENT -> empty bytes/records, verdict `first-contact`) without
 * throwing. `subkeyForScope` short-circuits to `null` (no scope-nonce lookup, no side effects at
 * all) when HOME has no master key yet — scanLegacyElevated then correctly reports every existing
 * `verify` record as unverifiable, since starting would in fact mint a fresh key none of them were
 * signed under.
 *
 * Reads `ledger` once (`readLedgerWitnessed`'s single witness-first, retry-once pass) and reuses
 * that one parse for both paths — no second read. It IS a second read of the same bytes the first
 * real recall will do moments later (this must run before MemoryStore exists, per the ordering note
 * on its call site, and MemoryStore's constructor accepts no seed for a pre-computed projection to
 * avoid that): unavoidable without touching store.ts, which is pinned, so it is accepted rather than
 * worked around. It happens only when `strayTrustFiles` is non-empty — an already-anomalous boot,
 * never on an ordinary healthy start.
 */
export function assessGradeLoss(home: string, ledger: string): GradeLossAssessment {
  const { records, verdict } = readLedgerWitnessed(ledger, home);
  const subkey = subkeyForScope(home);
  const scan = scanLegacyElevated(records, (r) => (subkey ? verifyVerify(r, subkey) : false));
  const clampedRecordIds = verdict.kind === 'mismatch'
    ? [...verifiedProjectionWithSubkey(records, subkey).live.values()]
        .filter((r) => clampElevatedState(r.state) !== r.state)
        .map((r) => r.id)
    : [];
  return {
    loses: scan.offenders.length > 0 || clampedRecordIds.length > 0,
    unverifiableRecordIds: scan.offenders,
    witnessMismatch: verdict.kind === 'mismatch',
    clampedRecordIds,
  };
}
