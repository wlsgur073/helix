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

import { mkdtempSync, writeFileSync, statSync, readFileSync } from 'node:fs';
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
