import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { globalScopeNonce, stampOwnership } from '../../src/memory/ownership.js';
import { scopeKeyOf, planTransition, openTransition } from '../../src/memory/witness-store.js';
import { defaultExpansion } from '../../src/memory/expansion.js';
import { readSnapshot } from '../../scripts/pilot/snapshot.js';
import { prepareGateSet } from '../../scripts/pilot/prepare-gate.js';
import { scoreGate, type Adjudication } from '../../scripts/pilot/score-gate.js';
import { expansionTableSha256, sha256BytesOrAbsent, snapshotTrustPaths } from '../../scripts/pilot/pin-hashes.js';
import { bundleCli } from '../helpers/bundle-cli.js';

/** The runner's CLI contract and its payload / receipts split (preregistration §4, §9 item 5).
 *
 *  The evidence chain wants a runner output that names the prepared gate set it was measured
 *  against AND the run that produced it. Those two demands pull opposite ways — a prepare hash is
 *  the same on every honest re-run, a run id is different by construction — so the artifact is
 *  split and stability compares only the deterministic half. The first test below is the whole
 *  point of the split: under the old whole-file design it could not pass. */

let cli: string;
beforeAll(async () => { cli = await bundleCli('scripts/pilot/run-pilot.ts'); }, 30_000);

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** A snapshot, a manifest and a prepared gate set on disk.
 *
 *  The gate set is hand-rolled rather than produced by `prepare-gate`: the runner reads it to bind
 *  to it, so the properties that have to be real are that `payloadSha256` is the sha256 of the
 *  payload's canonical JSON and that `payload.inputs.manifest` is the sha256 of the manifest file's
 *  utf8 text — the value `prepare-gate.ts:298` writes there. `perturb` lets a test break either. */
const fixture = (perturb: (g: { artifact: string; payloadSha256: string; payload: Record<string, unknown> }) => void = () => {},
  opts: { mintGlobal?: boolean; plantWitness?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'runpilot-'));
  const home = join(dir, 'home');
  const projectRoot = join(dir, 'proj');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(projectRoot, '.helix'), { recursive: true });
  const row = (id: string, content: string) => JSON.stringify({
    id, tx: '2026-07-25T00:00:00.000Z', validFrom: '2026-07-25T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content, provenance: { source: 'user', sessionId: 't' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' });
  const projectText = row('m_1', 'exit code two on usage error is the contract') + '\n';
  const globalText = row('m_2', 'global background fact about releases and exit code contracts') + '\n';
  writeFileSync(join(projectRoot, '.helix', 'memory.jsonl'), projectText);
  writeFileSync(join(home, 'memory.jsonl'), globalText);
  stampOwnership(projectRoot, home, { genStamp: () => 'pilot-stamp' });
  // The registry must already carry its '@global' entry: the store MINTS one on first recall when
  // it is missing (ownership.ts globalScopeNonce), which is a WRITE into the frozen snapshot — so
  // the runner refuses an incomplete registry instead of letting the store complete it, and an
  // honest fixture arrives complete. The mintGlobal:false variant is the refusal's own test.
  if (opts.mintGlobal !== false) globalScopeNonce(home);
  if (opts.plantWitness) {
    // A pending journal exactly as a crash-interrupted rewrite leaves one, planted with the
    // SHIPPED writers. `expected` deliberately matches nothing, so the verdict classifies as
    // transition-interrupted — the state in which the store silently EXCLUDES the whole scope.
    const scopeKey = scopeKeyOf(home, projectRoot);
    const plan = planTransition(home, scopeKey, 'compaction');
    openTransition(home, scopeKey, { kind: 'compaction', ...plan,
      expected: { byteLength: 7, prefixHash: 'ab'.repeat(32) }, tx: '2026-08-01T00:00:00.000Z' });
  }

  const manifestPath = join(dir, 'manifest.json');
  const manifestText = JSON.stringify({ k: 20, txAfter: '2026-07-21T00:00:00.000Z',
    txClose: '2026-08-18T00:00:00.000Z', probes: [
      { id: 'L_m_1', query: 'exit code usage error contract', relevant: ['m_1'], unambiguous: true, side: 'ledger' },
      { id: 'L_m_2', query: 'releases background fact', relevant: ['m_2'], unambiguous: true, side: 'ledger' },
    ] }, null, 1) + '\n';
  writeFileSync(manifestPath, manifestText);

  // Trust pins are computed LAST, off the disk state every earlier fixture step produced — the
  // registry after minting, the witness after any planting — because the pins must describe the
  // snapshot the runner will actually read, exactly as input-pins derives them at the close.
  const trustPaths = snapshotTrustPaths(dir);
  const payload = {
    rule: 'v2-gate-composition-2026-07-29',
    k: 20,
    window: { txAfter: '2026-07-21T00:00:00.000Z', txClose: '2026-08-18T00:00:00.000Z' },
    eligible: { probeIds: ['L_m_1', 'L_m_2'], identities: ['global:m_2', 'project:m_1'], exposure: 2, label: 'EXERCISED — 2/2' },
    recallDenominator: ['L_m_1', 'L_m_2'],
    // The CORPUS is pinned beside the manifest: prepare-gate's main hashes both ledger files' utf8
    // text as `ledger:global` / `ledger:project`, the four TRUST files by raw bytes (or the
    // literal 'absent'), and the resolved expansion table by content — and the runner refuses a
    // snapshot whose bytes are not the pinned ones, so an honest fixture pins what it wrote.
    inputs: { manifest: sha256(manifestText),
      'ledger:global': sha256(globalText), 'ledger:project': sha256(projectText),
      'ownership:registry': sha256BytesOrAbsent('(fixture)', trustPaths['ownership:registry']!),
      'ownership:owner': sha256BytesOrAbsent('(fixture)', trustPaths['ownership:owner']!),
      'trust:master-key': sha256BytesOrAbsent('(fixture)', trustPaths['trust:master-key']!),
      'trust:witness': sha256BytesOrAbsent('(fixture)', trustPaths['trust:witness']!),
      'expansion:semantic-neighbors': expansionTableSha256(defaultExpansion()!) },
  };
  const gateSet = { artifact: 'gate-set', payloadSha256: sha256(JSON.stringify(payload)),
    payload: payload as Record<string, unknown>,
    receipts: { preparedAt: '2026-08-18T09:00:00.000Z', attestation: 'self-reported' } };
  perturb(gateSet);
  const gateSetPath = join(dir, 'gate-set.json');
  writeFileSync(gateSetPath, JSON.stringify(gateSet, null, 1) + '\n');

  return { dir, home, projectRoot, manifestPath, manifestText, manifestSha256: sha256(manifestText),
    gateSetPath, gateSetSha256: gateSet.payloadSha256,
    ledgerSha256: { global: sha256(globalText), project: sha256(projectText) },
    args: (out: string) => ['--manifest', manifestPath, '--snapshot', dir, '--gate-set', gateSetPath, '--out', out] };
};

const run = (args: string[]) => execFileSync(process.execPath, [cli, ...args], { cwd: process.cwd(), stdio: 'pipe' });
const status = (args: string[]): number => {
  try { run(args); return 0; }
  catch (e) { return (e as { status?: number }).status ?? -1; }
};

describe('run-pilot CLI — the payload / receipts split', () => {
  it('produces the SAME payload hash on two invocations while the run ids and the file bytes differ', () => {
    // §4: "Stability compares payload hashes only". The whole file cannot be compared, because §9's
    // chain requires the run id and real wall clocks that the same section makes differ every time.
    const f = fixture();
    try {
      const a = join(f.dir, 'run-a.json');
      const b = join(f.dir, 'run-b.json');
      run(f.args(a));
      run(f.args(b));
      const [ta, tb] = [readFileSync(a, 'utf8'), readFileSync(b, 'utf8')];
      const [ra, rb] = [JSON.parse(ta), JSON.parse(tb)];
      expect(ra.payloadSha256).toBe(rb.payloadSha256);
      expect(ra.payloadSha256).toBe(sha256(JSON.stringify(ra.payload)));
      expect(ra.receipts.runId).not.toBe(rb.receipts.runId);
      expect(ta).not.toBe(tb);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('reports a pinned-but-unparsable manifest as a path error, not as a gate refusal', () => {
    // The one place a manifest parse is reached: the bytes have already SATISFIED the pin, so
    // nothing about the method disagrees and `manifest-not-pinned` would be a lie. It used to
    // escape as a bare `SyntaxError` at exit 1 — the code reserved for "the gate forbids this" —
    // with a stack into `JSON.parse` and no mention of which of the two inputs was at fault.
    const f = fixture();
    try {
      writeFileSync(f.manifestPath, 'not json{\n');
      const g = JSON.parse(readFileSync(f.gateSetPath, 'utf8'));
      g.payload.inputs.manifest = sha256('not json{\n');       // re-pin, so the pin check passes
      g.payloadSha256 = sha256(JSON.stringify(g.payload));
      writeFileSync(f.gateSetPath, JSON.stringify(g, null, 1) + '\n');
      const out = join(f.dir, 'run.json');
      expect(status(f.args(out))).toBe(2);
      expect(() => run(f.args(out))).toThrow(/manifest-unparsable/);
      expect(existsSync(out)).toBe(false);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('embeds the gate set\'s payload hash as prepareSha256, so the run names what it was measured against', () => {
    const f = fixture();
    try {
      const out = join(f.dir, 'run.json');
      run(f.args(out));
      const r = JSON.parse(readFileSync(out, 'utf8'));
      expect(r.artifact).toBe('run');
      expect(r.payload.prepareSha256).toBe(f.gateSetSha256);
      expect(r.payload.rule).toBe('v2-gate-composition-2026-07-29');
      expect(r.payload.results.map((x: { id: string }) => x.id)).toEqual(['L_m_1', 'L_m_2']);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('embeds the manifest hash the freeze pinned, so the queries are inside the provenance chain', () => {
    // `prepareSha256` names the denominator; `manifestSha256` names the QUESTIONS that produced the
    // ranks. Without the second, a run artifact says which probe ids were scored and nothing at all
    // about what was asked, and the §9 chain has no link covering the queries.
    const f = fixture();
    try {
      const out = join(f.dir, 'run.json');
      run(f.args(out));
      const r = JSON.parse(readFileSync(out, 'utf8'));
      expect(r.payload.manifestSha256).toBe(f.manifestSha256);
      expect(r.payload.manifestSha256).toBe(sha256(readFileSync(f.manifestPath, 'utf8')));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('REFUSES a manifest that is not the bytes the gate set pins, even when every probe id matches', () => {
    // The swap that motivated this check: one corpus, one gate set, two manifests identical in `k`,
    // probe id and `relevant`, differing ONLY in `query`. Probe ids are the one part of a manifest
    // that need not change between them, so the score phase's `run-probe-mismatch` cannot see this
    // at all — a swapped query set is scored against the frozen denominator and flips the verdict.
    // The runner is the only stage that reads the manifest, so it is the only stage that can catch it.
    const f = fixture();
    try {
      const swapped = join(f.dir, 'manifest-swapped.json');
      const m = JSON.parse(f.manifestText) as { probes: { query: string }[] };
      m.probes[0]!.query = 'exit code two on usage error is the contract';   // the target's own text
      writeFileSync(swapped, JSON.stringify(m, null, 1) + '\n');
      const args = ['--manifest', swapped, '--snapshot', f.dir, '--gate-set', f.gateSetPath,
        '--out', join(f.dir, 'run.json')];
      expect(status(args)).toBe(1);
      expect(() => run(args)).toThrow(/manifest-not-pinned/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('REFUSES a gate set that pins no manifest hash, rather than binding to an absent value', () => {
    // Fail closed. Comparing a computed hash against `undefined` would be an equality that can only
    // hold when neither side exists, which is a check that passes precisely when it has nothing to
    // check. The recomputed payload hash keeps this from being caught as tampering instead.
    const f = fixture((g) => {
      delete (g.payload as { inputs?: unknown }).inputs;
      g.payloadSha256 = sha256(JSON.stringify(g.payload));
    });
    try {
      const args = f.args(join(f.dir, 'run.json'));
      expect(status(args)).toBe(1);
      expect(() => run(args)).toThrow(/manifest-not-pinned/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('REFUSES a gate set whose payload does not hash to its own recorded value', () => {
    // The runner reads the gate set only to bind to it, which is precisely why the binding has to
    // be verified: recording an unchecked hash would mint a provenance link to an artifact that no
    // longer exists, and every downstream check would then agree with a value nothing stands behind.
    const f = fixture((g) => { g.payload.k = 19; });
    try {
      expect(status(f.args(join(f.dir, 'run.json')))).toBe(1);
      expect(() => run(f.args(join(f.dir, 'run.json')))).toThrow(/gate-set-tampered/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('refuses an unknown, missing or repeated flag with exit 2 rather than ignoring or defaulting it', () => {
    // Named flags only, no positionals: `generate-manifest`'s overlapping positional shape once
    // lined an oracle path up with an output slot and overwrote a hash-pinned artifact
    // (prepare-gate.ts:260-266). An ignored unknown flag is the same failure one step earlier —
    // the operator believes an input was used and nothing says otherwise.
    const f = fixture();
    try {
      const out = join(f.dir, 'run.json');
      expect(status([...f.args(out), '--results', join(f.dir, 'anything.json')])).toBe(2);
      expect(status(f.args(out).slice(2))).toBe(2);                                // no --manifest
      expect(status([...f.args(out), '--out', join(f.dir, 'other.json')])).toBe(2);  // --out twice
      expect(status([...f.args(out), 'stray-positional'])).toBe(2);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('run-pilot CLI — the corpus and the runtime surface are bound, not just the gate set', () => {
  // The class all three tests below close: the run bound the gate set and the manifest, but not the
  // CORPUS or the RUNTIME SURFACE it actually ranked against. Prepare against snapshot A, run
  // against snapshot B (= A minus a decoy row) flipped the verdict with every other check green.

  it('REFUSES a snapshot whose global ledger bytes are not the ones the gate set pins', () => {
    const f = fixture();
    try {
      // The substitution: the pinned bytes were frozen, then the corpus changed under the runner —
      // one row removed is exactly the "snapshot B = snapshot A minus the decoy" attack.
      writeFileSync(join(f.dir, 'home', 'memory.jsonl'), '');
      const args = f.args(join(f.dir, 'run.json'));
      expect(status(args)).toBe(1);
      expect(() => run(args)).toThrow(/snapshot-not-pinned: ledger:global/);
      expect(existsSync(join(f.dir, 'run.json'))).toBe(false);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('REFUSES a snapshot whose project ledger bytes are not the pinned ones, naming that ledger', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.dir, 'proj', '.helix', 'memory.jsonl'), '');
      const args = f.args(join(f.dir, 'run.json'));
      expect(status(args)).toBe(1);
      expect(() => run(args)).toThrow(/snapshot-not-pinned: ledger:project/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('REFUSES a gate set that pins no ledger hash, rather than measuring against an unpinned corpus', () => {
    // The same fail-closed rule as `manifest-not-pinned`: a comparison that holds only when neither
    // side exists checks nothing, so an absent pin is a refusal, never a skip.
    const f = fixture((g) => {
      delete (g.payload.inputs as Record<string, unknown>)['ledger:global'];
      g.payloadSha256 = sha256(JSON.stringify(g.payload));
    });
    try {
      const args = f.args(join(f.dir, 'run.json'));
      expect(status(args)).toBe(1);
      expect(() => run(args)).toThrow(/snapshot-not-pinned: ledger:global/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('embeds both ledger hashes, the project disposition and the expansion state in the PAYLOAD', () => {
    // What the scorer cross-checks against the gate set's own pins — so a run measured against a
    // substituted corpus or a degraded surface cannot be scored even if it was produced elsewhere.
    const f = fixture();
    try {
      const out = join(f.dir, 'run.json');
      run(f.args(out));
      const r = JSON.parse(readFileSync(out, 'utf8'));
      expect(r.payload.ledgers).toEqual({
        'ledger:global': f.ledgerSha256.global, 'ledger:project': f.ledgerSha256.project });
      expect(r.payload.projectDisposition).toBe('owned');
      expect(r.payload.expansionSha256).toBe(expansionTableSha256(defaultExpansion()!));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('REFUSES a snapshot missing home/projects.json instead of degrading to a global-only recall', () => {
    // The reviewer's second break: two snapshots with IDENTICAL pinned ledger bytes, differing only
    // by `rm home/projects.json` — the project decoy vanishes from recall and the verdict flips
    // while both ledger hashes still match the freeze. Since round 4 the registry's BYTES are one
    // of the ten pins, so the deletion now trips the pin comparison itself — the earlier, stronger
    // refusal — rather than surviving to the disposition check. The disposition refusal still
    // exists for the state a freeze legitimately pinned as registry-less.
    const f = fixture();
    try {
      rmSync(join(f.dir, 'home', 'projects.json'));
      const args = f.args(join(f.dir, 'run.json'));
      expect(status(args)).toBe(1);
      expect(() => run(args)).toThrow(/snapshot-not-pinned/);
      expect(() => run(args)).toThrow(/ownership:registry/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('REFUSES to run without the semantic-neighbor asset instead of silently ranking degraded', () => {
    // The third break: `data/semantic-neighbors.json` resolves relative to the bundle's own URL, so
    // a bundle without `data/` beside it silently loses query expansion — same gate set, manifest,
    // snapshot and argv, different ranks, exit 0. Three consistent degraded runs then pass
    // Stability. The runner resolves the expansion ITSELF and refuses when it is unavailable.
    const bare = mkdtempSync(join(tmpdir(), 'runpilot-nodata-'));
    const f = fixture();
    try {
      // Copy the bundled CLI to a directory with no `data/` at either of expansion.ts's candidate
      // locations (<root>/data and <root>/inner/data), mirroring a mis-deployed bundle.
      mkdirSync(join(bare, 'inner', 'bin'), { recursive: true });
      const nodata = join(bare, 'inner', 'bin', 'run-pilot.mjs');
      copyFileSync(cli, nodata);
      const args = f.args(join(f.dir, 'run.json'));
      let thrown: { status?: number; stderr?: Buffer } | undefined;
      try { execFileSync(process.execPath, [nodata, ...args], { cwd: process.cwd(), stdio: 'pipe' }); }
      catch (e) { thrown = e as { status?: number; stderr?: Buffer }; }
      expect(thrown, 'a bundle without data/ beside it must not exit 0').toBeDefined();
      expect(thrown!.status).toBe(1);
      expect(String(thrown!.stderr)).toMatch(/degraded-run/);
      expect(String(thrown!.stderr)).toMatch(/semantic-neighbor/);
      expect(existsSync(join(f.dir, 'run.json'))).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('the runner and the score phase are one change (§9b)', () => {
  it('scores Stability as PASS over three REAL runner outputs, produced by three real invocations', () => {
    // Deliberately end to end rather than over a reconstructed shape: the coupling §9b records is
    // between what the runner WRITES and what the scorer COMPARES, and a test that hand-rolls the
    // run artifact cannot see the two drift apart. Here the gate set is really prepared, the runner
    // CLI really runs three times, and the real scorer reads the files it really wrote.
    const f = fixture();
    try {
      const probes = (JSON.parse(readFileSync(f.manifestPath, 'utf8')) as
        { probes: { id: string; query: string; relevant: string[]; unambiguous: boolean; side: string }[] }).probes;
      // The manifest, ledger, trust and expansion hashes are the REAL ones — the runner refuses
      // any of the eight pins it consumes when the bytes are not the pinned ones, so a placeholder
      // in any of them would make the end-to-end path unrunnable. classifier/universe stay
      // placeholders: the runner never reads those files.
      const trustPaths = snapshotTrustPaths(f.dir);
      const inputs = { manifest: f.manifestSha256, classifier: 'b'.repeat(64), universe: 'c'.repeat(64),
        'ledger:global': f.ledgerSha256.global, 'ledger:project': f.ledgerSha256.project,
        'ownership:registry': sha256BytesOrAbsent('(fixture)', trustPaths['ownership:registry']!),
        'ownership:owner': sha256BytesOrAbsent('(fixture)', trustPaths['ownership:owner']!),
        'trust:master-key': sha256BytesOrAbsent('(fixture)', trustPaths['trust:master-key']!),
        'trust:witness': sha256BytesOrAbsent('(fixture)', trustPaths['trust:witness']!),
        'expansion:semantic-neighbors': expansionTableSha256(defaultExpansion()!) };
      const gateSet = prepareGateSet({
        manifest: { k: 20, txAfter: '2026-07-21T00:00:00.000Z', txClose: '2026-08-18T00:00:00.000Z', probes },
        classifier: { rule: 'o67-class-rule-2026-07', manifest: 'holdout.json', probes: [
          { id: 'L_m_1', status: 'not-in-class', targetId: 'm_1', targetScope: 'project', hit1Eligible: true },
          { id: 'L_m_2', status: 'not-in-class', targetId: 'm_2', targetScope: 'global', hit1Eligible: true },
        ] },
        universe: { rule: 'o67-class-rule-2026-07', artifact: 'candidate-universe', manifest: 'holdout.json',
          recallBound: 20,
          disclosure: { rowsByScope: { global: 1, project: 1 }, projectDisposition: 'owned',
            integrityAvailable: true, witnessNotes: [], expansionAvailable: true },
          probes: probes.map((p) => ({ id: p.id, candidates: [] })) },
        ledgers: readSnapshot(f.dir),
        pins: { k: 20, txAfter: '2026-07-21T00:00:00.000Z', txClose: '2026-08-18T00:00:00.000Z', inputs },
        inputHashes: inputs,
        now: () => '2026-08-18T09:00:00.000Z',
      });
      writeFileSync(f.gateSetPath, JSON.stringify(gateSet, null, 1) + '\n');

      const runs = ['1', '2', '3'].map((n) => {
        const out = join(f.dir, `run-${n}.json`);
        run(['--manifest', f.manifestPath, '--snapshot', f.dir, '--gate-set', f.gateSetPath, '--out', out]);
        return readFileSync(out, 'utf8');
      });
      expect(new Set(runs).size).toBe(3);                       // three distinct FILES...

      const first = JSON.parse(runs[0]!) as { payload: unknown; receipts: { runId: string } };
      const adjudication: Adjudication = {
        artifact: 'adjudication', gateSetSha256: gateSet.payloadSha256,
        runPayloadSha256: sha256(JSON.stringify(first.payload)),
        contradictions: gateSet.payload.recallDenominator.map((id) => ({ probeId: id, verdict: 'none' as const })),
        staleViolations: [],
      };
      const s = scoreGate({ gateSet, expectPayloadSha256: gateSet.payloadSha256, runs, adjudication,
        now: () => '2026-08-18T10:00:00.000Z' });

      expect(s.payload.stability.pass).toBe(true);              // ...one payload hash
      expect(new Set(s.payload.stability.runPayloadSha256).size).toBe(1);
      expect(new Set(s.receipts.runIds).size).toBe(3);
      expect(s.payload.release.reasons.join(' ')).not.toMatch(/Stability/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('run-pilot CLI — the trust surface and the runtime surface are pinned too (round 4)', () => {
  /** Round 3 proved three substitutions that flip a verdict with the manifest and both ledger pins
   *  green: a macNonce swapped inside home/projects.json (TRUST_PENALTY re-scores under the wrong
   *  subkey), a planted witness journal (the store excludes the whole scope), and an empty
   *  semantic-neighbor table (all query expansion silently gone). Each lives in a file — or a
   *  resolved object — that the ten-name pin surface now covers, and the runner verifies every pin
   *  it consumes before a single rank exists. */
  it('embeds the four trust pins and the expansion content hash in the payload — and no boolean', () => {
    const f = fixture();
    const outDir = mkdtempSync(join(tmpdir(), 'runout-'));
    try {
      const out = join(outDir, 'run.json');
      run(f.args(out));
      const r = JSON.parse(readFileSync(out, 'utf8'));
      expect(Object.keys(r.payload.trust).sort()).toEqual(
        ['ownership:owner', 'ownership:registry', 'trust:master-key', 'trust:witness']);
      const g = JSON.parse(readFileSync(f.gateSetPath, 'utf8'));
      for (const name of Object.keys(r.payload.trust)) {
        expect(r.payload.trust[name], name).toBe(g.payload.inputs[name]);
      }
      expect(r.payload.expansionSha256).toBe(g.payload.inputs['expansion:semantic-neighbors']);
      // The round-3 boolean proved only that SOME table resolved — an empty one included. The
      // content hash replaced it; carrying both would let the weaker claim shadow the stronger.
      expect('expansionAvailable' in r.payload).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('REFUSES a registry with no @global entry instead of letting the store mint one into the snapshot', () => {
    const f = fixture(() => {}, { mintGlobal: false });
    const outDir = mkdtempSync(join(tmpdir(), 'runout-'));
    try {
      const registry = join(f.home, 'projects.json');
      const before = readFileSync(registry, 'utf8');
      const out = join(outDir, 'run.json');
      let stderr = '';
      try { run(f.args(out)); } catch (e) { stderr = String((e as { stderr?: Buffer }).stderr ?? ''); }
      expect(stderr).toMatch(/snapshot-registry-incomplete/);
      expect(existsSync(out)).toBe(false);
      // The refusal's whole point: the registry bytes are exactly what they were.
      expect(readFileSync(registry, 'utf8')).toBe(before);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('REFUSES a macNonce swapped inside the registry after the freeze — the round-3 rank-flip', () => {
    // stamp, adoptedAt and the master key untouched: isOwned still answers owned, the subkey still
    // resolves, and only the re-scoring of signed verify rows changes. The registry BYTES changed,
    // which is what the ownership:registry pin exists to see.
    const f = fixture();
    const outDir = mkdtempSync(join(tmpdir(), 'runout-'));
    try {
      const registry = join(f.home, 'projects.json');
      const reg = JSON.parse(readFileSync(registry, 'utf8')) as Record<string, { macNonce?: string }>;
      for (const key of Object.keys(reg)) { if (reg[key]!.macNonce) reg[key]!.macNonce = '0'.repeat(32); }
      writeFileSync(registry, JSON.stringify(reg, null, 1) + '\n');
      const out = join(outDir, 'run.json');
      let stderr = '';
      try { run(f.args(out)); } catch (e) { stderr = String((e as { stderr?: Buffer }).stderr ?? ''); }
      expect(stderr).toMatch(/snapshot-not-pinned/);
      expect(stderr).toMatch(/ownership:registry/);
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('REFUSES a snapshot whose witness state would exclude a scope from recall', () => {
    // The journal is planted with the SHIPPED writers and the pins are computed AFTER planting, so
    // every pin matches and the refusal exercised is the witness one — the store would otherwise
    // serve a recall in which the whole project scope silently vanished, scored end to end with
    // protocol-population-integrity PASS (round-3 finding 1).
    const f = fixture(() => {}, { plantWitness: true });
    const outDir = mkdtempSync(join(tmpdir(), 'runout-'));
    try {
      const out = join(outDir, 'run.json');
      let stderr = '';
      try { run(f.args(out)); } catch (e) { stderr = String((e as { stderr?: Buffer }).stderr ?? ''); }
      expect(stderr).toMatch(/degraded-run/);
      expect(stderr).toMatch(/witness/i);
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('REFUSES an expansion table whose CONTENT is not the pinned one — resolvability is not identity', () => {
    // Round 3: `{"neighbors":{}}` resolves cleanly, removes all query expansion, and every
    // then-current check stayed green. The pin hashes the resolved table, so the empty table is a
    // mismatch like any other — not a degraded-run, which remains the cannot-resolve case.
    const f = fixture();
    const bare = mkdtempSync(join(tmpdir(), 'emptyexp-'));
    try {
      mkdirSync(join(bare, 'bin'));
      mkdirSync(join(bare, 'data'));
      copyFileSync(cli, join(bare, 'bin', 'run-pilot.mjs'));
      writeFileSync(join(bare, 'data', 'semantic-neighbors.json'), '{"neighbors":{}}\n');
      const out = join(bare, 'run.json');
      let stderr = '';
      let status = 0;
      try {
        execFileSync(process.execPath, [join(bare, 'bin', 'run-pilot.mjs'), ...f.args(out)],
          { cwd: process.cwd(), stdio: 'pipe' });
      } catch (e) {
        const err = e as { status?: number; stderr?: Buffer };
        status = err.status ?? -1; stderr = String(err.stderr ?? '');
      }
      expect(status).toBe(1);
      expect(stderr).toMatch(/expansion-not-pinned/);
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('leaves the frozen snapshot BYTE-IDENTICAL across a successful run', () => {
    // The property the runner's own header claims, held as a regression test: round 3 caught the
    // store MINTING a global scope nonce into home/projects.json on first recall — run 1 mutating
    // an input runs 2 and 3 then read, and breaking any §9 item-2 snapshot hash taken beforehand.
    const f = fixture();
    const outDir = mkdtempSync(join(tmpdir(), 'runout-'));
    try {
      const treeHash = (root: string): Record<string, string> => {
        const acc: Record<string, string> = {};
        const walk = (rel: string) => {
          for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
            const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
            if (entry.isDirectory()) walk(childRel);
            else acc[childRel] = createHash('sha256').update(readFileSync(join(root, childRel))).digest('hex');
          }
        };
        walk('');
        return acc;
      };
      const before = treeHash(f.dir);
      run(f.args(join(outDir, 'run-1.json')));
      run(f.args(join(outDir, 'run-2.json')));
      expect(treeHash(f.dir)).toEqual(before);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
