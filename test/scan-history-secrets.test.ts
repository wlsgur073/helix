// P3 regression lock: a blob present at BOTH an allowlisted path and a real path
// must still be scanned. `git rev-list --all --objects` emits each blob ONCE under
// one arbitrary path, so any enumeration built on it is structurally blind here —
// this fixture pins that limitation and the tree-walk fix.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enumerateBlobPaths, scanRepo } from '../scripts/scan-history-secrets.js';

// deterministic root (repro/test convention: no random suffix in asserted paths)
const ROOT = join(tmpdir(), 'helix-scan-fixture');
const g = (args: string[]) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });

function buildFixture(): void {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'test'), { recursive: true });
  mkdirSync(join(ROOT, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', ROOT]);
  g(['config', 'user.email', 'fixture@example.invalid']);
  g(['config', 'user.name', 'fixture']);
  const secret = 'aws_key = "AKIA' + 'ABCDEFGHIJKLMNOP' + '"'; // matches the AWS pattern; NOT the allowlisted example key
  writeFileSync(join(ROOT, 'test', 'shape.txt'), secret);   // allowlisted bucket (test/**)
  writeFileSync(join(ROOT, 'src', 'leak.txt'), secret);     // SAME bytes -> SAME blob, real path
  g(['add', '-A']);
  g(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture']);
}

describe('scan-history-secrets', () => {
  it('enumerates every path a blob ever lived at (not one arbitrary path)', () => {
    buildFixture();
    const map = enumerateBlobPaths(ROOT);
    const dup = [...map.values()].find((paths) => paths.length === 2);
    expect(dup).toBeDefined();
    expect(dup!.slice().sort()).toEqual(['src/leak.txt', 'test/shape.txt']);
  });

  it('scans a blob whose OTHER path is allowlisted, and reports the real path', () => {
    buildFixture();
    const hits = scanRepo(ROOT);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.path === 'src/leak.txt')).toBe(true);
  });

  it('skips a blob when EVERY path is allowlisted', () => {
    buildFixture();
    rmSync(join(ROOT, 'src', 'leak.txt'));
    g(['add', '-A']); g(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'remove real path']);
    // blob now exists in history at both paths still -> must STILL be scanned (history!).
    // A truly all-allowlisted blob: add a NEW secret only under test/.
    const only = 'aws_key = "AKIA' + 'QRSTUVWXYZABCDEF' + '"';
    writeFileSync(join(ROOT, 'test', 'only.txt'), only);
    g(['add', '-A']); g(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'allowlisted only']);
    const hits = scanRepo(ROOT);
    expect(hits.some((h) => h.path === 'test/only.txt')).toBe(false); // all paths allowlisted -> skipped
    expect(hits.some((h) => h.path === 'src/leak.txt')).toBe(true);   // history keeps the dual-path blob scanned
  });
});
