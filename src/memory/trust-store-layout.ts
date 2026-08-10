import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalRoot } from './ownership.js';

/** Everything the trust store keeps under `home`. These are the files whose location SECURITY.md
 *  makes a promise about: the signing key, the ownership registry, and the rollback witness pair. */
export const TRUST_FILE_NAMES = ['ledger-mac-master.key', 'projects.json', 'witness.json', 'witness-log.jsonl'] as const;

/** Does this file's CONTENT look like the Helix artifact its name claims?
 *
 *  `projects.json` and `witness.json` are ordinary names that an unrelated tool could plausibly use,
 *  and this predicate gates a refusal to start — so a bare existence check would let somebody else's
 *  file lock a user out of their own memory. The master key and the witness log are named
 *  distinctively enough that presence is the signal; the two generic names must parse and carry the
 *  right shape. */
function looksLikeOurs(name: string, path: string): boolean {
  try {
    // This predicate gates an exit(78) refusal to start, so it must be hard to SATISFY with
    // planted junk (startup-DoS finding): a loose shape check let five trivially plantable states
    // deny every future session its memory. lstat, never stat — a symlink beside the ledger is a
    // plantable redirection, not our state.
    const st = lstatSync(path);
    if (!st.isFile()) return false;
    if (name === 'ledger-mac-master.key') return st.size === 32; // MASTER_LEN — anything else is not our key
    if (name === 'witness-log.jsonl') {
      // our log has at least one parseable JSONL line; an empty or garbage file is not evidence
      return readFileSync(path, 'utf8').split('\n').some((l) => {
        if (!l.trim()) return false;
        try { JSON.parse(l); return true; } catch { return false; }
      });
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const values = Object.values(parsed as Record<string, unknown>);
    if (name === 'projects.json') {
      // scope key -> { stamp, adoptedAt, macNonce } with the value types ownership.ts writes
      return values.length > 0 && values.every((v) =>
        typeof v === 'object' && v !== null &&
        typeof (v as Record<string, unknown>).stamp === 'string' &&
        typeof (v as Record<string, unknown>).macNonce === 'string');
    }
    // witness.json: the witness store writes { v: 1, scopes: Record<scopeKey, ScopeFile> }
    const scopes = (parsed as Record<string, unknown>).scopes;
    return typeof scopes === 'object' && scopes !== null && !Array.isArray(scopes);
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
