// Every path a maintained document points at must exist. Since 2026-09-26 docs/release/ holds one
// file, the release record, and it is maintained like the rest. The records it replaced are in git
// history, and its "Source records" section says where; a backticked path is prose, not a link, so
// it is not swept here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { relativeLinkTargets, brokenLinks } from '../helpers/doc-links.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const MAINTAINED = [
  'README.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'docs/release/README.md',
] as const;

describe('maintained documents', () => {
  it('point only at paths that exist', () => {
    const broken: string[] = [];
    for (const file of MAINTAINED) {
      const md = readFileSync(resolve(ROOT, file), 'utf8');
      broken.push(...brokenLinks(ROOT, file, md).map((t) => `${file} -> ${t}`));
    }
    expect(broken, 'a maintained document links to a path that does not exist').toEqual([]);
  });

  it('actually look at links (guards an empty sweep)', () => {
    const total = MAINTAINED.reduce(
      (n, f) => n + relativeLinkTargets(readFileSync(resolve(ROOT, f), 'utf8')).length, 0);
    expect(total).toBeGreaterThan(5);
  });

  // Negative controls: does the checker detect a break, and does it ignore what it should?
  it('reports a link whose target is absent', () => {
    expect(brokenLinks(ROOT, 'README.md', '[x](./does-not-exist-9f3a.md)'))
      .toEqual(['./does-not-exist-9f3a.md']);
  });

  it('ignores absolute URLs and in-page anchors', () => {
    expect(relativeLinkTargets('[a](https://example.com) [b](#section) [c](mailto:x@y.z)'))
      .toEqual([]);
  });

  it('strips an anchor before resolving', () => {
    expect(relativeLinkTargets('[a](./SECURITY.md#rollback)')).toEqual(['./SECURITY.md']);
  });
});
