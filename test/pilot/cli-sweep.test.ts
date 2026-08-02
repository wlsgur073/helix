import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { bundleCli } from '../helpers/bundle-cli.js';

/** The properties every pilot CLI has to hold, tested once across all of them.
 *
 *  Each of these was reproduced against the real bundled executables before it was fixed, and each
 *  is a property of the PROCESS — which exit code an operator's script sees, whether a file on disk
 *  survives — so every case here spawns the bundled CLI rather than calling an exported function.
 *  None of them is observable from the exported half.
 *
 *  X1  §9 line 376 requires a path that "refuses pre-existing outputs" and "creates every file
 *      exclusively". Six CLIs did neither: `--out` pointed at an input overwrote it (after the
 *      input had already been read and hashed, in two cases), and `--out` over any existing file
 *      destroyed it silently. Named flags — which three header comments credited with having fixed
 *      this — prevent an input being MISTAKEN for an output; they do nothing about an output
 *      deliberately aimed at one.
 *  X2  `name in out` walks Object.prototype, so `--constructor x` was reported as "given more than
 *      once" — a statement about the operator's argv that is simply false.
 *  X3  A mistyped path exited 1 with a raw stack, which is the code reserved for "the gate forbids
 *      what you are recording". Automation could not tell a typo from a refusal.
 */

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const HEX = sha256('a stand-in for a real payload hash');

/** One CLI's shape, in the terms these three properties are stated in.
 *
 *  `inputs` is every flag whose value is a path the invocation READS — the set an `--out` must not
 *  be allowed to name. `json` is one of those that has to parse as JSON, used for the malformed
 *  input case. `rest` is whatever else makes the argv well-formed; none of it is a path. */
interface Spec {
  name: string;
  entry: string;
  inputs: string[];
  json: string;
  rest: (dir: string) => string[];
}

const CLIS: Spec[] = [
  { name: 'prepare-gate', entry: 'scripts/pilot/prepare-gate.ts',
    inputs: ['manifest', 'classifier', 'universe', 'pins'], json: 'manifest',
    rest: (dir) => ['--snapshot', dir] },
  { name: 'run-pilot', entry: 'scripts/pilot/run-pilot.ts',
    inputs: ['manifest', 'gate-set'], json: 'gate-set',
    rest: (dir) => ['--snapshot', dir] },
  { name: 'score-gate', entry: 'scripts/pilot/score-gate.ts',
    inputs: ['gate-set', 'run1', 'run2', 'run3', 'adjudication'], json: 'gate-set',
    rest: () => ['--expect-payload', HEX] },
  { name: 'freeze-receipt', entry: 'scripts/pilot/freeze-receipt.ts',
    inputs: ['runtime', 'config'], json: 'runtime',
    rest: () => ['--commit', 'HEAD', '--cutoff', '2026-07-30T00:00:00.000Z', '--k', '20'] },
  { name: 'input-pins', entry: 'scripts/pilot/input-pins.ts',
    inputs: ['freeze', 'manifest', 'classifier', 'universe'], json: 'freeze',
    rest: (dir) => ['--snapshot', dir] },
  { name: 'release-record', entry: 'scripts/pilot/release-record.ts',
    inputs: ['score'], json: 'score',
    rest: () => ['--decision', 'blocked', '--consequence', 'what was not released',
      '--evidence', 'where a reader checks it', '--ordering-head', HEX] },
];

/** CLIs the table above does not describe: `ordering-receipt` is per-mode, and the last two still
 *  take positionals. All three are bundled here so the whole pilot surface is spawned from one file. */
const EXTRA = [
  { name: 'ordering-receipt', entry: 'scripts/pilot/ordering-receipt.ts' },
  { name: 'generate-manifest', entry: 'scripts/pilot/generate-manifest.ts' },
  { name: 'classify-o67', entry: 'scripts/pilot/classify-o67.ts' },
];

const bins = new Map<string, string>();
beforeAll(async () => {
  for (const c of [...CLIS, ...EXTRA]) bins.set(c.name, await bundleCli(c.entry));
}, 240_000);

interface Ran { status: number; stderr: string }
const spawn = (name: string, argv: string[]): Ran => {
  try {
    execFileSync(process.execPath, [bins.get(name)!, ...argv], { cwd: process.cwd(), stdio: 'pipe' });
    return { status: 0, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer };
    return { status: err.status ?? -1, stderr: String(err.stderr ?? '') };
  }
};

/** A fixture holding one distinct, well-formed file per input flag, plus a snapshot the two
 *  snapshot-taking CLIs can read, plus an already-occupied output path. Nothing here has to satisfy
 *  the gate: every property under test is decided before or independently of what the files say. */
const fixture = (spec: Spec) => {
  const dir = mkdtempSync(join(tmpdir(), `sweep-${spec.name}-`));
  mkdirSync(join(dir, 'home'), { recursive: true });
  mkdirSync(join(dir, 'proj', '.helix'), { recursive: true });
  const row = (id: string) => JSON.stringify({
    id, tx: '2026-08-01T00:00:00.000Z', type: 'assert', content: `content ${id}`, supersedes: null });
  writeFileSync(join(dir, 'home', 'memory.jsonl'), row('m_g') + '\n');
  writeFileSync(join(dir, 'proj', '.helix', 'memory.jsonl'), row('m_p') + '\n');

  const paths: Record<string, string> = {};
  for (const flag of spec.inputs) {
    paths[flag] = join(dir, `${flag}.json`);
    writeFileSync(paths[flag]!, JSON.stringify({ flag }, null, 1) + '\n');
  }
  const out = join(dir, 'out.json');
  const occupied = join(dir, 'occupied.json');
  writeFileSync(occupied, 'PRIOR CONTENT THAT MUST SURVIVE\n');

  const argv = (over: { out?: string; inputs?: Record<string, string> } = {}) => [
    ...spec.inputs.flatMap((f) => [`--${f}`, over.inputs?.[f] ?? paths[f]!]),
    ...spec.rest(dir),
    '--out', over.out ?? out,
  ];
  return { dir, paths, out, occupied, argv };
};

/** The X3 contract in one place: a path the operator named wrongly is reported as
 *  `<kebab-slug>: <why>` and exits 2, with no stack frames. Exit 1 stays reserved for a refusal of
 *  what is being recorded, which is the distinction `release-record.ts` promises its callers. */
const expectPathRefusal = (name: string, argv: string[], slug?: RegExp): void => {
  const r = spawn(name, argv);
  expect(r.status, `${name} ${argv.join(' ')}\nstderr: ${r.stderr}`).toBe(2);
  expect(r.stderr, `${name}: stderr must open with a kebab-case slug`).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*: /);
  expect(r.stderr, `${name}: a raw stack trace is not a refusal`).not.toMatch(/\n\s+at \S/);
  if (slug) expect(r.stderr, `${name}`).toMatch(slug);
};

describe.each(CLIS)('X1 — $name refuses an output that aliases an input', (spec) => {
  it.each(spec.inputs)('--out pointed at --%s is refused and the input survives', (flag) => {
    const f = fixture(spec);
    try {
      const before = readFileSync(f.paths[flag]!, 'utf8');
      expectPathRefusal(spec.name, f.argv({ out: f.paths[flag]! }), /output-aliases-input/);
      expect(readFileSync(f.paths[flag]!, 'utf8'), `--${flag} was overwritten`).toBe(before);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('refuses an --out that names one input under a different spelling of the same path', () => {
    // Resolved paths, not strings: `./a/b.json` and an absolute `/…/a/b.json` are one file, and a
    // check that compared the two argv values verbatim would pass every one of them through.
    const f = fixture(spec);
    try {
      const target = spec.inputs[0]!;
      const spelled = join(f.dir, '.', 'nowhere', '..', `${target}.json`);
      expectPathRefusal(spec.name, f.argv({ out: spelled }), /output-aliases-input/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe.each(CLIS)('X1 — $name refuses a pre-existing output', (spec) => {
  it('will not write over a file that already exists', () => {
    const f = fixture(spec);
    try {
      expectPathRefusal(spec.name, f.argv({ out: f.occupied }), /output-exists/);
      expect(readFileSync(f.occupied, 'utf8')).toBe('PRIOR CONTENT THAT MUST SURVIVE\n');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe.each(CLIS)('X3 — $name separates a path error from a gate refusal', (spec) => {
  it('an input file that does not exist', () => {
    const f = fixture(spec);
    try {
      expectPathRefusal(spec.name, f.argv({ inputs: { [spec.json]: join(f.dir, 'absent.json') } }));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('an input file that is not JSON', () => {
    const f = fixture(spec);
    try {
      writeFileSync(f.paths[spec.json]!, 'not json{\n');
      expectPathRefusal(spec.name, f.argv());
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('an --out under a directory that does not exist', () => {
    const f = fixture(spec);
    try {
      expectPathRefusal(spec.name, f.argv({ out: join(f.dir, 'absent-dir', 'out.json') }),
        /output-unwritable/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe.each(CLIS)('X2 — $name does not read a flag name off Object.prototype', (spec) => {
  it.each(['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'])(
    '--%s is refused as an unknown input, not as a repeated one', (name) => {
      const f = fixture(spec);
      try {
        const r = spawn(spec.name, [...f.argv(), `--${name}`, 'x']);
        expect(r.status).toBe(2);
        expect(r.stderr, 'the operator did not pass this flag twice').not.toMatch(/duplicate-input/);
        expect(r.stderr).toMatch(/unknown-input/);
      } finally { rmSync(f.dir, { recursive: true, force: true }); }
    });

  it('still reports a genuine repeat as a repeat', () => {
    const f = fixture(spec);
    try {
      const r = spawn(spec.name, [...f.argv(), '--out', f.out]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/duplicate-input/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('X2 — ordering-receipt', () => {
  const fx = () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-ordering-'));
    return { dir, log: join(dir, 'ordering.log') };
  };

  it.each(['constructor', 'toString', '__proto__', 'valueOf'])(
    '--%s is refused as an unknown input of the mode, not as a repeated one', (name) => {
      // The reviewer's reproduction verbatim. `duplicate-input` here is a false statement about
      // what was on the command line, and this CLI checks for repeats BEFORE it consults its
      // per-mode allow-list, which is why it is the one that reached the operator.
      const f = fx();
      try {
        writeFileSync(f.log, '');
        const r = spawn('ordering-receipt', ['--mode', 'verify', '--log', f.log, `--${name}`, 'x']);
        expect(r.status).toBe(2);
        expect(r.stderr).not.toMatch(/duplicate-input/);
        expect(r.stderr).toMatch(/unknown-input/);
      } finally { rmSync(f.dir, { recursive: true, force: true }); }
    });

  it('refuses a --mode named after an Object.prototype key with a slug, not a TypeError', () => {
    // `'constructor' in MODES` is true, so `MODES[mode].allowed` was `undefined` and the CLI died
    // on "Cannot read properties of undefined (reading 'includes')" — a JS runtime message where
    // an unknown-mode refusal belongs.
    const f = fx();
    try {
      const r = spawn('ordering-receipt', ['--mode', 'constructor', '--log', f.log]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/^unknown-mode: /);
      expect(r.stderr).not.toMatch(/Cannot read properties/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('still reports a genuine repeat as a repeat', () => {
    const f = fx();
    try {
      const r = spawn('ordering-receipt', ['--mode', 'verify', '--log', f.log, '--log', f.log]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/duplicate-input/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('X1/X3 — ordering-receipt\'s log is an append, and stays one', () => {
  const fx = () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-ordlog-'));
    return { dir, log: join(dir, 'ordering.log') };
  };
  const append = (log: string, event: string, sha: string, runId?: string) =>
    spawn('ordering-receipt', ['--mode', 'append', '--log', log, '--event', event,
      '--payload-sha', sha, ...(runId ? ['--run-id', runId] : [])]);

  it('appends to an existing log — the one write in the pilot that is EXEMPT from exclusive create', () => {
    // §9's "creates every file exclusively" is about artifacts. This log is the one file the chain
    // requires to GROW, so refusing a pre-existing target here would make a second entry impossible
    // and there would be no chain at all.
    const f = fx();
    try {
      expect(append(f.log, 'prepare-finished', HEX).status).toBe(0);
      expect(append(f.log, 'runner-started', HEX, 'run-1').status).toBe(0);
      expect(readFileSync(f.log, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('reports an unwritable --log as a path error, not as an integrity failure', () => {
    const f = fx();
    try {
      expectPathRefusal('ordering-receipt', ['--mode', 'append', '--log',
        join(f.dir, 'absent-dir', 'ordering.log'), '--event', 'prepare-finished', '--payload-sha', HEX],
      /output-unwritable/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('reports an unreadable --log as a path error rather than an empty log', () => {
    // A directory is readable as a path and not as a log. Treating the failure as "no log yet"
    // would let an append mint a fresh seq 0 chain beside a log that already exists.
    const f = fx();
    try {
      mkdirSync(join(f.dir, 'adir'));
      expectPathRefusal('ordering-receipt', ['--mode', 'append', '--log', join(f.dir, 'adir'),
        '--event', 'prepare-finished', '--payload-sha', HEX]);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('X1 — the artifacts that were reproduced as destroyed', () => {
  it('release-record --out == --score leaves the score it binds intact', () => {
    // Reproduced at exit 0: the record was written over the score, so the file the record names is
    // the record itself, and the score whose hash it carries exists nowhere.
    const dir = mkdtempSync(join(tmpdir(), 'sweep-relrec-'));
    try {
      const payload = { rule: 'v2-gate-composition-2026-07-29', release: { blocked: true, reasons: ['r'] } };
      const score = join(dir, 'gate-score.json');
      const bytes = JSON.stringify({ artifact: 'gate-score', payloadSha256: sha256(JSON.stringify(payload)),
        payload, receipts: { scoredAt: 'x', attestation: 'y' } }, null, 1) + '\n';
      writeFileSync(score, bytes);
      expectPathRefusal('release-record', ['--score', score, '--decision', 'blocked',
        '--consequence', 'nothing shipped', '--evidence', 'no tag exists', '--ordering-head', HEX,
        '--out', score], /output-aliases-input/);
      expect(readFileSync(score, 'utf8')).toBe(bytes);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an --out inside the snapshot cannot overwrite a pinned ledger', () => {
    // The ledgers are hashed as pinned inputs in their own right (`prepare-gate.ts` writes
    // `ledger:global` / `ledger:project`), so they are inputs even though no flag names them
    // directly — `--snapshot` does, one directory up.
    const spec = CLIS.find((c) => c.name === 'prepare-gate')!;
    const f = fixture(spec);
    try {
      const ledger = join(f.dir, 'home', 'memory.jsonl');
      const before = readFileSync(ledger, 'utf8');
      expectPathRefusal('prepare-gate', f.argv({ out: ledger }), /output-aliases-input/);
      expect(readFileSync(ledger, 'utf8')).toBe(before);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('freeze-receipt cannot write its receipt over a tool or method document it pins', () => {
    // §10's tool table and the two binding rule documents are read from the working tree and
    // hashed into the payload. They are inputs of this invocation exactly as `--config` is, and an
    // `--out` aimed at one would overwrite a pinned input AFTER hashing it — the same shape as the
    // generate-manifest incident the header comments cite.
    const spec = CLIS.find((c) => c.name === 'freeze-receipt')!;
    const f = fixture(spec);
    try {
      for (const rel of ['scripts/pilot/gate-set.ts', 'docs/release/o67-class-rule-2026-07.md']) {
        expectPathRefusal('freeze-receipt', f.argv({ out: join(process.cwd(), rel) }),
          /output-aliases-input/);
      }
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

/** The two pilot CLIs the finding list did not name, and the reason they matter more than the rest:
 *  `generate-manifest` is the program the incident is named after. Three header comments elsewhere
 *  cite it — "lined an oracle path up with an output slot and overwrote a hash-pinned artifact" —
 *  and it still took `<snapshotDir> <oracleMd> <mappingJson> <out>` with `<out>` free to name the
 *  oracle. Reproduced at exit 0, oracle replaced by a manifest. `classify-o67` is the same shape and
 *  writes TWO files, the second at a path DERIVED from `<out>`, which nothing checked at all. */
describe('X1/X3 — the positional CLIs the list missed', () => {
  const snapshot = () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-positional-'));
    mkdirSync(join(dir, 'home'), { recursive: true });
    mkdirSync(join(dir, 'proj', '.helix'), { recursive: true });
    const row = (id: string, content: string) => JSON.stringify({
      id, tx: '2026-08-01T00:00:00.000Z', validFrom: '2026-08-01T00:00:00.000Z', validTo: null,
      type: 'assert', state: 'Fresh', content, provenance: { source: 'user', sessionId: 't' },
      supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' }) + '\n';
    writeFileSync(join(dir, 'home', 'memory.jsonl'), row('m_g', 'deployment timeout is thirty seconds by default'));
    writeFileSync(join(dir, 'proj', '.helix', 'memory.jsonl'), row('m_a', 'release gate blocks on stability divergence'));
    writeFileSync(join(dir, 'oracle.md'), '# N\n- deployment timeout is thirty seconds\n');
    writeFileSync(join(dir, 'mapping.json'), '{}\n');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ k: 20, probes: [
      { id: 'p1', query: 'deployment timeout', relevant: ['m_g'], unambiguous: true }] }) + '\n');
    writeFileSync(join(dir, 'occupied.json'), 'PRIOR CONTENT THAT MUST SURVIVE\n');
    return dir;
  };
  const frozen = (dir: string, out: string) => [dir, join(dir, 'oracle.md'), join(dir, 'mapping.json'), out];
  const holdout = (dir: string, out: string) =>
    ['--after', '2026-07-21T00:00:00.000Z', '--close', '2026-08-18T00:00:00.000Z', dir, out];
  const classify = (dir: string, out: string) => [join(dir, 'manifest.json'), dir, out];

  it('generate-manifest will not write its manifest over the oracle it read', () => {
    const dir = snapshot();
    try {
      const oracle = join(dir, 'oracle.md');
      const before = readFileSync(oracle, 'utf8');
      expectPathRefusal('generate-manifest', frozen(dir, oracle), /output-aliases-input/);
      expect(readFileSync(oracle, 'utf8')).toBe(before);
      expectPathRefusal('generate-manifest', frozen(dir, join(dir, 'mapping.json')), /output-aliases-input/);
      expectPathRefusal('generate-manifest', holdout(dir, join(dir, 'home', 'memory.jsonl')),
        /output-aliases-input/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('generate-manifest refuses a pre-existing output in both of its shapes', () => {
    const dir = snapshot();
    try {
      for (const argv of [frozen(dir, join(dir, 'occupied.json')), holdout(dir, join(dir, 'occupied.json'))]) {
        expectPathRefusal('generate-manifest', argv, /output-exists/);
        expect(readFileSync(join(dir, 'occupied.json'), 'utf8')).toBe('PRIOR CONTENT THAT MUST SURVIVE\n');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('generate-manifest reports a path error as a path error', () => {
    const dir = snapshot();
    try {
      expectPathRefusal('generate-manifest',
        [dir, join(dir, 'oracle.md'), join(dir, 'absent.json'), join(dir, 'm.json')]);
      writeFileSync(join(dir, 'mapping.json'), 'not json{\n');
      expectPathRefusal('generate-manifest', frozen(dir, join(dir, 'm.json')));
      expectPathRefusal('generate-manifest', holdout(dir, join(dir, 'absent-dir', 'm.json')),
        /output-unwritable/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('classify-o67 will not write over the manifest it read, nor over an existing file', () => {
    const dir = snapshot();
    try {
      const manifest = join(dir, 'manifest.json');
      const before = readFileSync(manifest, 'utf8');
      expectPathRefusal('classify-o67', classify(dir, manifest), /output-aliases-input/);
      expect(readFileSync(manifest, 'utf8')).toBe(before);
      expectPathRefusal('classify-o67', classify(dir, join(dir, 'occupied.json')), /output-exists/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('classify-o67 checks the DERIVED universe path too, before it writes either file', () => {
    // The second artifact's name is computed from `<out>`, so `<out>` being free leaves the derived
    // path free as well. Nothing checked it: an existing `x.universe.json` was overwritten by a run
    // whose `<out>` was `x.json`, and the check has to happen before EITHER file is written or the
    // verdicts land and the universe refusal arrives afterwards.
    const dir = snapshot();
    try {
      writeFileSync(join(dir, 'x.universe.json'), 'A PRIOR UNIVERSE ARTIFACT\n');
      expectPathRefusal('classify-o67', classify(dir, join(dir, 'x.json')), /output-exists/);
      expect(readFileSync(join(dir, 'x.universe.json'), 'utf8')).toBe('A PRIOR UNIVERSE ARTIFACT\n');
      expect(existsSync(join(dir, 'x.json'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('classify-o67 reports a path error as a path error', () => {
    const dir = snapshot();
    try {
      expectPathRefusal('classify-o67', [join(dir, 'absent.json'), dir, join(dir, 'v.json')]);
      writeFileSync(join(dir, 'manifest.json'), 'not json{\n');
      expectPathRefusal('classify-o67', classify(dir, join(dir, 'v.json')));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  /** The snapshot readers are the LAST place the two exit codes were still crossed, and they are
   *  reachable only here: `prepare-gate` and `input-pins` open the same two ledgers through
   *  `readInput` first, so their own refusal arrives before `readSnapshot`'s ever can. A mutation
   *  reverting `snapshot.ts` to a plain `Error` survived the whole suite until these two cases
   *  existed. */
  it('a snapshot whose ledger is missing or corrupt is a path error, not a corpus refusal', () => {
    const dir = snapshot();
    try {
      const ledger = join(dir, 'home', 'memory.jsonl');
      const saved = readFileSync(ledger, 'utf8');
      rmSync(ledger);
      // `readSnapshot` — the generator's path. ABSENT stays fatal (a snapshot copied without its
      // global ledger yields probes that are unambiguous only because their competitors were never
      // read); what changes is that it is reported as the argument it is.
      expectPathRefusal('generate-manifest', holdout(dir, join(dir, 'm.json')), /ledger-unreadable/);

      writeFileSync(ledger, `${saved}not json{\n`);
      expectPathRefusal('generate-manifest', holdout(dir, join(dir, 'm2.json')), /ledger-unparsable/);

      // `corpusPrecondition` — the classifier's separate reader, with the same defect and the same
      // fix. It ignores an ABSENT ledger by design (a snapshot need not carry a global one), so
      // this case has to make the file unreadable rather than remove it.
      expectPathRefusal('classify-o67', classify(dir, join(dir, 'v.json')), /ledger-unparsable/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('X4 — no pilot source cites the wrong section for the evidence chain', () => {
  it('the append-only receipt and the snapshot hash are never attributed to section 5', () => {
    // Section 5 of the preregistration is "Sample unit, minimum, close, and the reported bound" and
    // contains no chain at all. The append-only-or-externally-attested receipt is section 9 item 4;
    // the as-of-close snapshot hash is item 2. One of the offending strings lived inside
    // `receipts.attestation`, so the false pointer shipped in every artifact the pipeline wrote —
    // into the very document section 10 makes part of the method identity.
    //
    // The marker is assembled at runtime so that THIS file's own bytes never contain the pattern.
    // Excluding the checker from its own scan would leave exactly one file where the bad citation
    // could be reintroduced unnoticed.
    const S5 = `§${5}`;
    const cite = new RegExp(`${S5}(?!a)`, 'g');
    const CHAIN = /append-only|externally attested|provenance chain|as-of-close snapshot hash|'s chain/;
    const offenders: string[] = [];
    for (const dir of ['scripts/pilot', 'test/pilot']) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.ts')) continue;
        // Flattened first: these citations live in wrapped comments and in concatenated string
        // literals, so the claim and its section number are routinely on different LINES. A
        // line-by-line scan missed `score-gate.ts`, where "chain" sat on the continuation.
        const flat = readFileSync(join(dir, file), 'utf8')
          .replace(/'\s*\+\s*\n\s*'/g, '')
          .replace(/\n\s*\*?\s*/g, ' ');
        for (const m of flat.matchAll(cite)) {
          if (CHAIN.test(flat.slice(m.index, m.index + 160))) {
            offenders.push(`${dir}/${file}: ${flat.slice(m.index, m.index + 90)}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
