import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, renameSync, statSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLock } from './lock.js';
import type { MemoryRecord } from '../types.js';

export const MAC_VERSION = 1;

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

/** The exact bytes the MAC covers — fixed field order, length-prefixed, no JSON.
 *
 *  Authenticated: DOMAIN, MAC_VERSION, keyId, type, id, supersedes, state, gen, targetDigest.
 *  Intentionally UNAUTHENTICATED (not bound by the MAC): tx, validFrom, validTo, provenance,
 *  blastRadius, reverifyTrigger, classification. This is benign ONLY because of a load-bearing
 *  INVARIANT: none of these unauthenticated fields may EVER be consulted for a trust decision or
 *  for gen ordering on replay. gen is the sole ordering key; the asset's own tx is used only as a
 *  display tiebreaker on records that are not MAC-protected. A future change that starts trusting
 *  any of them (e.g. a tx tiebreaker for equal-gen records) MUST first add that field to the
 *  authenticated set above — otherwise it becomes attacker-forgeable. */
function macInput(r: MemoryRecord, keyId: string): Buffer {
  return Buffer.concat([
    DOMAIN, Buffer.from([MAC_VERSION]), field(Buffer.from(keyId, 'hex')),
    str(r.type), str(r.id), str(r.supersedes), str(r.state),
    int(r.gen ?? 0), str(r.targetDigest ?? null),
  ]);
}

export function signVerify(record: MemoryRecord, subkey: Buffer): MemoryRecord {
  const keyId = keyIdOf(subkey);
  const mac = createHmac('sha256', subkey).update(macInput(record, keyId)).digest('hex');
  return { ...record, mac, keyId, macVersion: MAC_VERSION };
}

export function verifyVerify(record: MemoryRecord, subkey: Buffer): boolean {
  if (record.macVersion !== MAC_VERSION || !record.mac || !record.keyId) return false;
  if (record.keyId !== keyIdOf(subkey)) return false;
  const want = createHmac('sha256', subkey).update(macInput(record, record.keyId)).digest();
  let got: Buffer;
  try { got = Buffer.from(record.mac, 'hex'); } catch { return false; }
  return got.length === want.length && timingSafeEqual(got, want);
}
