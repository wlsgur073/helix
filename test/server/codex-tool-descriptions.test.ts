import { describe, it, expect } from 'vitest';
import { fromSource } from '../../scripts/inventory/extract-tools.js';

describe('Codex tool descriptions say what is checked and what is sent (H12, H13)', () => {
  it('helix_codex_status says the stored login is not checked with the server (H12)', async () => {
    // The source registry, not extractTools(): that one also demands the committed bundle agree, and
    // the bundle is rebuilt only in the build task.
    const tools = await fromSource();
    const d = tools.find((t) => t.name === 'helix_codex_status')?.description ?? '';
    expect(d).toContain('not checked with the server');
    expect(d).not.toContain('connected to Codex');
  });
});
