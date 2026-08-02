import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { buildProbes, type LedgerRow, type ScopedLedger } from '../../scripts/pilot/generate-manifest.js';
import { bundleCli } from '../helpers/bundle-cli.js';

// Bundled with the pinned esbuild and spawned under plain `node`, not `npx tsx` — see
// test/helpers/bundle-cli.ts. Note this file ALSO imports the generator directly (above): the
// entry-point guard is what keeps that import from executing main(), and it now decides by path
// identity rather than by filename spelling.
let cli: string;
beforeAll(async () => { cli = await bundleCli('scripts/pilot/generate-manifest.ts'); }, 30_000);

/** C5.1 closure items 3 (transaction-time cutoff) and 4 (unambiguity denominator).
 *
 *  These two land as one change because they rewrite overlapping parts of the same file and
 *  because the old code used ONE row set for two different jobs — the probe source and the
 *  competitor set. Every test here pins the distinction between those two roles: the cutoff
 *  narrows the source only, and the scope merge widens the competitors only. */

const TX = '2026-07-20T00:00:00.000Z';
const row = (id: string, content: string, tx: string = TX): LedgerRow =>
  ({ id, tx, type: 'assert', content, supersedes: null });
/** Snapshot shape the runner also reads: a global ledger and an owned project ledger. */
const ledgers = (project: LedgerRow[], global: LedgerRow[] = []): ScopedLedger[] =>
  [{ scope: 'global', rows: global }, { scope: 'project', rows: project }];

// Two restatements of one fact: their topic terms overlap far past the ≥3-term threshold.
const SAME_A = 'store mutators throw on unknown identifier and the interface maps it';
const SAME_B = 'store mutators throw on unknown identifier; the interface maps it as well';

describe('unambiguity denominator spans every scope recall serves (item 4)', () => {
  it('lets a GLOBAL record make a project probe ambiguous', () => {
    const probes = buildProbes(ledgers([row('m_p', SAME_A)], [row('m_g', SAME_B)]), null);
    // run-pilot ranks against the merged global+project universe, so a global near-duplicate is a
    // real competitor; the project-only denominator called this probe unambiguous and it is not.
    expect(probes.find((p) => p.id === 'L_m_p')!.unambiguous).toBe(false);
  });

  it('still enumerates probes from the PROJECT ledger alone', () => {
    const probes = buildProbes(ledgers([row('m_p', SAME_A)], [row('m_g', SAME_B)]), null);
    expect(probes.map((p) => p.id)).toEqual(['L_m_p']);
  });

  it('refuses a corpus where one record id appears in both scopes', () => {
    // Merging scopes creates a collision surface the project-only set never had: an id-keyed
    // term map would silently drop one competitor's vocabulary and flatter the probe.
    expect(() => buildProbes(ledgers([row('m_dup', SAME_A)], [row('m_dup', SAME_B)]), null))
      .toThrow(/collision/);
  });

  it('closes a record that a later invalidate row names', () => {
    const probes = buildProbes(ledgers([
      row('m_old', 'deployment timeout is thirty seconds by default'),
      { id: 'm_inv', tx: TX, type: 'invalidate', content: '', supersedes: 'm_old' },
    ]), null);
    expect(probes.map((p) => p.id)).toEqual([]);
  });
});

describe('transaction-time cutoff narrows the probe source only (item 3)', () => {
  /** These tests are about the LOWER bound, so their close sits past every fixture instant and
   *  never binds. The upper bound has its own block below. */
  const win = (after: string, close = '2026-12-31T23:59:59.999Z') => ({ after, close });

  it('enumerates rows STRICTLY after the cutoff', () => {
    const probes = buildProbes(ledgers([
      row('m_before', 'alpha beta gamma delta', '2026-07-20T23:59:59.999Z'),
      row('m_at', 'epsilon zeta eta theta', '2026-07-21T00:00:00.000Z'),
      row('m_after', 'iota kappa lambda mu', '2026-07-21T00:00:00.001Z'),
    ]), null, win('2026-07-21T00:00:00.000Z'));
    expect(probes.map((p) => p.id)).toEqual(['L_m_after']);
  });

  it('keeps a PRE-cutoff record as a competitor, so the holdout is never flattered', () => {
    const probes = buildProbes(ledgers([
      row('m_before', SAME_A, '2026-07-20T00:00:00.000Z'),
      row('m_after', SAME_B, '2026-07-22T00:00:00.000Z'),
    ]), null, win('2026-07-21T00:00:00.000Z'));
    expect(probes.map((p) => p.id)).toEqual(['L_m_after']);
    expect(probes[0]!.unambiguous).toBe(false);   // m_before still competes at scoring time
  });

  it('refuses an oracle side together with a cutoff', () => {
    // Oracle entries are not ledger records and carry no tx, so they cannot be dated; the
    // holdout population is defined as ledger records alone (pilot-protocol.md §7).
    expect(() => buildProbes(ledgers([row('m_a', 'alpha beta gamma')]),
      { md: '# N\n- unrelated bullet text here\n', mapping: {} }, win('2026-07-21T00:00:00.000Z')))
      .toThrow(/oracle/);
  });

  it('refuses a cutoff that is not canonical UTC', () => {
    const src = ledgers([row('m_a', 'alpha beta gamma')]);
    expect(() => buildProbes(src, null, win('2026-07-21'))).toThrow(/canonical/);
    expect(() => buildProbes(src, null, win('2026-07-21T00:00:00Z'))).toThrow(/canonical/);
    expect(() => buildProbes(src, null, win('2026-02-30T00:00:00.000Z'))).toThrow(/canonical/);
  });

  it('refuses a row whose tx is missing or not canonical', () => {
    const w = win('2026-07-21T00:00:00.000Z');
    expect(() => buildProbes(ledgers([{ id: 'm_a', type: 'assert', content: 'alpha beta gamma', supersedes: null }]),
      null, w)).toThrow(/tx/);
    expect(() => buildProbes(ledgers([row('m_a', 'alpha beta gamma', '2026-07-22')]), null, w)).toThrow(/tx/);
  });
});

describe('close-time upper bound makes the corpus as-of-close (item 2)', () => {
  // A 28-day window, the length §3c fixes. The instants below sit either side of its endpoints.
  const CUTOFF = '2026-07-21T00:00:00.000Z';
  const CLOSE = '2026-08-18T00:00:00.000Z';
  const IN_WINDOW = '2026-08-01T00:00:00.000Z';
  const AFTER_CLOSE = '2026-08-18T00:00:00.001Z';
  const w = { after: CUTOFF, close: CLOSE };

  it('admits a row written exactly AT the close and excludes one a millisecond later', () => {
    // `cutoff < tx ≤ close`: the cutoff is the freeze instant and is not in the window, but the
    // close is the window's last moment, so the bounds are deliberately asymmetric.
    const probes = buildProbes(ledgers([
      row('m_at_close', 'alpha beta gamma delta', CLOSE),
      row('m_past_close', 'epsilon zeta eta theta', AFTER_CLOSE),
    ]), null, w);
    expect(probes.map((p) => p.id)).toEqual(['L_m_at_close']);
  });

  it.each(['supersede', 'invalidate', 'erase'])(
    'a post-close %s does not retroactively remove an in-window record', (type) => {
      // The reason the bound is applied to RAW rows, before liveness: a closer written after the
      // window would otherwise reach back and delete a record that was live at the close instant.
      // The expectation also pins the other half — the post-close closer is not itself a probe.
      const probes = buildProbes(ledgers([
        row('m_in', 'alpha beta gamma delta', IN_WINDOW),
        { id: 'm_closer', tx: AFTER_CLOSE, type, content: 'epsilon zeta eta theta', supersedes: 'm_in' },
      ]), null, w);
      expect(probes.map((p) => p.id)).toEqual(['L_m_in']);
    });

  it('a post-close competitor cannot make an in-window probe ambiguous', () => {
    // The upper bound spans every scope, not just the enumerated one: at the close instant this
    // global near-duplicate did not exist, so it cannot have competed for rank.
    const src = (tx: string) => ledgers([row('m_p', SAME_A, IN_WINDOW)], [row('m_g', SAME_B, tx)]);
    // Control: in-window, the same competitor DOES bind — without it this test could pass merely
    // because the two records never overlapped.
    expect(buildProbes(src(IN_WINDOW), null, w).find((p) => p.id === 'L_m_p')!.unambiguous).toBe(false);
    expect(buildProbes(src(AFTER_CLOSE), null, w).find((p) => p.id === 'L_m_p')!.unambiguous).toBe(true);
  });

  it('refuses a close that is not canonical UTC', () => {
    const src = ledgers([row('m_a', 'alpha beta gamma', IN_WINDOW)]);
    expect(() => buildProbes(src, null, { after: CUTOFF, close: '2026-08-18' })).toThrow(/canonical/);
    expect(() => buildProbes(src, null, { after: CUTOFF, close: '2026-02-30T00:00:00.000Z' })).toThrow(/canonical/);
  });

  it('refuses a window that never opens', () => {
    // A close at or before the cutoff is a preregistration error, not an empty result: the run
    // would produce a well-formed manifest with zero probes and look like a starved window.
    const src = ledgers([row('m_a', 'alpha beta gamma', IN_WINDOW)]);
    expect(() => buildProbes(src, null, { after: CUTOFF, close: CUTOFF })).toThrow(/window/);
    expect(() => buildProbes(src, null, { after: CLOSE, close: CUTOFF })).toThrow(/window/);
  });

  it('refuses a row anywhere in the corpus whose tx cannot be dated against the close', () => {
    // Undatable rows are refused in EVERY scope, including ones that only ever compete: a row
    // that cannot be placed relative to the close instant cannot be shown to be inside it.
    expect(() => buildProbes(ledgers([row('m_p', SAME_A, IN_WINDOW)],
      [{ id: 'm_g', type: 'assert', content: SAME_B, supersedes: null }]), null, w)).toThrow(/tx/);
  });
});

describe('generator CLI', () => {
  const snapshot = (project: string[], global: string[] = []): string => {
    const dir = mkdtempSync(join(tmpdir(), 'genman-cli-'));
    mkdirSync(join(dir, 'proj', '.helix'), { recursive: true });
    mkdirSync(join(dir, 'home'), { recursive: true });
    writeFileSync(join(dir, 'proj', '.helix', 'memory.jsonl'), project.map((l) => l + '\n').join(''));
    writeFileSync(join(dir, 'home', 'memory.jsonl'), global.map((l) => l + '\n').join(''));
    return dir;
  };
  const run = (args: string[]): void => {
    execFileSync(process.execPath, [cli,...args], { cwd: process.cwd() });
  };
  /** Exit status, which separates the two ways this CLI can refuse: 2 is its own usage rejection,
   *  1 is an uncaught exception from a downstream validator. `toThrow()` alone cannot tell them
   *  apart — a mutation that made a required flag optional passed against it. */
  const status = (args: string[]): number => {
    try {
      execFileSync(process.execPath, [cli, ...args], { cwd: process.cwd(), stdio: 'pipe' });
      return 0;
    } catch (e) { return (e as { status?: number }).status ?? -1; }
  };

  it('writes both window endpoints and no oracle probes in the holdout form', () => {
    const dir = snapshot([
      JSON.stringify(row('m_old', 'deployment timeout is thirty seconds by default', '2026-07-20T00:00:00.000Z')),
      JSON.stringify(row('m_new', 'retry backoff policy governs transient upload failures', '2026-07-22T00:00:00.000Z')),
      JSON.stringify(row('m_late', 'connection pool size defaults to sixteen sockets', '2026-08-19T00:00:00.000Z')),
    ]);
    try {
      const out = join(dir, 'holdout.json');
      run(['--after', '2026-07-21T00:00:00.000Z', '--close', '2026-08-18T00:00:00.000Z', dir, out]);
      const m = JSON.parse(readFileSync(out, 'utf8'));
      // Both endpoints are carried, in a fixed key order: the manifest is one of the artifacts §9's
      // chain hashes (item 3) as evidence of the window it was generated for, so a window it cannot
      // state is not evidence. (§5 fixes the close ITSELF; it hashes nothing.)
      expect(Object.keys(m)).toEqual(['k', 'txAfter', 'txClose', 'probes']);
      expect(m.txAfter).toBe('2026-07-21T00:00:00.000Z');
      expect(m.txClose).toBe('2026-08-18T00:00:00.000Z');
      expect(m.probes.map((p: { id: string }) => p.id)).toEqual(['L_m_new']);
      expect(m.probes.every((p: { side: string }) => p.side === 'ledger')).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses --after without --close AT THE INTERFACE, not downstream', () => {
    // The §3c defect is exactly a window with no upper bound, so the two endpoints are all-or-
    // nothing in the usage contract. Exit 2 is what pins that: with the flag merely optional the
    // run still fails — the window validator rejects an undated close — but it fails as an
    // uncaught exception (1) after the interface accepted an unbounded window as well-formed.
    const dir = snapshot([JSON.stringify(row('m_a', 'deployment timeout is thirty seconds by default'))]);
    try {
      expect(status(['--after', '2026-07-21T00:00:00.000Z', dir, join(dir, 'out.json')])).toBe(2);
      expect(status(['--close', '2026-08-18T00:00:00.000Z', dir, join(dir, 'out.json')])).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('emits no txAfter key in the frozen form', () => {
    const dir = snapshot([JSON.stringify(row('m_a', 'deployment timeout is thirty seconds by default'))]);
    try {
      const oracle = join(dir, 'oracle.md'); writeFileSync(oracle, '# N\n- unrelated bullet text here\n');
      const mapping = join(dir, 'mapping.json'); writeFileSync(mapping, JSON.stringify({}));
      const out = join(dir, 'manifest.json');
      run([dir, oracle, mapping, out]);
      expect(Object.keys(JSON.parse(readFileSync(out, 'utf8')))).toEqual(['k', 'probes']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses extra positional arguments instead of treating one of them as the output path', () => {
    const dir = snapshot([JSON.stringify(row('m_a', 'deployment timeout is thirty seconds by default'))]);
    try {
      const oracle = join(dir, 'oracle.md');
      writeFileSync(oracle, '# N\n- unrelated bullet text here\n');
      const before = readFileSync(oracle, 'utf8');
      // Positional shapes that overlap are a footgun with teeth: the frozen-form arguments handed
      // to the holdout form line the oracle path up with the OUTPUT slot, so a shape confusion
      // would overwrite a frozen, hash-pinned artifact.
      // A COMPLETE holdout invocation plus the frozen form's extra positionals: the window flags
      // are supplied so that what this pins is still the arity check and not a missing flag.
      expect(() => run(['--after', '2026-07-21T00:00:00.000Z', '--close', '2026-08-18T00:00:00.000Z',
        dir, oracle, join(dir, 'mapping.json'), join(dir, 'out.json')])).toThrow();
      expect(readFileSync(oracle, 'utf8')).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a snapshot with no global ledger rather than silently narrowing the denominator', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genman-noglobal-'));
    try {
      mkdirSync(join(dir, 'proj', '.helix'), { recursive: true });
      writeFileSync(join(dir, 'proj', '.helix', 'memory.jsonl'),
        JSON.stringify(row('m_a', 'deployment timeout is thirty seconds by default')) + '\n');
      const out = join(dir, 'holdout.json');
      // An incompletely copied snapshot would otherwise produce a well-formed manifest whose
      // probes are unambiguous only because their global competitors were never read. The
      // message must name the GLOBAL ledger: a bare /memory\.jsonl/ passed before this feature
      // existed, because the unparsed `--after` was read as the snapshot directory.
      expect(() => run(['--after', '2026-07-21T00:00:00.000Z', '--close', '2026-08-18T00:00:00.000Z', dir, out]))
        .toThrow(/home[/\\]memory\.jsonl/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
