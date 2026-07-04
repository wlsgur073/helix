import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, renameSync, statSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLock } from './lock.js';
import type { MemoryRecord } from '../types.js';

export const MAC_VERSION = 2;                             // version NEW signatures carry
const ACCEPTED_MAC_VERSIONS = new Set<number>([1, 2]);   // versions verifyVerify treats as valid

/** Lowercase hex SHA-256 over the UTF-8 bytes of `content`. Used for the content binding. */
export function digestContent(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

export class LedgerMacError extends Error {}

const MASTER_LEN = 32;
function masterPath(home: string): string { return join(home, 'ledger-mac-master.key'); }

/** Best-effort fsync of a directory fd so a create/rename is durably persisted. Pure durability
 *  nit: on Windows (and some FS) a directory cannot be opened/fsync'd — ignore it, never a
 *  correctness issue (a lost master just makes elevations replay Fresh). */
function fsyncDir(dir: string): void {
  let dfd: number;
  try { dfd = openSync(dir, 'r'); } catch { return; }   // Windows EISDIR/EPERM/EACCES -> skip
  try { fsyncSync(dfd); } catch { /* EINVAL/EISDIR on some FS for a dir fd — durability only */ }
  finally { closeSync(dfd); }
}

/** Atomic, idempotent: return the 32-byte master, creating it (mode 0600) under a lock on first use. */
export function ensureMaster(home: string): Buffer {
  const path = masterPath(home);
  const existing = tryReadMasterStrict(path);
  if (existing) return existing;
  mkdirSync(home, { recursive: true });
  return withFileLock(path, () => {
    const again = tryReadMasterStrict(path); // re-check inside the lock (another process may have won)
    if (again) return again;
    const key = randomBytes(MASTER_LEN);
    const tmp = `${path}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeSync(fd, key); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);   // atomic on the same filesystem
    fsyncDir(dirname(path)); // persist the new directory entry too (spec §7: fsync file AND dir)
    return key;
  });
}

/** Strict read: present + exactly MASTER_LEN bytes, else throw (corrupt) or return null (absent). */
function tryReadMasterStrict(path: string): Buffer | null {
  let buf: Buffer;
  try { buf = readFileSync(path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  if (buf.length !== MASTER_LEN) throw new LedgerMacError(`corrupt master key (${buf.length} bytes, want ${MASTER_LEN})`);
  // defense-in-depth: tighten over-broad perms (threat model makes home unreadable; warn-and-fix, not fail-closed)
  try { if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600); } catch { /* best-effort */ }
  return buf;
}

export function tryReadMaster(home: string): Buffer | null { return tryReadMasterStrict(masterPath(home)); }

export function deriveSubkey(master: Buffer, nonce: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.from(nonce, 'utf8'), Buffer.from('helix-ledger-mac-v1', 'utf8'), 32));
}

export function keyIdOf(subkey: Buffer): string {
  return createHash('sha256').update(Buffer.concat([Buffer.from('keyid'), subkey])).digest().subarray(0, 8).toString('hex');
}

const DOMAIN = Buffer.from('helix-ledger-mac');

function field(buf: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([Buffer.from([0x01]), len, buf]); // 0x01 = present
}
const NULL_FIELD = Buffer.from([0x00, 0, 0, 0, 0]);
const str = (s: string | null): Buffer => (s === null ? NULL_FIELD : field(Buffer.from(s, 'utf8')));
const int = (n: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return field(b); };

/** The exact bytes the MAC covers — fixed field order, length-prefixed, no JSON. VERSIONED: the
 *  leading version byte domain-separates v1 and v2, so one MAC can never validate under both
 *  interpretations (computationally infeasible — the HMAC forgery bound).
 *
 *  v1 (macInputV1): DOMAIN, 1, keyId, type, id, supersedes, state, gen, targetDigest.  (tx NOT covered)
 *  v2 (macInputV2): the same fields, version byte 2, PLUS tx.  signVerify writes v2; verifyVerify accepts both.
 *
 *  Authenticated in v2: all of the above INCLUDING tx. Still UNAUTHENTICATED (never bound): validFrom,
 *  validTo, provenance, blastRadius, reverifyTrigger, classification. Load-bearing INVARIANT: none of
 *  these unauthenticated fields may EVER drive a trust or gen-ordering decision. `tx` is authenticated
 *  FOR v2 records ONLY — a v1 record's tx stays forgeable-in-place (v1 never covered it), so a consumer
 *  that trusts tx MUST gate on isVerifyTxAuthenticated (verify-tx.ts), never on verifyVerify alone.
 *  gen remains the sole ordering key. Benign malleability: gen 0/null/absent and targetDigest null/absent
 *  are MAC-equivalent AND consumer-equivalent (every gen/targetDigest reader coalesces identically); a
 *  future consumer reading either under a different coalescing MUST re-bind it strictly in a new version. */
function macCommon(r: MemoryRecord, keyId: string): Buffer[] {
  return [
    field(Buffer.from(keyId, 'hex')),
    str(r.type), str(r.id), str(r.supersedes), str(r.state),
    int(r.gen ?? 0), str(r.targetDigest ?? null),
  ];
}
// v1 FROZEN: literal version byte 1, NO tx. MUST NOT use MAC_VERSION (now 2), or every on-disk v1 breaks.
// Exported (with macInputV2) as pure byte builders for the golden input-hex vectors — no signing power
// without the subkey, and the input format is source-public anyway.
export function macInputV1(r: MemoryRecord, keyId: string): Buffer {
  return Buffer.concat([DOMAIN, Buffer.from([1]), ...macCommon(r, keyId)]);
}
// v2: version byte 2, tx appended (length-prefixed).
export function macInputV2(r: MemoryRecord, keyId: string): Buffer {
  return Buffer.concat([DOMAIN, Buffer.from([2]), ...macCommon(r, keyId), str(r.tx)]);
}
function macInputFor(version: number, r: MemoryRecord, keyId: string): Buffer {
  return version === 1 ? macInputV1(r, keyId) : macInputV2(r, keyId);
}

export function signVerify(record: MemoryRecord, subkey: Buffer): MemoryRecord {
  const keyId = keyIdOf(subkey);
  // STRICT at write time (NOT total): a malformed tx throws here, so a genuine v2 record can never be
  // minted malformed — which is what makes verifyVerify's read-side totality safe at compaction.
  const mac = createHmac('sha256', subkey).update(macInputV2(record, keyId)).digest('hex');
  return { ...record, mac, keyId, macVersion: MAC_VERSION };
}

/** TEST-ONLY: mint a v1-scheme signature so a test can prove dual-accept keeps legacy grades valid.
 *  Production always signs v2 via signVerify; NOTHING in src/ calls this (a test walks src/ to enforce it). */
export function signVerifyV1(record: MemoryRecord, subkey: Buffer): MemoryRecord {
  const keyId = keyIdOf(subkey);
  const mac = createHmac('sha256', subkey).update(macInputV1(record, keyId)).digest('hex');
  return { ...record, mac, keyId, macVersion: 1 };
}

export function verifyVerify(record: MemoryRecord, subkey: Buffer): boolean {
  if (!record.mac || !record.keyId) return false;
  // Dual-accept: dispatch on the record's own version. A numeric whitelist (not >= n) fails closed on an
  // unknown/absent/string-typed version — this is also what makes macVersion a safe projection lane key.
  if (typeof record.macVersion !== 'number' || !ACCEPTED_MAC_VERSIONS.has(record.macVersion)) return false;
  if (record.keyId !== keyIdOf(subkey)) return false;
  let want: Buffer;
  try {
    // Totality: parseLedger casts each JSONL line with NO type validation (ledger.ts), so a forged
    // non-string MAC-covered field (e.g. tx:{}) would make str()/int() throw. A malformed record must
    // be INVALID, never a crash — otherwise one junk line is a silent DoS (recall/hook/scan) or blocks
    // right-to-erasure at compaction.
    want = createHmac('sha256', subkey).update(macInputFor(record.macVersion, record, record.keyId)).digest();
  } catch {
    return false;
  }
  let got: Buffer;
  try { got = Buffer.from(record.mac, 'hex'); } catch { return false; }
  return got.length === want.length && timingSafeEqual(got, want);
}
