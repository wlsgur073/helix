import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
