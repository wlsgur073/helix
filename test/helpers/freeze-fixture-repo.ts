import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PINNED_METHOD_DOCS, PINNED_TOOL_PATHS } from '../../scripts/pilot/pin-hashes.js';

/** A throwaway git repository holding exactly the paths §10 pins, committed at a KNOWN authored
 *  instant — the fixture every freeze-receipt test runs against.
 *
 *  It exists because the freeze CLI now refuses a working tree that diverges from `--commit` for
 *  any pinned path (`tree-commit-divergence`), and this development repository is almost always
 *  dirty in exactly those files. A test that froze against the real HEAD would therefore fail
 *  whenever the pilot is being worked on — which is also the reason the check exists, so the
 *  refusal is correct and the tests move to a repo whose tree/commit agreement is constructed.
 *
 *  The pinned files are COPIES of the real ones, so `git hash-object` agreement tests still
 *  exercise real bytes. The authored date is forced through the env, which is what makes the
 *  §2 cutoff (`TZ=UTC git log --date=format-local:…`) a known constant instead of whatever HEAD
 *  happens to say. */
export interface FreezeFixtureRepo { root: string; commit: string; cutoff: string; git: (a: string[]) => string }

export const FIXTURE_CUTOFF = '2026-07-21T00:00:00.000Z';

export const freezeFixtureRepo = (): FreezeFixtureRepo => {
  const root = mkdtempSync(join(tmpdir(), 'freezerepo-'));
  for (const rel of [...PINNED_TOOL_PATHS, ...PINNED_METHOD_DOCS]) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    copyFileSync(join(process.cwd(), rel), join(root, rel));
  }
  const env = {
    ...process.env,
    TZ: 'UTC',
    GIT_AUTHOR_DATE: '2026-07-21T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-07-21T00:00:00Z',
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@test',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@test',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const git = (a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8', env }).trim();
  git(['init', '-q']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'freeze fixture']);
  return { root, commit: git(['rev-parse', 'HEAD']), cutoff: FIXTURE_CUTOFF, git };
};
