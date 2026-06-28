// Shared verifying-read helper: the SINGLE source of truth for turning a ledger file into its
// verified live projection. Both the MemoryStore (recall/inspect) and the SessionStart hook route
// through these two functions so the trust grades they show can never drift — a forged or edited
// ledger record replays as Fresh on EVERY read surface, not just the tool surface.
import type { LedgerPath } from './ledger.js';
import { parseLedger } from './ledger.js';
import { tryReadMaster, deriveSubkey, verifyVerify } from './ledger-mac.js';
import { scopeNonce, globalScopeNonce } from './ownership.js';
import { buildVerifiedProjection, type VerifiedProjection } from './verified-projection.js';

/**
 * Resolve the per-scope HMAC subkey that verifies a ledger's signed `verify` records. Mirrors
 * MemoryStore.subkeyForLedger EXACTLY. Returns null when no master key exists yet OR the scope
 * nonce is unresolvable (e.g. an unowned project) — a null subkey forces the verifying replay into
 * key-absent mode (every state clamps to Fresh).
 *
 * `projectRoot` omitted => the global ledger's home-stored scope nonce; present => that project's
 * home-only macNonce. The master key + nonce registry both live under `home`, which the threat-model
 * adversary (who can write the repo ledger) cannot read.
 */
export function subkeyForScope(home: string, projectRoot?: string): Buffer | null {
  const master = tryReadMaster(home);
  if (!master) return null;
  const nonce = projectRoot ? scopeNonce(projectRoot, home) : globalScopeNonce(home);
  return nonce ? deriveSubkey(master, nonce) : null;
}

/**
 * The verifying projection for one ledger (R1 clamp / R2 MAC gate / R3 content binding). Mirrors
 * MemoryStore.verifiedOf EXACTLY. A forged or edited record replays as Fresh; only a genuinely
 * signed `verify` for the live, unedited target confers Corroborated/Verified. Key-absent =>
 * keyAvailable false and every state clamps to Fresh (fail-closed — no forged elevation is shown).
 */
export function verifiedLive(ledger: LedgerPath, home: string, projectRoot?: string): VerifiedProjection {
  const subkey = subkeyForScope(home, projectRoot);
  return buildVerifiedProjection(parseLedger(ledger), {
    verify: (r) => (subkey ? verifyVerify(r, subkey) : false),
    keyAvailable: subkey !== null,
  });
}
