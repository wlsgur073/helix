import { describe, it, expect } from 'vitest';
import { fromSource } from '../../scripts/inventory/extract-tools.js';

describe('tool descriptions state the parent-directory rule (issue #1)', () => {
  it('commit scope and adopt say what happens below a parent project', async () => {
    // The source registry, not extractTools(): that one also demands the committed bundle agree, and
    // the bundle is rebuilt only after the server wiring lands.
    const tools = await fromSource();
    const commit = tools.find((t) => t.name === 'helix_memory_commit');
    const scope = (commit?.inputSchema as { properties?: Record<string, { description?: string }> }).properties?.scope?.description ?? '';
    expect(scope).toContain('parent-directory project');
    expect(scope).toContain('The result names the scope written.');
    const adopt = tools.find((t) => t.name === 'helix_memory_adopt');
    expect(adopt?.description ?? '').toContain('nearest at or above');
    // Final review: the parent case needs the same "only one you recognize" limit as a foreign ledger.
    expect(adopt?.description ?? '').toContain('or a parent project they created');
    expect(adopt?.description ?? '').toContain('never one in a shared directory');
  });
});
