// Third fix batch B1, task A1 (design 4.1 item 1, section 3, section 7 commit 1): the path helpers live in
// path-identity.ts, which imports node builtins only; ownership.ts exports the two public ones again as the
// SAME bindings, so no caller moves.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as pathIdentity from '../../src/memory/path-identity.js';
import * as ownership from '../../src/memory/ownership.js';

const SOURCE = readFileSync(fileURLToPath(new URL('../../src/memory/path-identity.ts', import.meta.url)), 'utf8');

/** Every module specifier the file names: static imports and re-exports (with or without bindings), side-effect
 *  imports, dynamic import() and require(). */
function specifiersOf(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) out.push(m[1]!);
  return out;
}

describe('path-identity.ts (A1: the moved helpers)', () => {
  it('imports node builtins only (design section 3)', () => {
    const specs = specifiersOf(SOURCE);
    expect(specs).toContain('node:fs');
    expect(specs).toContain('node:path');
    expect(specs.filter((s) => !s.startsWith('node:'))).toEqual([]);
  });

  it('exports canonicalRoot and ledgerDestination, and ownership.ts exports the same bindings', () => {
    expect(typeof pathIdentity.canonicalRoot).toBe('function');
    expect(typeof pathIdentity.ledgerDestination).toBe('function');
    expect(ownership.canonicalRoot).toBe(pathIdentity.canonicalRoot);
    expect(ownership.ledgerDestination).toBe(pathIdentity.ledgerDestination);
  });

  it('the helpers that stay private are not exported from either module (A2 reuses them inside the module)', () => {
    for (const name of ['utf8OrNull', 'physicalPath', 'isNameTooLong', 'registryKeyPath', 'MAX_SYMLINK_HOPS']) {
      expect(name in pathIdentity, name).toBe(false);
      expect(name in ownership, name).toBe(false);
    }
  });
});
