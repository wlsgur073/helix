import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOwned, stampOwnership, projectLedgerPath } from '../../src/memory/ownership.js';

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
    expect(reg[proj].stamp).toBe('STAMP1');
    expect(isOwned(proj, home)).toBe(true);
  });

  it('stamp mismatch (.owner != registry) is not owned', () => {
    const { home, proj } = dirs();
    stampOwnership(proj, home, { genStamp: () => 'REAL' });
    writeFileSync(join(proj, '.helix', '.owner'), 'TAMPERED');
    expect(isOwned(proj, home)).toBe(false);
  });
});
