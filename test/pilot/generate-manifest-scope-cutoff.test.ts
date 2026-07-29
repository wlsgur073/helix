import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { buildProbes, type LedgerRow, type ScopedLedger } from '../../scripts/pilot/generate-manifest.js';

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
  it('enumerates rows STRICTLY after the cutoff', () => {
    const probes = buildProbes(ledgers([
      row('m_before', 'alpha beta gamma delta', '2026-07-20T23:59:59.999Z'),
      row('m_at', 'epsilon zeta eta theta', '2026-07-21T00:00:00.000Z'),
      row('m_after', 'iota kappa lambda mu', '2026-07-21T00:00:00.001Z'),
    ]), null, '2026-07-21T00:00:00.000Z');
    expect(probes.map((p) => p.id)).toEqual(['L_m_after']);
  });

  it('keeps a PRE-cutoff record as a competitor, so the holdout is never flattered', () => {
    const probes = buildProbes(ledgers([
      row('m_before', SAME_A, '2026-07-20T00:00:00.000Z'),
      row('m_after', SAME_B, '2026-07-22T00:00:00.000Z'),
    ]), null, '2026-07-21T00:00:00.000Z');
    expect(probes.map((p) => p.id)).toEqual(['L_m_after']);
    expect(probes[0]!.unambiguous).toBe(false);   // m_before still competes at scoring time
  });

  it('refuses an oracle side together with a cutoff', () => {
    // Oracle entries are not ledger records and carry no tx, so they cannot be dated; the
    // holdout population is defined as ledger records alone (pilot-protocol.md §7).
    expect(() => buildProbes(ledgers([row('m_a', 'alpha beta gamma')]),
      { md: '# N\n- unrelated bullet text here\n', mapping: {} }, '2026-07-21T00:00:00.000Z'))
      .toThrow(/oracle/);
  });

  it('refuses a cutoff that is not canonical UTC', () => {
    const src = ledgers([row('m_a', 'alpha beta gamma')]);
    expect(() => buildProbes(src, null, '2026-07-21')).toThrow(/canonical/);
    expect(() => buildProbes(src, null, '2026-07-21T00:00:00Z')).toThrow(/canonical/);
    expect(() => buildProbes(src, null, '2026-02-30T00:00:00.000Z')).toThrow(/canonical/);
  });

  it('refuses a probe-source row whose tx is missing or not canonical', () => {
    const cutoff = '2026-07-21T00:00:00.000Z';
    expect(() => buildProbes(ledgers([{ id: 'm_a', type: 'assert', content: 'alpha beta gamma', supersedes: null }]),
      null, cutoff)).toThrow(/tx/);
    expect(() => buildProbes(ledgers([row('m_a', 'alpha beta gamma', '2026-07-22')]), null, cutoff)).toThrow(/tx/);
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
    execFileSync('npx', ['tsx', 'scripts/pilot/generate-manifest.ts', ...args], { cwd: process.cwd() });
  };

  it('writes txAfter and no oracle probes in the holdout form', () => {
    const dir = snapshot([
      JSON.stringify(row('m_old', 'deployment timeout is thirty seconds by default', '2026-07-20T00:00:00.000Z')),
      JSON.stringify(row('m_new', 'retry backoff policy governs transient upload failures', '2026-07-22T00:00:00.000Z')),
    ]);
    try {
      const out = join(dir, 'holdout.json');
      run(['--after', '2026-07-21T00:00:00.000Z', dir, out]);
      const m = JSON.parse(readFileSync(out, 'utf8'));
      expect(m.txAfter).toBe('2026-07-21T00:00:00.000Z');
      expect(m.probes.map((p: { id: string }) => p.id)).toEqual(['L_m_new']);
      expect(m.probes.every((p: { side: string }) => p.side === 'ledger')).toBe(true);
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
      expect(() => run(['--after', '2026-07-21T00:00:00.000Z', dir,
        oracle, join(dir, 'mapping.json'), join(dir, 'out.json')])).toThrow();
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
      expect(() => run(['--after', '2026-07-21T00:00:00.000Z', dir, out])).toThrow(/home[/\\]memory\.jsonl/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
