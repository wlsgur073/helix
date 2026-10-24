// Issue #10: Claude Code (2.1.287 and later) installs the runtime dependencies that a cache-installed
// plugin's package.json declares, from its lockfile, and when that package.json also sets `overrides` it
// refuses and notes on the installed plugin that its packages were not installed. bin/ is self-contained
// (build.mjs inlines the MCP SDK and zod), so Helix declares no runtime dependency: both are build inputs,
// listed as devDependencies. These checks fail the moment a runtime dependency field comes back.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<string, unknown>;
const isEmpty = (v: unknown): boolean =>
  v === undefined || (Array.isArray(v) ? v.length === 0 : Object.keys(v as object).length === 0);

describe('the plugin declares no runtime dependencies (issue #10)', () => {
  it('package.json has no dependencies, optionalDependencies, peerDependencies or workspaces', () => {
    const pkg = read('package.json');
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'workspaces']) {
      expect(isEmpty(pkg[field]), `package.json ${field}`).toBe(true);
    }
  });

  it('the MCP SDK and zod are devDependencies, the build inputs bin/ inlines', () => {
    expect(Object.keys(read('package.json').devDependencies as object)).toEqual(expect.arrayContaining(['@modelcontextprotocol/sdk', 'zod']));
  });

  it('package-lock.json agrees: its root lists no runtime dependency and every package is a dev package', () => {
    const packages = read('package-lock.json').packages as Record<string, { dependencies?: object; dev?: boolean; devOptional?: boolean }>;
    expect(isEmpty(packages['']!.dependencies)).toBe(true);
    expect(Object.entries(packages).filter(([path, p]) => path !== '' && !p.dev && !p.devOptional).map(([path]) => path)).toEqual([]);
  });
});
