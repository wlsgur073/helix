import { describe, it, expect } from 'vitest';
import { digestContent } from '../../src/memory/ledger-mac.js';

describe('digestContent', () => {
  it('is a stable lowercase hex sha-256 over the UTF-8 bytes', () => {
    expect(digestContent('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
  it('is byte-sensitive: any change flips the digest', () => {
    expect(digestContent('a')).not.toBe(digestContent('A'));
  });
});

import { mkdtempSync, writeFileSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMaster, tryReadMaster, deriveSubkey, keyIdOf, LedgerMacError } from '../../src/memory/ledger-mac.js';

const tmpHome = () => mkdtempSync(join(tmpdir(), 'helix-home-'));

describe('ensureMaster', () => {
  it('creates a 32-byte master mode 0600, idempotently returns the same bytes', () => {
    const home = tmpHome();
    const a = ensureMaster(home);
    expect(a).toHaveLength(32);
    expect(statSync(join(home, 'ledger-mac-master.key')).mode & 0o777).toBe(0o600);
    const b = ensureMaster(home);
    expect(b.equals(a)).toBe(true);
  });
  it('rejects an existing master of the wrong length (fail-closed, never trusts a corrupt key)', () => {
    const home = tmpHome();
    writeFileSync(join(home, 'ledger-mac-master.key'), Buffer.alloc(7), { mode: 0o600 });
    expect(() => ensureMaster(home)).toThrow(LedgerMacError);
  });
  it('tryReadMaster returns null when absent, the bytes when present', () => {
    const home = tmpHome();
    expect(tryReadMaster(home)).toBeNull();
    const m = ensureMaster(home);
    expect(tryReadMaster(home)!.equals(m)).toBe(true);
  });
  it('creates a valid master with the dir fsync in place and stays idempotent', () => {
    const home = tmpHome();
    const a = ensureMaster(home);
    expect(a).toHaveLength(32);
    expect(tryReadMaster(home)!.equals(a)).toBe(true);
    expect(statSync(join(home, 'ledger-mac-master.key')).mode & 0o777).toBe(0o600);
    expect(ensureMaster(home).equals(a)).toBe(true);
  });
});

describe('deriveSubkey / keyIdOf', () => {
  it('derives a 32-byte subkey deterministic in (master, nonce)', () => {
    const m = Buffer.alloc(32, 1);
    const k1 = deriveSubkey(m, 'nonce-a');
    expect(k1).toHaveLength(32);
    expect(deriveSubkey(m, 'nonce-a').equals(k1)).toBe(true);
    expect(deriveSubkey(m, 'nonce-b').equals(k1)).toBe(false); // project-bound
  });
  it('keyId is an 8-byte hex derived from the SUBKEY (per-project, not cross-linkable)', () => {
    const m = Buffer.alloc(32, 1);
    const id = keyIdOf(deriveSubkey(m, 'nonce-a'));
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(keyIdOf(deriveSubkey(m, 'nonce-b'))).not.toBe(id);
  });
});

import { signVerify, signVerifyV1, verifyVerify, macInputV1, macInputV2, digestContent as dc } from '../../src/memory/ledger-mac.js';
import type { MemoryRecord } from '../../src/types.js';

function verifyRec(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'v1', tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
    type: 'verify', state: 'Verified', content: '', provenance: { source: 'user', sessionId: 's' },
    supersedes: 'target1', blastRadius: null, reverifyTrigger: null, classification: 'normal',
    gen: 1, targetDigest: dc('the fact'), ...overrides,
  };
}

describe('signVerify / verifyVerify', () => {
  it('a freshly signed record verifies under the same subkey', () => {
    const k = deriveSubkey(Buffer.alloc(32, 9), 'proj');
    const signed = signVerify(verifyRec(), k);
    expect(signed.macVersion).toBe(2);
    expect(signed.keyId).toBe(keyIdOf(k));
    expect(verifyVerify(signed, k)).toBe(true);
  });
  it('fails under a different subkey (project binding)', () => {
    const signed = signVerify(verifyRec(), deriveSubkey(Buffer.alloc(32, 9), 'proj-A'));
    expect(verifyVerify(signed, deriveSubkey(Buffer.alloc(32, 9), 'proj-B'))).toBe(false);
  });
  it('fails when any covered field is tampered (grade, target, gen, targetDigest)', () => {
    const k = deriveSubkey(Buffer.alloc(32, 9), 'proj');
    const signed = signVerify(verifyRec(), k);
    expect(verifyVerify({ ...signed, state: 'Corroborated' }, k)).toBe(false);
    expect(verifyVerify({ ...signed, supersedes: 'target2' }, k)).toBe(false);
    expect(verifyVerify({ ...signed, gen: 2 }, k)).toBe(false);
    expect(verifyVerify({ ...signed, targetDigest: dc('other') }, k)).toBe(false);
    expect(verifyVerify({ ...signed, tx: '2099-01-01T00:00:00.000Z' }, k)).toBe(false); // v2 binds tx
  });
  it('fails for an unsigned record or a length-collision attempt', () => {
    const k = deriveSubkey(Buffer.alloc(32, 9), 'proj');
    expect(verifyVerify(verifyRec(), k)).toBe(false); // no mac
    // length-prefix integrity: moving a char across the id/target boundary must not re-validate
    const a = signVerify(verifyRec({ id: 'ab', supersedes: 'c' }), k);
    expect(verifyVerify({ ...a, id: 'a', supersedes: 'bc' }, k)).toBe(false);
  });
  it('dual-accepts a v1 signature (legacy grade preserved), and v1 tx stays forgeable', () => {
    const k = deriveSubkey(Buffer.alloc(32, 9), 'proj');
    const v1 = signVerifyV1(verifyRec(), k);
    expect(v1.macVersion).toBe(1);
    expect(verifyVerify(v1, k)).toBe(true);                                          // v1 still valid
    expect(verifyVerify({ ...v1, tx: '2099-01-01T00:00:00.000Z' }, k)).toBe(true);   // v1 does NOT bind tx
  });
  it('v1 stays valid even when tx is malformed or absent (v1 lane never reads tx — spec §5/F1)', () => {
    // REQUIRED, not incidental: if v1 validity depended on tx, an unauthenticated field would control
    // grade validity and an adversary could destroy genuine v1 grades by editing tx to junk.
    const k = deriveSubkey(Buffer.alloc(32, 9), 'proj');
    const v1 = signVerifyV1(verifyRec(), k);
    expect(verifyVerify({ ...v1, tx: {} as unknown as string }, k)).toBe(true);
    expect(verifyVerify({ ...v1, tx: undefined as unknown as string }, k)).toBe(true);
  });
  it('benign malleability: gen 0/null/absent and targetDigest null/absent are MAC-equivalent (spec §3)', () => {
    const k = deriveSubkey(Buffer.alloc(32, 9), 'proj');
    const signed = signVerify(verifyRec({ gen: 0, targetDigest: undefined }), k); // absent digest -> NULL_FIELD
    expect(verifyVerify({ ...signed, gen: null as unknown as number }, k)).toBe(true);
    expect(verifyVerify({ ...signed, gen: undefined }, k)).toBe(true);
    expect(verifyVerify({ ...signed, targetDigest: null as unknown as string }, k)).toBe(true); // null == absent
    expect(verifyVerify({ ...signed, targetDigest: undefined }, k)).toBe(true);
  });
  it('rejects a version-downgrade/upgrade forgery (denial only, never elevation)', () => {
    const k = deriveSubkey(Buffer.alloc(32, 9), 'proj');
    const v2 = signVerify(verifyRec(), k);
    const v1 = signVerifyV1(verifyRec(), k);
    expect(verifyVerify({ ...v2, macVersion: 1 }, k)).toBe(false);   // v2 mac vs v1 input
    expect(verifyVerify({ ...v1, macVersion: 2 }, k)).toBe(false);   // v1 mac vs v2 input
  });
  it('rejects an unknown, absent, or wrong-TYPE MAC version', () => {
    const k = deriveSubkey(Buffer.alloc(32, 9), 'proj');
    const v2 = signVerify(verifyRec(), k);
    expect(verifyVerify({ ...v2, macVersion: 3 }, k)).toBe(false);
    expect(verifyVerify({ ...v2, macVersion: undefined }, k)).toBe(false);
    expect(verifyVerify({ ...v2, macVersion: '2' as unknown as number }, k)).toBe(false); // JSON type confusion
  });
  it('is total: a malformed or absent MAC-covered field makes it false, never throws', () => {
    const k = deriveSubkey(Buffer.alloc(32, 9), 'proj');
    const v2 = signVerify(verifyRec(), k);
    expect(() => verifyVerify({ ...v2, tx: {} as unknown as string }, k)).not.toThrow();
    expect(verifyVerify({ ...v2, tx: {} as unknown as string }, k)).toBe(false);
    expect(verifyVerify({ ...v2, tx: undefined as unknown as string }, k)).toBe(false);
  });
  it('signVerify stays STRICT at write time: a malformed tx throws (genuine v2 cannot be minted malformed)', () => {
    const k = deriveSubkey(Buffer.alloc(32, 9), 'proj');
    expect(() => signVerify(verifyRec({ tx: {} as unknown as string }), k)).toThrow();
  });
  it('mechanical fence: signVerifyV1 is referenced nowhere in src/ outside its defining module', () => {
    const files = readdirSync('src', { recursive: true }) as string[];
    const offenders = files
      .filter((f) => f.endsWith('.ts') && !f.endsWith('ledger-mac.ts'))
      .filter((f) => readFileSync(join('src', f), 'utf8').includes('signVerifyV1'));
    expect(offenders).toEqual([]);
  });
});
