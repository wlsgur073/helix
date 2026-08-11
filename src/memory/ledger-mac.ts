import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { openSync, fsyncSync, closeSync, readFileSync, linkSync, unlinkSync, statSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLock } from './lock.js';
import { fsyncDir, writeAll, realFsOps } from './fs-ops.js';
import { sweepOrphanTmps } from './ledger-sweep.js';
import type { MemoryRecord } from '../types.js';
import { ensureHelixDir } from './home-permissions.js';

export const MAC_VERSION = 2;                             // version NEW signatures carry
const ACCEPTED_MAC_VERSIONS = new Set<number>([1, 2]);   // versions verifyVerify treats as valid

/** Domain tag for the ill-formed lane. 0xFF is the load-bearing byte: it appears in the UTF-8
 *  encoding of NO code point, so no well-formed string's image can begin with it and the two lanes'
 *  images are disjoint BY CONSTRUCTION.
 *
 *  Do NOT make this tag readable. A printable tag is reachable as ordinary content, and then a
 *  well-formed string exists whose UTF-8 encoding IS <tag> ++ utf16le(ill) — the two lanes hash the
 *  same bytes and the substitution primitive this split removes comes back one lane over. Measured
 *  with a candidate tag of 'helix.digestContent.ill-formed.v1' + NUL: utf16le(U+D800 U+0080) is
 *  00 D8 80 00, whose middle pair is a valid two-byte UTF-8 sequence (U+0600), so that tag followed
 *  by U+0000 U+0000 U+0600 U+0000 is well-formed text encoding to exactly those bytes. Pinned by
 *  ledger-mac.test.ts, which keeps that pair as a regression case. */
const ILL_FORMED_TAG = Buffer.from([0xff, 0x01]);

/** Lowercase hex SHA-256 binding `content`. INJECTIVE over arbitrary JS strings.
 *
 *  Ill-formed content takes a separate, LOSSLESS lane. `Buffer.from(s, 'utf8')` maps every unpaired
 *  surrogate to U+FFFD, so `'x\uD800y'` and `'x\uD801y'` hashed that way are indistinguishable — and
 *  the binding this feeds is a bare `targetDigest === liveDigest` equality (verified-projection.ts),
 *  so a collision is enough for changed content to inherit a signed grade it was never granted. That
 *  breaks the invariant the grade rests on: any change to the content drops it. Note the substitute
 *  need not be ill-formed either: '\uD800' folds onto the well-formed U+FFFD too.
 *
 *  Well-formed content — everything a real caller produces — keeps the original UTF-8 path and
 *  therefore its existing digest, so no already-signed `targetDigest` is invalidated. Re-encoding
 *  wholesale would have invalidated all of them at once, and since `targetDigest` is MAC-covered and
 *  cannot be re-signed, every promotion would have become inapplicable and every Corroborated or
 *  Verified fact would have silently dropped to Fresh. Ill-formed content is bound over its UTF-16LE
 *  image, which is fixed-width and substitution-free and therefore injective. Deliberately fail
 *  closed: a legacy promotion signed over ILL-formed content stops applying and its row falls back to
 *  the R1 Fresh clamp (`compromised` stays false — a lost elevation, not tamper evidence). */
export function digestContent(content: string): string {
  // ES2024 method, present on every runtime package.json's `engines` admits (>=24). The cast is
  // because tsconfig pins `target: ES2022` with no `lib` override, not because it may be absent.
  const wellFormed = (content as unknown as { isWellFormed(): boolean }).isWellFormed();
  const bytes = wellFormed
    ? Buffer.from(content, 'utf8')
    : Buffer.concat([ILL_FORMED_TAG, Buffer.from(content, 'utf16le')]);
  return createHash('sha256').update(bytes).digest('hex');
}

export class LedgerMacError extends Error {}

const MASTER_LEN = 32;
function masterPath(home: string): string { return join(home, 'ledger-mac-master.key'); }

/** Atomic, idempotent: return the 32-byte master, creating it (mode 0600) under a lock on first
 *  use. Publication is linkSync — it can NEVER overwrite an existing key (create-once; there is no
 *  rotation feature), so even a double-held lock cannot rotate a key someone already signed with:
 *  the EEXIST loser adopts the winner's bytes. Source is fsynced BEFORE the link and the dir after,
 *  so no contender returns before the key durably exists. */
export function ensureMaster(home: string): Buffer {
  const path = masterPath(home);
  const existing = tryReadMasterStrict(path);
  if (existing) return existing;
  ensureHelixDir(home);
  return withFileLock(path, () => {
    const again = tryReadMasterStrict(path);   // re-check inside the lock (another process may have won)
    if (again) return again;
    sweepOrphanTmps(path, {});                 // a crashed prior mint's key-material tmp dies here
    const key = randomBytes(MASTER_LEN);
    const tmp = `${path}.k-${randomBytes(16).toString('hex')}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    let published = false;
    try {
      try { writeAll(realFsOps, fd, key); fsyncSync(fd); } finally { closeSync(fd); } // writeAll: loop short writes + guard zero-progress on the 32-byte key
      try {
        linkSync(tmp, path);
        published = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    } finally {
      try { unlinkSync(tmp); } catch { /* already gone (linked+cleaned), or swept concurrently */ }
    }
    fsyncDir(dirname(path));                   // winner AND loser: the key entry is durable before use
    if (published) return key;
    const winner = tryReadMasterStrict(path);  // loser: adopt the winner's key
    if (!winner) throw new LedgerMacError('master key vanished during concurrent mint');
    return winner;
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
