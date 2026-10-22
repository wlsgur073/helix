// Issue #4: README shows the server instructions text a user can turn on, so its quote must be the text
// the server actually sends. The quote is compared with the shipped constant, line for line.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_INSTRUCTIONS } from '../../src/server/instructions.js';
import { SUPERSEDE_NOTE } from '../../src/memory/content-frame.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const readme = (): string => readFileSync(join(ROOT, 'README.md'), 'utf8');

describe('README and the server instructions (issue #4)', () => {
  it('README quotes the shipped instructions text exactly', () => {
    expect(readme().split('\n')).toContain(`> ${SERVER_INSTRUCTIONS}`);
  });

  // Review I-1: the default SessionStart block names helix_memory_recall (the supersede note, and the
  // "+N more" line), so README's never-tells claim may cover helix_memory_commit only.
  it('README limits its never-tells claim to helix_memory_commit', () => {
    expect(SUPERSEDE_NOTE).toContain('helix_memory_recall');
    expect(readme()).not.toContain('*when* to reach for its tools');
    expect(readme()).toContain('never tells your assistant *when* to store a fact with `helix_memory_commit`');
  });

  // Review M-2: an empty current view says nothing about history; soft-erased records stay on disk.
  it('README does not read an empty inspect view as proof that nothing was ever stored', () => {
    expect(readme()).not.toContain('whether anything has been stored at all');
    expect(readme()).toContain('whether Helix holds any live memory');
  });

  // Review M-4: like anything in CLAUDE.md, the routing rule is context, and its effect is unmeasured.
  it('README does not present the routing rule as reliable', () => {
    expect(readme()).toContain('how reliably it routes requests to Helix has not been measured');
  });
});
