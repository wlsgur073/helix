import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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

describe('.mcp.json (plugin MCP registration)', () => {
  it('registers the helix stdio server at the plugin-format top level (no mcpServers wrapper)', () => {
    const m = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(m.mcpServers).toBeUndefined(); // plugin format: server names at top level
    expect(m.helix.command).toBe('node');
    expect(m.helix.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/bin/helix-mcp.mjs']);
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
