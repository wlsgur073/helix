import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('plugin manifest', () => {
  it('.claude-plugin/plugin.json is valid JSON with required fields', () => {
    const m = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8'));
    expect(m.name).toBe('helix');
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof m.description).toBe('string');
    expect(m.description.length).toBeGreaterThan(0);
  });
});

describe('plugin MCP registration (.claude-plugin/plugin.json mcpServers)', () => {
  // MCP is declared inline in the plugin manifest (not a repo-root .mcp.json). A repo-root
  // .mcp.json would ALSO be loaded as a project-scoped MCP config, where ${CLAUDE_PLUGIN_ROOT}
  // is undefined — /doctor then warns "Missing environment variables". Inline plugin.json is
  // only ever read in plugin context, where the variable resolves.
  it('registers the helix stdio server inline in the plugin manifest', () => {
    const m = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8'));
    expect(m.mcpServers.helix.command).toBe('node');
    expect(m.mcpServers.helix.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/bin/helix-mcp.mjs']);
  });

  it('no repo-root .mcp.json exists (would dual-load as a project-scoped config)', () => {
    // Guard the migration: a reintroduced repo-root .mcp.json is also scanned as a
    // project-scoped MCP config, where ${CLAUDE_PLUGIN_ROOT} is undefined → /doctor warns.
    // `claude plugin validate` does not inspect MCP structure, so this test is the only guard.
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
  });

  it('the referenced server bundle exists (committed, self-contained)', () => {
    expect(existsSync(join(root, 'bin/helix-mcp.mjs'))).toBe(true);
  });
});

describe('hooks/hooks.json (plugin hooks registration)', () => {
  it('uses the plugin wrapper format with SessionStart and SessionEnd command hooks', () => {
    const h = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8'));
    expect(h.hooks).toBeDefined(); // plugin format: events nested under "hooks"
    const start = h.hooks.SessionStart[0].hooks[0];
    const end = h.hooks.SessionEnd[0].hooks[0];
    expect(start.type).toBe('command');
    expect(start.command).toContain('${CLAUDE_PLUGIN_ROOT}/bin/hooks/session-start.mjs');
    expect(end.type).toBe('command');
    expect(end.command).toContain('${CLAUDE_PLUGIN_ROOT}/bin/hooks/session-end.mjs');
  });

  it('both referenced hook bundles exist (committed, builtins-only)', () => {
    expect(existsSync(join(root, 'bin/hooks/session-start.mjs'))).toBe(true);
    expect(existsSync(join(root, 'bin/hooks/session-end.mjs'))).toBe(true);
  });
});

describe('committed bundles are fresh', () => {
  // Rebuild from current src into a temp dir and byte-compare against the committed bin/.
  // This catches the real failure mode: a dev edits src, runs green tests, and commits
  // without rebuilding — shipping a stale bundle. (esbuild is deterministic for a fixed
  // version + input, so identical src reproduces identical bytes.)
  it('rebuilding from src reproduces bin/ byte-for-byte (else: run npm run build)', () => {
    const out = mkdtempSync(join(tmpdir(), 'helix-freshbuild-'));
    execFileSync(process.execPath, [join(root, 'build.mjs')], {
      cwd: root, env: { ...process.env, HELIX_BUILD_OUT: out }, stdio: 'ignore',
    });
    for (const rel of ['helix-mcp.mjs', 'helix-trigger.mjs', 'helix-rebaseline.mjs', 'hooks/session-start.mjs', 'hooks/session-end.mjs']) {
      const committed = readFileSync(join(root, 'bin', rel));
      const rebuilt = readFileSync(join(out, rel));
      expect(rebuilt.equals(committed), `bin/${rel} is stale — run npm run build and commit bin/`).toBe(true);
    }
  }, 30_000);
});
