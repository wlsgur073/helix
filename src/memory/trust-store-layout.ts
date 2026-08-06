import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalRoot } from './ownership.js';

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
