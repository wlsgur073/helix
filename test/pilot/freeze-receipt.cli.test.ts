import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { bundleCli } from '../helpers/bundle-cli.js';
import { FIXTURE_CUTOFF, freezeFixtureRepo, type FreezeFixtureRepo } from '../helpers/freeze-fixture-repo.js';
import { PINNED_METHOD_DOCS, PINNED_TOOL_PATHS } from '../../scripts/pilot/pin-hashes.js';

let cli: string;
/** One CLEAN fixture repo shared by the non-mutating tests; tests that perturb the tree build
 *  their own. The CLI refuses a tree that diverges from `--commit` for any pinned path, and this
 *  development repository is dirty in exactly those files whenever the pilot is being worked on —
 *  which is the reason the check exists, and the reason no test here freezes against the real
 *  HEAD any more. */
let repo: FreezeFixtureRepo;
beforeAll(async () => {
  cli = await bundleCli('scripts/pilot/freeze-receipt.ts');
  repo = freezeFixtureRepo();
}, 60_000);
afterAll(() => { rmSync(repo.root, { recursive: true, force: true }); });

const CUTOFF = FIXTURE_CUTOFF;
const CLOSE = new Date(new Date(CUTOFF).getTime() + 28 * 86_400_000).toISOString();
const RUNTIME = '0123456789abcdef0123456789abcdef01234567';

const sha256Bytes = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

const fixture = (runtimeBody?: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'freeze-'));
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ dualVerify: { mode: 'compare' }, apiKey: '[REDACTED]' }, null, 1) + '\n');
  const runtime = join(dir, 'runtime.json');
  writeFileSync(runtime, typeof runtimeBody === 'string' ? runtimeBody : JSON.stringify(runtimeBody ?? {
    gitCommitSha: RUNTIME,
    loadPaths: [
      { path: '/home/kim/.claude/plugins/cache/helix/helix/bin/helix-mcp.mjs', gitCommitSha: RUNTIME },
      { path: '/home/kim/.claude/plugins/marketplaces/helix/bin/helix-mcp.mjs', gitCommitSha: RUNTIME },
    ],
  }, null, 1) + '\n');
  return { dir, config, runtime, out: join(dir, 'freeze-receipt.json') };
};

const args = (f: ReturnType<typeof fixture>, over: { commit?: string } = {}) => [
  '--commit', over.commit ?? repo.commit, '--runtime', f.runtime, '--config', f.config,
  '--cutoff', CUTOFF, '--k', '20', '--out', f.out];

/** cwd is the FIXTURE repo: the CLI reads §10's pinned paths from its working directory and
 *  resolves `--commit` there too. */
const runIn = (root: string, a: string[]) =>
  execFileSync(process.execPath, [cli, ...a], { cwd: root, stdio: 'pipe' });
const run = (a: string[]) => runIn(repo.root, a);
const status = (a: string[]): number => {
  try { run(a); return 0; } catch (e) { return (e as { status?: number }).status ?? -1; }
};
const receiptOf = (f: ReturnType<typeof fixture>) => {
  run(args(f));
  return JSON.parse(readFileSync(f.out, 'utf8')) as {
    artifact: string; payloadSha256: string;
    payload: Record<string, unknown> & {
      config: { path: string; sha256: string; redactionAcknowledged: boolean };
      runtime: { gitCommitSha: string; loadPaths: { path: string; gitCommitSha: string }[] };
      tools: Record<string, string>; methodDocs: Record<string, string>;
    };
  };
};

describe('freeze-receipt CLI', () => {
  it('writes a receipt that pins the method and nothing from the close', () => {
    const f = fixture();
    try {
      const receipt = receiptOf(f);
      expect(receipt.artifact).toBe('freeze-receipt');
      expect(Object.keys(receipt.payload)).toEqual([
        'rule', 'artifactKind', 'candidateCommit', 'runtime', 'config', 'k', 'txAfter', 'txClose',
        'windowDays', 'tools', 'methodDocs',
      ]);
      expect(receipt.payload.candidateCommit).toBe(repo.commit);
      expect(receipt.payload.txAfter).toBe(CUTOFF);
      expect(receipt.payload.txClose).toBe(CLOSE);
      expect(receipt.payloadSha256).toBe(createHash('sha256').update(JSON.stringify(receipt.payload), 'utf8').digest('hex'));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('pins the configuration by its BYTES, and says which file they came from', () => {
    const f = fixture();
    try {
      const receipt = receiptOf(f);
      expect(receipt.payload.config.sha256).toBe(sha256Bytes(f.config));
      expect(receipt.payload.config.path).toBe(f.config);
      expect(receipt.payload.config.redactionAcknowledged).toBe(true);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('records both load paths and the sha they agreed on', () => {
    const f = fixture();
    try {
      const { runtime } = receiptOf(f).payload;
      expect(runtime.gitCommitSha).toBe(RUNTIME);
      expect(runtime.loadPaths).toHaveLength(2);
      expect(runtime.loadPaths.every((p) => p.gitCommitSha === RUNTIME)).toBe(true);
      expect(new Set(runtime.loadPaths.map((p) => p.path)).size).toBe(2);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  /** Pinning the tool hashes is the one §10 obligation this artifact exists for, so the wiring
   *  that produces them is asserted against the REAL `git hash-object`, path by path. A count is
   *  not a check: replacing `hashTools(process.cwd())` with eleven fabricated names all mapping to
   *  `'0'.repeat(40)` satisfied `toHaveLength(11)` and left the suite green. */
  it('pins every §10 tool by its real git hash-object value', () => {
    const f = fixture();
    try {
      const { tools } = receiptOf(f).payload;
      expect(Object.keys(tools)).toEqual([...PINNED_TOOL_PATHS]);
      const real = repo.git(['hash-object', '--', ...PINNED_TOOL_PATHS]).split('\n');
      expect(Object.values(tools)).toEqual(real);
      for (const [path, id] of Object.entries(tools)) expect(id, path).toMatch(/^[0-9a-f]{40}$/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('pins the binding rule documents, which no other pin covers', () => {
    const f = fixture();
    try {
      const { methodDocs } = receiptOf(f).payload;
      expect(Object.keys(methodDocs)).toEqual([...PINNED_METHOD_DOCS]);
      for (const rel of PINNED_METHOD_DOCS) expect(methodDocs[rel], rel).toBe(sha256Bytes(join(repo.root, rel)));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('freeze-receipt CLI — the split from the close-time pins', () => {
  /** §9's order is `freeze receipt → close-bounded snapshot → manifest / candidate universe /
   *  classifier → prepare`. None of those four artifacts exists at the freeze instant, so a CLI
   *  that required them could not be run at its own ordered position — and pins taken at the
   *  freeze could not survive the window anyway, since §2's snapshot is CLOSE-bounded and every
   *  accrued row changes the ledger hashes. Refusing the flags is how that ordering is enforced
   *  rather than merely documented. */
  it('has no flag for any close-time artifact', () => {
    const f = fixture();
    try {
      for (const extra of [['--manifest', join(f.dir, 'm.json')], ['--classifier', join(f.dir, 'c.json')],
        ['--universe', join(f.dir, 'u.json')], ['--snapshot', f.dir], ['--pins-out', join(f.dir, 'p.json')]]) {
        expect(status([...args(f), ...extra]), extra.join(' ')).toBe(2);
      }
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('writes no pins file of any kind', () => {
    const f = fixture();
    try {
      const receipt = receiptOf(f);
      for (const absent of ['inputs', 'pins', 'pinsSha256']) {
        expect(Object.keys(receipt.payload), absent).not.toContain(absent);
      }
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('freeze-receipt CLI — the tree must be the commit', () => {
  /** The round-4 honesty finding, at the CLI surface: this development repository once froze HEAD
   *  while `run-pilot.ts` differed from HEAD and `freeze-receipt.ts` existed in no commit — exit
   *  0, and the receipt disclosed nothing. The pinned hashes come from the working tree, the
   *  receipt NAMES a commit, and a reader will resolve the commit; if the two disagree the receipt
   *  is a contradiction wearing a valid hash. There is deliberately no override flag. */
  it('refuses to freeze when a pinned path diverges from --commit, naming the path', () => {
    const dirty = freezeFixtureRepo();
    const f = fixture();
    try {
      appendFileSync(join(dirty.root, 'scripts/pilot/derive.ts'), '// uncommitted edit\n');
      let thrown: Error | undefined;
      try {
        runIn(dirty.root, ['--commit', dirty.commit, '--runtime', f.runtime, '--config', f.config,
          '--cutoff', CUTOFF, '--k', '20', '--out', f.out]);
      } catch (e) { thrown = e as Error; }
      expect(thrown, 'a divergent tree must refuse').toBeDefined();
      const stderr = String((thrown as unknown as { stderr?: Buffer }).stderr ?? thrown!.message);
      expect(stderr).toMatch(/tree-commit-divergence/);
      expect(stderr).toMatch(/scripts\/pilot\/derive\.ts/);
      expect(() => readFileSync(f.out, 'utf8')).toThrow(/ENOENT/);
    } finally {
      rmSync(dirty.root, { recursive: true, force: true });
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('refuses an annotated tag id as --commit: one commit must not be pinnable under two ids', () => {
    // `git log <tag>` silently PEELS the tag, so the cutoff verification passed against the peeled
    // commit while the receipt recorded the tag's own object id — the exact two-ids-for-one-method
    // drift the object-id pin exists to prevent.
    repo.git(['tag', '-a', '-m', 'fixture tag', 'v-fixture']);
    const tagId = repo.git(['rev-parse', 'v-fixture']);
    expect(repo.git(['cat-file', '-t', tagId])).toBe('tag');
    const f = fixture();
    try {
      const a = args(f, { commit: tagId });
      expect(status(a)).toBe(1);
      expect(() => run(a)).toThrow(/not-a-commit/);
      expect(() => readFileSync(f.out, 'utf8')).toThrow(/ENOENT/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('freeze-receipt CLI refusals', () => {
  /** Two exit codes with two different meanings, the same split `prepare-gate` draws. Exit 2 is
   *  "you invoked it wrong" and is decided before anything is read; exit 1 is "this is not a
   *  freezable state" and is a refusal of the freeze itself (`prepare-gate.cli.test.ts:113` treats
   *  a flag-supplied value that fails validation the same way). */
  it('exits 2 on an unknown, missing or repeated flag', () => {
    const f = fixture();
    try {
      expect(status([...args(f), '--results', join(f.dir, 'r.json')])).toBe(2);
      expect(status(args(f).slice(2))).toBe(2);                                  // no --commit
      expect(status([...args(f), '--k', '20'])).toBe(2);                         // repeated
      expect(status([...args(f), '--out'])).toBe(2);                             // dangling value
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('exits 2 on --close, because the close instant is DERIVED and never supplied', () => {
    // The one unknown flag worth naming: offering a close instant is exactly what would let two
    // operator-typed bounds disagree, which is the failure the derivation exists to make impossible.
    const f = fixture();
    try {
      expect(status([...args(f), '--close', CLOSE])).toBe(2);
      expect(status([...args(f), '--tx-close', CLOSE])).toBe(2);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('refuses a non-canonical cutoff and writes nothing', () => {
    const f = fixture();
    try {
      const a = args(f);
      a[a.indexOf('--cutoff') + 1] = CUTOFF.replace('.000Z', 'Z');
      expect(status(a)).toBe(1);
      expect(() => run(a)).toThrow(/non-canonical-instant/);
      expect(() => readFileSync(f.out, 'utf8')).toThrow(/ENOENT/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  /** §2 names the mis-rendered-timezone derivation as a trap that must not be repeated. A CLI that
   *  accepts whatever the operator pasted repeats it in a different place, so the cutoff is
   *  checked against the repository — against the REAL one, here, since a stub would only prove
   *  the comparison exists. */
  it('refuses a cutoff that is not the commit\'s authored time, and a commit that does not resolve', () => {
    const f = fixture();
    try {
      const off = args(f);
      // One second late: a plausible transcription that moves the window's open edge.
      off[off.indexOf('--cutoff') + 1] = new Date(new Date(CUTOFF).getTime() + 1000).toISOString();
      expect(status(off)).toBe(1);
      expect(() => run(off)).toThrow(/cutoff-not-commit-time/);

      const ghost = args(f, { commit: RUNTIME });   // well-formed, not a commit in this repo
      expect(status(ghost)).toBe(1);
      expect(() => run(ghost)).toThrow(/commit-unresolved/);
      expect(() => readFileSync(f.out, 'utf8')).toThrow(/ENOENT/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('refuses a short or malformed --commit', () => {
    const f = fixture();
    try {
      for (const bad of [repo.commit.slice(0, 7), 'HEAD', 'feat/helix-v1', repo.commit.toUpperCase()]) {
        const a = args(f, { commit: bad });
        expect(status(a), bad).toBe(1);
        expect(() => run(a), bad).toThrow(/malformed-object-id/);
      }
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  /** §10 line 436 pins the runtime at BOTH load paths. Each refusal below is a state in which the
   *  question "which bytes served recall" has no single answer, and the receipt has no honest way
   *  to record one. */
  it('refuses a runtime identity that cannot establish what is installed', () => {
    const cases: [unknown, RegExp][] = [
      [{ gitCommitSha: RUNTIME, loadPaths: [{ path: '/a', gitCommitSha: RUNTIME }] }, /runtime-load-paths-insufficient/],
      [{ gitCommitSha: RUNTIME, loadPaths: [{ path: '/a', gitCommitSha: RUNTIME }, { path: '/b', gitCommitSha: 'c'.repeat(40) }] },
        /runtime-load-paths-disagree/],
      [{ gitCommitSha: RUNTIME, loadPaths: [{ path: '/a', gitCommitSha: RUNTIME }, { path: '/a', gitCommitSha: RUNTIME }] },
        /runtime-load-paths-duplicate/],
      // Two SPELLINGS of one path: a raw string compare read them as the two independent copies
      // the floor stands for. These are declarations, never opened, so normalization is as far as
      // the check can honestly reach.
      [{ gitCommitSha: RUNTIME, loadPaths: [{ path: '/a/x', gitCommitSha: RUNTIME }, { path: '/a//x', gitCommitSha: RUNTIME }] },
        /runtime-load-paths-duplicate/],
      // The bare scalar this flag used to be. It has to arrive as a QUOTED string: `fixture` writes
      // a string argument to the file verbatim, so passing `RUNTIME` itself wrote 40 unquoted hex
      // characters — a file that is not JSON at all, which is the case below and not this one.
      [JSON.stringify(RUNTIME), /malformed-runtime-identity/],
    ];
    for (const [body, slug] of cases) {
      const f = fixture(body);
      try {
        expect(status(args(f)), JSON.stringify(body)).toBe(1);
        expect(() => run(args(f)), JSON.stringify(body)).toThrow(slug);
        expect(() => readFileSync(f.out, 'utf8')).toThrow(/ENOENT/);
      } finally { rmSync(f.dir, { recursive: true, force: true }); }
    }
  });

  /** A `--runtime` file that will not PARSE exits 2, not 1, and the difference is finding X3's
   *  whole subject: exit 1 means "this is not a freezable state" and exit 2 means "you called it
   *  wrong". A path holding something that is not JSON is the second — the operator retypes the
   *  path or fixes the file — and an operator's script that read it as the first would treat a
   *  typo as the freeze refusing. */
  it('reports an unparsable --runtime as an invocation error, not as a freeze refusal', () => {
    for (const body of ['not json{', RUNTIME]) {
      const f = fixture(body);
      try {
        expect(status(args(f)), body).toBe(2);
        expect(() => run(args(f)), body).toThrow(/input-unparsable: --runtime /);
        expect(() => readFileSync(f.out, 'utf8')).toThrow(/ENOENT/);
      } finally { rmSync(f.dir, { recursive: true, force: true }); }
    }
  });

  it('refuses a --k that is not a positive integer', () => {
    const f = fixture();
    try {
      for (const bad of ['twenty', '0', '20.5', '']) {
        const a = args(f);
        a[a.indexOf('--k') + 1] = bad;
        expect(status(a), bad).toBe(1);
      }
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('refuses a --k that is not a PLAIN DECIMAL integer, however Number() reads it', () => {
    // `Number()` is not a parser for this. Every spelling below produced a well-formed receipt:
    // `2e1`, `0x14`, ` 20 ` and `+20` all pinned K=20 under a spelling §10 does not use, and
    // `1e-0` — one keystroke from `1e-01` or a stray `-` — silently pinned K=1, which is a
    // DIFFERENT METHOD wearing a valid signature. K is the cutoff every metric is defined
    // against (§3), so its spelling has to be exact rather than coerced.
    const f = fixture();
    try {
      for (const bad of ['2e1', '0x14', ' 20 ', '+20', '1e-0', '20.0', '020', 'Infinity']) {
        const a = args(f);
        a[a.indexOf('--k') + 1] = bad;
        expect(status(a), JSON.stringify(bad)).toBe(1);
      }
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});
