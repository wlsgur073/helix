import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Parse simple `key: value` YAML frontmatter (no nesting) + return the body. */
export function frontmatter(path: string): { fm: Record<string, string>; body: string } {
  const txt = readFileSync(join(root, path), 'utf8');
  const m = txt.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error(`no frontmatter in ${path}`);
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]!] = kv[2]!;
  }
  return { fm, body: txt.slice(m[0].length) };
}

describe('plugin manifest', () => {
  it('.claude-plugin/plugin.json is valid JSON with required fields', () => {
    const m = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8'));
    expect(m.name).toBe('helix');
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof m.description).toBe('string');
    expect(m.description.length).toBeGreaterThan(0);
  });
});

describe('persona output-style', () => {
  it('has the plugin frontmatter and names every load-bearing behavior', () => {
    const { fm, body } = frontmatter('output-styles/helix.md');
    expect(fm.name).toBe('Helix');
    expect('description' in fm).toBe(true);
    expect(fm['force-for-plugin']).toBe('true');
    expect(fm['keep-coding-instructions']).toBe('true');
    expect(body.length).toBeGreaterThan(800);
    for (const kw of ['counselor', 'programmer', 'engineer', 'architect',
                      'one continuous voice', 'self-critique', 'uncertain',
                      'English', '존댓말', '반말', '제안형', 'mode']) {
      expect(body, `persona must address "${kw}"`).toContain(kw);
    }
    expect(body).not.toMatch(/\/helix:(counselor|programmer|engineer|architect)/);
  });
});

describe('persona skill (non-Code surfaces)', () => {
  it('exists with frontmatter and restates the core persona contract', () => {
    const { fm, body } = frontmatter('skills/persona/SKILL.md');
    expect(fm.name).toBe('helix-persona');
    expect('description' in fm).toBe(true);
    for (const kw of ['one continuous voice', 'self-critique', '존댓말']) {
      expect(body.toLowerCase(), `persona skill must address "${kw}"`).toContain(kw);
    }
  });
});

describe('feedback skill', () => {
  it('exists with frontmatter and collects the three wedge signals', () => {
    const { fm, body } = frontmatter('skills/feedback/SKILL.md');
    expect(fm.name).toBe('feedback');
    expect('description' in fm).toBe(true);
    for (const kw of ['role', 'pushback', 'trust']) {
      expect(body.toLowerCase(), `feedback must collect "${kw}"`).toContain(kw);
    }
  });
});
