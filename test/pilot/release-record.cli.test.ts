import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { RULE } from '../../scripts/pilot/gate-set.js';
import { bundleCli } from '../helpers/bundle-cli.js';

/** The release-record CLI — evidence-chain element 8 at its real surface.
 *
 *  Bundled and spawned rather than called in-process, because the properties under test are
 *  properties of the EXECUTABLE: which exit code an operator's script sees, and whether an unknown
 *  flag is refused or silently dropped. Neither is observable from the exported function. */

let cli: string;
beforeAll(async () => { cli = await bundleCli('scripts/pilot/release-record.ts'); }, 30_000);

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const REASONS = ['Hit@1 — 1/2 ranked 1; PARTIALLY EXERCISED — 1/2 (minimum not met)', 'Stability — divergent'];

const fixture = (over: { blocked?: boolean; reasons?: string[] } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'relrec-'));
  const blocked = over.blocked ?? true;
  const payload = {
    rule: RULE,
    hit1: { x: 1, n: 2, pass: false, bound: 0.0253, label: 'PARTIALLY EXERCISED — 1/2 (minimum not met)' },
    release: { blocked, reasons: over.reasons ?? (blocked ? REASONS : []) },
  };
  const score = join(dir, 'gate-score.json');
  writeFileSync(score, JSON.stringify({
    artifact: 'gate-score',
    payloadSha256: sha256(JSON.stringify(payload)),
    payload,
    receipts: { scoredAt: '2026-08-18T10:00:00.000Z', attestation: 'self-reported wall clock' },
  }, null, 1) + '\n');
  return { dir, score, out: join(dir, 'release-record.json') };
};

/** Stands in for the head `ordering-receipt --mode verify` prints. This CLI never reads the log,
 *  so any 64 lowercase hex string is as real to it as the true head — which is itself part of the
 *  contract, and is why the record says the head was recorded and not verified. */
const HEAD = sha256('ordering-log head at the close');

const args = (f: ReturnType<typeof fixture>, decision = 'blocked') => [
  '--score', f.score, '--decision', decision,
  '--consequence', 'v0.1.0 was NOT tagged and no plugin redeploy was performed',
  '--evidence', 'git tag -l v0.1.0 is empty at the freeze commit; the deploy log has no entry for the window',
  '--ordering-head', HEAD,
  '--out', f.out];

const run = (a: string[]) => execFileSync(process.execPath, [cli, ...a], { cwd: process.cwd(), stdio: 'pipe' });
const stderrOf = (a: string[]): string => {
  try { run(a); return ''; } catch (e) { return String((e as { stderr?: Buffer }).stderr); }
};
const status = (a: string[]): number => {
  try { run(a); return 0; } catch (e) { return (e as { status?: number }).status ?? -1; }
};

describe('release-record CLI', () => {
  it('writes the record for a block that was obeyed', () => {
    const f = fixture();
    try {
      run(args(f));
      const r = JSON.parse(readFileSync(f.out, 'utf8'));
      expect(r.artifact).toBe('release-record');
      expect(r.payload.gateBlocked).toBe(true);
      expect(r.payload.gateReasons).toEqual(REASONS);
      expect(r.payload.decision).toBe('blocked');
      expect(r.payload.scoreSha256).toBe(JSON.parse(readFileSync(f.score, 'utf8')).payloadSha256);
      expect(r.payload.orderingHead).toBe(HEAD);
      expect(r.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
      // The file must be written the way every other artifact here is written, or the chain's
      // hashes are computed over bytes nobody can reproduce.
      expect(readFileSync(f.out, 'utf8')).toBe(JSON.stringify(r, null, 1) + '\n');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('exits 1 and writes NOTHING when a blocked gate is declared released', () => {
    const f = fixture();
    try {
      expect(status(args(f, 'released'))).toBe(1);
      // The distinction that matters operationally: a refusal must not leave a plausible-looking
      // record behind for someone to find later and read as the chain's element 8.
      expect(() => readFileSync(f.out, 'utf8')).toThrow(/ENOENT/);
      let stderr = '';
      try { run(args(f, 'released')); } catch (e) { stderr = String((e as { stderr?: Buffer }).stderr); }
      expect(stderr).toContain('consequence-not-applied');
      for (const reason of REASONS) expect(stderr).toContain(reason);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('exits 1 when an unblocked gate is declared blocked', () => {
    const f = fixture({ blocked: false });
    try {
      expect(status(args(f, 'blocked'))).toBe(1);
      expect(status(args(f, 'released'))).toBe(0);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('exits 2 on a usage error and 1 on an integrity failure, so a script can tell them apart', () => {
    // Two different facts an operator's automation must distinguish: "you invoked this wrongly" and
    // "the gate forbids what you are recording". Collapsing them would let a wrapper retry a
    // refused release as if it were a typo.
    const f = fixture();
    try {
      expect(status([...args(f), '--waiver', 'approved by owner'])).toBe(2);   // unknown flag REFUSED
      expect(status(args(f).slice(2))).toBe(2);                                // no --score
      expect(status([...args(f), '--out', join(f.dir, 'other.json')])).toBe(2); // repeated flag
      expect(status([...args(f, 'partially released')])).toBe(2);              // decision not in the vocabulary
      expect(status([...args(f), '--score'])).toBe(2);                         // dangling flag, no value
      expect(status(args(f, 'released'))).toBe(1);                             // integrity, not usage
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('refuses blank consequence and evidence at the CLI surface', () => {
    const f = fixture();
    try {
      const blanked = (flag: string) => {
        const a = [...args(f)];
        a[a.indexOf(flag) + 1] = '   ';
        return a;
      };
      expect(status(blanked('--consequence'))).toBe(1);
      expect(status(blanked('--evidence'))).toBe(1);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('REFUSES a positional argument instead of reading one as a flag', () => {
    // "Named flags only, NO positionals" was CLAIMED and never tested: the whole suite passed with
    // the `startsWith('--')` check deleted, because every test only ever passed flags. The check is
    // load-bearing — `flag.slice(2)` turns any token into a flag name, so a token that is not a flag
    // but whose third character onward spells one is silently HONOURED as that flag once the check
    // is gone. That is the overlapping-positional-shape failure this contract exists to prevent.
    const f = fixture();
    try {
      const nearMiss = [...args(f)];
      nearMiss[0] = '..score';                       // slice(2) === 'score'
      expect(status(nearMiss)).toBe(2);
      expect(() => readFileSync(f.out, 'utf8')).toThrow(/ENOENT/);
      expect(stderrOf(nearMiss)).toContain('bad-arguments');

      // And an ordinary trailing positional is diagnosed as what it is — a token where a flag was
      // expected, quoted verbatim — rather than as an unknown flag named after a mangling of it.
      const trailing = [...args(f), 'release-record.json', 'v0.1.0'];
      expect(status(trailing)).toBe(2);
      const stderr = stderrOf(trailing);
      expect(stderr).toContain('bad-arguments');
      expect(stderr).toContain('release-record.json');
      expect(stderr).not.toContain('unknown-input');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('REQUIRES --ordering-head and refuses one that is not 64 lowercase hex', () => {
    // The anchor closes the ordering receipt's tail-truncation hole, so it is required rather than
    // optional: a record written without one leaves the log's end unfixed exactly as before, and an
    // optional anchor is one an operator under pressure omits.
    const f = fixture();
    try {
      const without = args(f).filter((_, i, a) => a[i] !== '--ordering-head' && a[i - 1] !== '--ordering-head');
      expect(status(without)).toBe(2);
      expect(stderrOf(without)).toContain('--ordering-head is required');

      for (const bad of [HEAD.toUpperCase(), HEAD.slice(0, 63), 'not a hash']) {
        const a = [...args(f)];
        a[a.indexOf('--ordering-head') + 1] = bad;
        expect(status(a), bad).toBe(2);              // a mistyped hash is a typing error, not a gate refusal
      }
      expect(() => readFileSync(f.out, 'utf8')).toThrow(/ENOENT/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('refuses zero-width-only consequence and evidence, which trim() let through', () => {
    // Reproduced at this surface because that is where it happened: `--consequence $'\u200b'
    // --evidence $'\u200b'` exited 0 and wrote a valid, hashed release record carrying no
    // information.
    const f = fixture();
    try {
      const zeroWidth = (flag: string) => {
        const a = [...args(f)];
        a[a.indexOf(flag) + 1] = '\u200b';
        return a;
      };
      expect(status(zeroWidth('--consequence'))).toBe(1);
      expect(status(zeroWidth('--evidence'))).toBe(1);
      expect(() => readFileSync(f.out, 'utf8')).toThrow(/ENOENT/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('refuses a score whose blocking reason is empty rather than announcing a block it cannot quote', () => {
    // The accepted version printed "gate BLOCKED (1 reason(s))" and would have rendered the
    // headline refusal as "  - " followed by nothing.
    const f = fixture({ reasons: [''] });
    try {
      expect(status(args(f))).toBe(1);
      expect(stderrOf(args(f))).toContain('score-blank-reason');
      expect(() => readFileSync(f.out, 'utf8')).toThrow(/ENOENT/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('prints the anchored head with the command that checks it, so the anchor is usable', () => {
    // An anchor nobody can act on is decoration. The record says the head was RECORDED and not
    // verified, so the summary has to hand the reader the command that does verify it — otherwise
    // the operator's next move after "release record written" is unknown to them.
    const f = fixture();
    try {
      const stdout = String(run(args(f)));
      expect(stdout).toContain(HEAD);
      expect(stdout).toMatch(/--expect-head/);
      expect(stdout).toMatch(/NOT verified|not verified/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('prints the usage text naming what --consequence must contain in each direction', () => {
    const f = fixture();
    try {
      let stderr = '';
      try { run(args(f).slice(2)); } catch (e) { stderr = String((e as { stderr?: Buffer }).stderr); }
      expect(stderr).toMatch(/what was NOT released/);
      expect(stderr).toMatch(/the release that followed and its record/);
      expect(stderr).toMatch(/--ordering-head/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});
