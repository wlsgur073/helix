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

/**
 * Is HOME's global-scope MAC nonce ALREADY established — i.e. would resolving it read a nonce
 * rather than MINT one? This is deliberately NOT a registry validator and must never grow into one
 * (round 4: a hand-copied validator diverged from `ownership.ts`'s and the gate judged a ledger
 * under a subkey the store would never use). It answers one narrower question, whose only job is to
 * keep `readOnlyGlobalSubkey` below from delegating INTO a mint.
 *
 * `ownership.ts` is freeze-pinned and its registry readers (`loadRegistry`/`readRegistry`) are
 * private, so the validation cannot be imported — but it does not need to be. `globalScopeNonce`
 * mints only when its own fast-path read finds no non-empty `'@global'` `macNonce` in a registry it
 * did not already reject as corrupt; both of its non-minting exits return BEFORE its first
 * `mkdirSync`. So a `true` here — the registry file exists, parses to a plain object, and its
 * `'@global'` entry carries a non-empty string `macNonce` — is exactly the condition under which
 * that mint provably cannot happen, whatever the registry's OTHER entries look like: a malformed
 * sibling entry makes `loadRegistry` report `corrupt`, which returns `null` without writing.
 *
 * Both directions of error are therefore safe. Stricter than `loadRegistry` → no delegation → a
 * `null` subkey → `loses: true` → refuse: over-refusal, which is the direction this gate is allowed
 * to be wrong in. Looser than `loadRegistry` → delegation → `loadRegistry` rejects it itself and
 * returns `null` without minting: the same answer, still no write. The one case that would mint —
 * `true` here while the real reader finds nothing to read — requires `projects.json` to change
 * between this read and that one, the same `lstat`-then-read race already recorded as deferred
 * for `looksLikeOurs` above.
 */
function globalNonceAlreadyEstablished(home: string): boolean {
  try {
    const path = join(home, 'projects.json');
    if (!lstatSync(path).isFile()) return false;   // absent, or a symlink we will not follow
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const entry = (parsed as Record<string, unknown>)['@global'];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const nonce = (entry as Record<string, unknown>).macNonce;
    return typeof nonce === 'string' && nonce.length > 0;   // '' is falsy to globalScopeNonce too — it would mint
  } catch {
    return false;   // unreadable/unparseable — nothing here proves a nonce is established
  }
}

/**
 * The subkey `assessGradeLoss` judges the ledger under: the REAL `subkeyForScope`, called only once
 * a mint is provably impossible, and `null` otherwise.
 *
 * Round 3 removed the mint by re-deriving the subkey here — read the registry, pull `'@global'`'s
 * `macNonce`, `deriveSubkey`. The derivation matched, but the VALIDATION did not: `loadRegistry`
 * fails the WHOLE registry when ANY entry has a non-string `stamp`/`adoptedAt`/`macNonce`, so the
 * real resolver returned `null` where the copy happily returned `'@global'`'s nonce. The gate then
 * measured the ledger under a subkey the store would never use, found no loss, started — and the
 * store clamped Verified to Fresh, the exact harm exit 78 exists to prevent, reached by failing
 * TOWARD starting. A second hand-copy of the validator would only re-arm the same trap.
 *
 * So the validation is not copied at all: it is DELEGATED to the same function the store itself
 * resolves through, and the local check above is reduced to the one question delegation cannot
 * answer for itself (would this call mint?). Whatever `subkeyForScope` accepts or rejects, this
 * accepts or rejects identically by construction — including any future tightening of
 * `ownership.ts`'s shape gate, which no longer has a private copy here to drift away from.
 *
 * The residual asymmetry is deliberate and pinned by test: when no nonce is established (no
 * registry, no `'@global'` entry) the real resolver mints a FRESH nonce, and a freshly minted nonce
 * verifies nothing that was signed before it. Reporting `null` — cannot verify, `loses: true`,
 * refuse — is the honest verdict for that state, and it is the only one reachable without writing
 * into a HOME whose startup may yet be refused. Every OTHER subkey resolution in the codebase (the
 * real recall path, the startup integrity scan below this gate in server/index.ts) legitimately
 * mints on first use and must keep doing so; this one call site is the exception, because it runs
 * BEFORE the decision that gates whether starting — and thus minting — is safe at all.
 */
function readOnlyGlobalSubkey(home: string): Buffer | null {
  if (!globalNonceAlreadyEstablished(home)) return null;   // never delegate into a mint
  return subkeyForScope(home);                             // the real resolver decides everything else
}

/** Measures, not infers, whether starting would lose a trust grade `ledger` currently carries. Key
 *  presence (round 1) and key identity (`compareStrayMasterKey`, round 1's revision) are both
 *  PROXIES for this — and the second one is still too conservative: a healthy install with its own
 *  HOME key refuses the instant an adversary plants ONE shape-valid stray file (e.g. a bare
 *  `witness.json`), even though nothing whatsoever is at risk, because there is no stray key to
 *  compare against. That re-opens the startup denial of service this job exists to close. */
export interface GradeLossAssessment {
  /** The refuse signal: starting is NOT PROVABLY LOSSLESS. True when a loss was actually measured
   *  (either path below) AND when the measurement could not be completed at all (`undecidable`). */
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
  /** Why the measurement could not be made at all, or `null` when it completed. Non-null forces
   *  `loses` true with every id list empty — the caller must report this as "cannot be determined",
   *  NOT as a measured loss, or the refusal message names records it never actually examined. */
  undecidable: string | null;
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
 * NEVER THROWS. A failure to measure is reported as `undecidable` with `loses` true, not raised —
 * see the wrapper below for why that direction, and `undecidable`'s own doc for why the caller must
 * not present it as a measured loss.
 *
 * MINTS NOTHING AND MOVES NO TRUST STATE, which is what makes it safe to call before the decision
 * it informs — but it is not literally side-effect-free, and must not be documented as if it were.
 * What it does NOT do: `readLedgerWitnessed` (witness-read.ts) never mints a master key or advances
 * a witness transition, and tolerates an absent/empty/torn `ledger` (ENOENT -> empty bytes/records,
 * verdict `first-contact`) without throwing; `readOnlyGlobalSubkey` (above) returns `null` rather
 * than let `globalScopeNonce` mint a nonce and write `projects.json` into a HOME whose startup may
 * yet be refused — the one call site in the codebase where that mint must not happen, since it runs
 * before the very decision gating whether starting, and thus minting, is safe at all. A null subkey
 * here still correctly reports every existing `verify` record as unverifiable (scanLegacyElevated),
 * since starting would in fact mint a fresh nonce none of them were signed under.
 *
 * What it DOES do: `tryReadMaster` (ledger-mac.ts) chmods the master key it reads to 0600 whenever
 * the mode is over-broad — a defense-in-depth tightening it applies on every read, not a choice
 * made here. Both of this function's key reads go through it (`readLedgerWitnessed` via
 * `readScopeWitness`, and `readOnlyGlobalSubkey` via `subkeyForScope`), so a call can leave HOME's
 * own key at a tighter mode than it found it. Benign in practice — startup hardens HOME's
 * permissions before this runs, and tightening a mode loses no trust state either way — and
 * recorded as a deferred finding rather than changed here. It is noted because the absolute this
 * comment used to assert was false, and a future reader must not build on it.
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
  try {
    return measureGradeLoss(home, ledger);
  } catch (e) {
    // FAIL CLOSED. A throw here does not mean "no loss" — it means HOME's own trust state could not
    // be read well enough to answer the question, and an unanswerable question is not a safe one.
    // Concretely: `tryReadMaster` throws `LedgerMacError` on a master key that is present but not
    // exactly MASTER_LEN bytes, on BOTH paths this function reads HOME through, so a truncated or
    // overwritten key used to take the whole server down with a stack trace instead of reaching the
    // refusal that carries the remedies. Refusing must NOT be justified as "no mint can happen":
    // `undecidable` is set on ANY throw out of `measureGradeLoss`, which reads the ledger and witness
    // (`readLedgerWitnessed`) as well as the key, so it is a CLASS of causes, not one. If the cause IS
    // the key (present but not MASTER_LEN bytes), `ensureMaster` calls `tryReadMasterStrict` BEFORE
    // mkdirSync/withFileLock/randomBytes and throws before any create path, so THAT cause mints
    // nothing. But an absent key with an UNREADABLE LEDGER also throws here, with the key absent - and
    // the absent-key branch is exactly the one `ensureMaster` mints on, so `undecidable` can coincide
    // with a mint. Measured: truncated key -> ensureMaster throws, HOME unchanged; absent key +
    // ledger-that-is-a-directory -> `undecidable` set AND ensureMaster mints 32 bytes. Refusing is
    // therefore justified by protecting the ADVICE (below), which holds for every cause, not by an
    // absolute the unreadable state cannot support.
    // What refusing preserves is the ADVICE. The lossless branch of this gate tells the user the
    // stray files are "safe to delete"; if they hold the only readable copy of this ledger's trust
    // store, acting on that is UNRECOVERABLE. An unanswerable question must not license that
    // sentence — which is why an unreadable HOME fails CLOSED rather than reporting "no loss".
    //
    // The caller must distinguish this from a measured loss (see `undecidable`): every id list is
    // empty because nothing was examined, not because nothing was at risk.
    return {
      loses: true,
      unverifiableRecordIds: [],
      witnessMismatch: false,
      clampedRecordIds: [],
      undecidable: e instanceof Error ? e.message : String(e),
    };
  }
}

/** `assessGradeLoss`'s actual measurement — separated only so the fail-closed wrapper above cannot
 *  accidentally swallow a throw from some LATER, unrelated statement added beside it. */
function measureGradeLoss(home: string, ledger: string): GradeLossAssessment {
  const { records, verdict } = readLedgerWitnessed(ledger, home);
  const subkey = readOnlyGlobalSubkey(home);
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
    undecidable: null,
  };
}
