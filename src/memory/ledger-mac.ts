import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, renameSync, statSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLock } from './lock.js';

export const MAC_VERSION = 1;

/** Lowercase hex SHA-256 over the UTF-8 bytes of `content`. Used for the content binding. */
export function digestContent(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

export class LedgerMacError extends Error {}

const MASTER_LEN = 32;
function masterPath(home: string): string { return join(home, 'ledger-mac-master.key'); }

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
    renameSync(tmp, path); // atomic on the same filesystem
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
