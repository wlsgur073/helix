import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A wall-clock assertion here would flake on a loaded box. What is actually being pinned is that
// the fixed cost is paid at startup rather than on a request: the entry point must call the loader
// itself, after the transport is connected and before the loop can dispatch a handler.
describe('the semantic asset is warmed at server start, not on the first recall', () => {
  it('the entry point calls defaultExpansion after connecting the transport', () => {
    const src = readFileSync(join(ROOT, 'src/server/index.ts'), 'utf8');
    const connect = src.indexOf('await server.connect(transport);');
    const warm = src.indexOf('defaultExpansion();');
    expect(connect, 'the transport connect line moved').toBeGreaterThan(-1);
    expect(warm, 'nothing warms the semantic asset at startup').toBeGreaterThan(-1);
    expect(warm, 'the warm-up must follow connect, so it never delays the transport').toBeGreaterThan(connect);
  });
});
