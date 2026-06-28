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
