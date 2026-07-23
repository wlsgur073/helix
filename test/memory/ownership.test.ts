import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isOwned, stampOwnership, projectLedgerPath, scopeNonce, globalScopeNonce } from '../../src/memory/ownership.js';

function dirs() {
  const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
  const proj = mkdtempSync(join(tmpdir(), 'helix-proj-'));
  return { home, proj };
}

describe('ownership', () => {
  it('projectLedgerPath points at <root>/.helix/memory.jsonl', () => {
    expect(projectLedgerPath('/x/y')).toBe(join('/x/y', '.helix', 'memory.jsonl'));
  });

  it('a fresh project is not owned', () => {
    const { home, proj } = dirs();
    expect(isOwned(proj, home)).toBe(false);
  });

  it('stampOwnership makes the project owned (registry + .owner match)', () => {
    const { home, proj } = dirs();
    stampOwnership(proj, home, { now: () => '2026-06-17T00:00:00.000Z', genStamp: () => 'STAMP1' });
    expect(existsSync(join(proj, '.helix', '.owner'))).toBe(true);
    expect(readFileSync(join(proj, '.helix', '.owner'), 'utf8')).toBe('STAMP1');
    const reg = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8'));
    expect(reg[resolve(proj)].stamp).toBe('STAMP1');
    expect(isOwned(proj, home)).toBe(true);
  });

  it('stamp mismatch (.owner != registry) is not owned', () => {
    const { home, proj } = dirs();
    stampOwnership(proj, home, { genStamp: () => 'REAL' });
    writeFileSync(join(proj, '.helix', '.owner'), 'TAMPERED');
    expect(isOwned(proj, home)).toBe(false);
  });
});

describe('ownership macNonce (project-binding salt)', () => {
  it('stampOwnership records a home-only macNonce; scopeNonce returns it', () => {
    const { home, proj } = dirs();
    stampOwnership(proj, home, { genStamp: () => 'deadbeef' });
    expect(scopeNonce(proj, home)).toMatch(/^[0-9a-f]+$/);
    expect(scopeNonce(proj, home)).not.toBe(''); // present
  });

  it('macNonce lives in the home registry, never in the repo .owner file', () => {
    const { home, proj } = dirs();
    // distinct draws so stamp != macNonce: first draw -> .owner stamp, second -> macNonce
    let n = 0;
    stampOwnership(proj, home, { genStamp: () => (n++ === 0 ? 'aaaa1111' : 'bbbb2222') });
    expect(scopeNonce(proj, home)).toBe('bbbb2222');
    const owner = readFileSync(join(proj, '.helix', '.owner'), 'utf8');
    expect(owner).toBe('aaaa1111');
    expect(owner).not.toContain('bbbb2222');
    const reg = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8'));
    expect(reg[resolve(proj)].macNonce).toBe('bbbb2222');
  });

  it('scopeNonce is null for an unowned project', () => {
    const { home, proj } = dirs(); // not stamped
    expect(scopeNonce(proj, home)).toBeNull();
  });

  it('globalScopeNonce is stable across calls', () => {
    const { home } = dirs();
    const a = globalScopeNonce(home);
    expect(globalScopeNonce(home)).toBe(a);
  });
});

describe('auto-adopt TOCTOU guard (targetLedger)', () => {
  it('refuses auto-adoption when a foreign ledger already exists at stamp time (re-checked under the lock)', () => {
    const { home, proj } = dirs();
    const ledger = join(proj, '.helix', 'memory.jsonl');
    mkdirSync(join(proj, '.helix'), { recursive: true });
    writeFileSync(ledger, '{"foreign":true}\n'); // a ledger Helix did not create
    // auto-adopt (targetLedger's first-use path) must NOT silently adopt a foreign ledger that
    // appeared in the check-then-stamp window.
    expect(() => stampOwnership(proj, home, { autoAdoptLedger: ledger })).toThrow(/did not create|adopt/i);
  });

  it('auto-adopt still succeeds when no ledger exists (the normal first-use path)', () => {
    const { home, proj } = dirs();
    const ledger = join(proj, '.helix', 'memory.jsonl'); // does not exist
    stampOwnership(proj, home, { autoAdoptLedger: ledger });
    expect(isOwned(proj, home)).toBe(true);
  });
});

describe('re-adoption preserves the nonce; deletion-safety is the compaction chokepoint (F6)', () => {
  it('preserves stamp+nonce and restores .owner even when the current .owner mismatches (no brick)', () => {
    const { home, proj } = dirs();
    stampOwnership(proj, home);
    const n1 = scopeNonce(proj, home);
    const stamp1 = readFileSync(join(proj, '.helix', '.owner'), 'utf8');
    // A lost/tampered .owner (or a foreign repo at a reused path): earlier this THREW and bricked a
    // legitimate repair. Now it preserves the nonce (so genuine verifies keep validating) and restores
    // .owner to the entry's stamp. Safety against a foreign repo's records is the compaction chokepoint
    // (a wrong key deletes nothing) plus the read-path clamp (foreign records stay Fresh), not a refusal.
    writeFileSync(join(proj, '.helix', '.owner'), 'MISMATCH');
    stampOwnership(proj, home);
    expect(scopeNonce(proj, home)).toBe(n1);
    expect(readFileSync(join(proj, '.helix', '.owner'), 'utf8')).toBe(stamp1);
    expect(isOwned(proj, home)).toBe(true);
  });

  it('idempotent re-adopt of a still-owned project preserves stamp+nonce', () => {
    const { home, proj } = dirs();
    stampOwnership(proj, home);
    const n1 = scopeNonce(proj, home);
    stampOwnership(proj, home);
    expect(scopeNonce(proj, home)).toBe(n1);
    expect(isOwned(proj, home)).toBe(true);
  });
});

describe('project identity is canonical — path aliases map to one nonce (F4)', () => {
  it('adopting the same physical project via a symlink alias reuses ONE nonce, not two', () => {
    const { home } = dirs();
    const realProj = mkdtempSync(join(tmpdir(), 'helix-realproj-'));
    const aliasParent = mkdtempSync(join(tmpdir(), 'helix-alias-'));
    const aliasProj = join(aliasParent, 'link');
    symlinkSync(realProj, aliasProj); // aliasProj resolves to the SAME physical directory as realProj
    stampOwnership(realProj, home);
    const n1 = scopeNonce(realProj, home);
    stampOwnership(aliasProj, home); // adopting via the alias must NOT mint a second nonce
    expect(scopeNonce(aliasProj, home)).toBe(n1);
    expect(scopeNonce(realProj, home)).toBe(n1);
    expect(isOwned(aliasProj, home)).toBe(true);
    const reg = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8'));
    expect(Object.keys(reg).filter((k) => k !== '@global')).toHaveLength(1); // one physical project -> one entry
  });
});

describe('adoption is symlink-safe (F5/F7)', () => {
  it('a symlinked .owner is NOT followed — adoption never overwrites the symlink target', () => {
    const { home, proj } = dirs();
    mkdirSync(join(proj, '.helix'), { recursive: true });
    const victim = join(home, 'victim.txt');
    mkdirSync(home, { recursive: true });
    writeFileSync(victim, 'ORIGINAL-SECRET');
    symlinkSync(victim, join(proj, '.helix', '.owner')); // hostile: .owner -> arbitrary file
    stampOwnership(proj, home);
    expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL-SECRET'); // untouched
    expect(lstatSync(join(proj, '.helix', '.owner')).isSymbolicLink()).toBe(false); // replaced by a real file
    expect(isOwned(proj, home)).toBe(true); // adoption still succeeded
  });

  it('refuses to write .owner through a symlinked .helix parent directory (H2)', () => {
    const { home, proj } = dirs();
    const evil = mkdtempSync(join(tmpdir(), 'helix-evil-'));
    symlinkSync(evil, join(proj, '.helix')); // hostile: .helix -> attacker-controlled dir
    expect(() => stampOwnership(proj, home)).toThrow(/\.helix|symlink/i);
  });

  it('refuses to write through a symlinked registry (projects.json is a symlink)', () => {
    const { home, proj } = dirs();
    mkdirSync(home, { recursive: true });
    const real = join(home, 'real-registry.json');
    writeFileSync(real, '{}');
    symlinkSync(real, join(home, 'projects.json')); // a symlinked registry splits the file lock
    expect(() => stampOwnership(proj, home)).toThrow(/symlink|registry/i);
  });
});

describe('registry robustness — unreadable + malformed (F1/F2)', () => {
  const reg = (home: string) => join(home, 'projects.json');

  it('a present-but-UNREADABLE registry (EISDIR, not ENOENT) is not treated as absent — globalScopeNonce fails closed', () => {
    const { home } = dirs();
    mkdirSync(reg(home)); // reading a directory throws EISDIR -> unreadable, must NOT mint over it
    expect(globalScopeNonce(home)).toBeNull();
  });

  it('a present-but-unreadable registry makes stampOwnership fail closed (no clobber)', () => {
    const { home, proj } = dirs();
    mkdirSync(reg(home));
    expect(() => stampOwnership(proj, home)).toThrow(/registry/i);
  });

  it('a truly ABSENT (ENOENT) registry still mints a first nonce', () => {
    const { home } = dirs(); // no projects.json at all
    expect(globalScopeNonce(home)).toMatch(/^[0-9a-f]+$/);
  });

  it('valid-JSON but non-object registries ([], null, string, number) are corrupt: never mint, never throw on read', () => {
    for (const bad of ['[]', 'null', '"x"', '42']) {
      const { home, proj } = dirs();
      writeFileSync(reg(home), bad);
      expect(globalScopeNonce(home), `mint on ${bad}`).toBeNull();      // never mints into a non-object
      expect(() => isOwned(proj, home), `isOwned on ${bad}`).not.toThrow(); // null[key] must not throw
      expect(isOwned(proj, home)).toBe(false);
      expect(scopeNonce(proj, home)).toBeNull();
    }
  });

  it('an entry with a non-string macNonce is treated as corrupt (stampOwnership fails closed)', () => {
    const { home, proj } = dirs();
    writeFileSync(reg(home), JSON.stringify({ [resolve(proj)]: { stamp: 'x', adoptedAt: 't', macNonce: 123 } }));
    expect(() => stampOwnership(proj, home)).toThrow(/registry/i);
  });
});

describe('globalScopeNonce fail-closed on corrupt registry (PR-1)', () => {
  it('does not re-mint (overwrite) the nonce when the registry is present but unparseable', () => {
    const { home } = dirs();
    const n1 = globalScopeNonce(home); // mints and persists a real nonce
    expect(n1).toMatch(/^[0-9a-f]+$/);
    // Simulate a torn read: the registry exists on disk but a concurrent in-place writeFileSync
    // left it mid-truncation. Today readRegistry swallows the parse error as {} -> globalScopeNonce
    // mints a NEW nonce and OVERWRITES the file, silently invalidating every global verify.
    writeFileSync(join(home, 'projects.json'), '{ "@global": { "macNonce": "');
    const n2 = globalScopeNonce(home);
    expect(n2).toBeNull(); // fail-closed: unresolvable -> key-absent (clamp to Fresh), never overwrite
    // and the corrupt file must NOT have been replaced by a fresh valid registry
    expect(readFileSync(join(home, 'projects.json'), 'utf8')).toBe('{ "@global": { "macNonce": "');
  });

  it('still mints on first use when the registry is simply absent', () => {
    const { home } = dirs();
    expect(globalScopeNonce(home)).toMatch(/^[0-9a-f]+$/);
  });
});

describe('stampOwnership fail-closed on corrupt registry (PR-1)', () => {
  it('refuses to clobber a present-but-corrupt registry (no silent loss of other adoptions)', () => {
    const { home, proj } = dirs();
    const other = mkdtempSync(join(tmpdir(), 'helix-proj-'));
    stampOwnership(other, home, { genStamp: () => 'OTHER' }); // a prior adoption exists on disk
    writeFileSync(join(home, 'projects.json'), '{ corrupt not json'); // torn/corrupt registry
    // Today readRegistry swallows the parse error as {} and stampOwnership writes a registry
    // containing ONLY the new project — 'other' silently vanishes. Fail closed instead.
    expect(() => stampOwnership(proj, home)).toThrow(/registry/i);
    expect(readFileSync(join(home, 'projects.json'), 'utf8')).toBe('{ corrupt not json');
  });
});

describe('ownership re-adoption idempotency (PR-1)', () => {
  it('re-adopting an already-registered project preserves the macNonce and stamp (existing signed verifies stay valid)', () => {
    const { home, proj } = dirs();
    stampOwnership(proj, home);
    const nonce1 = scopeNonce(proj, home);
    const stamp1 = readFileSync(join(proj, '.helix', '.owner'), 'utf8');
    // Re-adopting the SAME already-registered project must NOT mint fresh crypto material:
    // a new macNonce would silently invalidate (and, on the next compaction, delete) every
    // verify signed under the old subkey. Adoption of a FOREIGN ledger still mints fresh.
    stampOwnership(proj, home);
    expect(scopeNonce(proj, home)).toBe(nonce1);
    expect(readFileSync(join(proj, '.helix', '.owner'), 'utf8')).toBe(stamp1);
    expect(isOwned(proj, home)).toBe(true);
  });
});
