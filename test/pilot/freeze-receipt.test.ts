import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  PINNED_METHOD_DOCS, PINNED_TOOL_PATHS, gitHashObject, hashMethodDocs, hashTools,
  sha256Bytes, sha256Hex,
} from '../../scripts/pilot/pin-hashes.js';
import { decimalInteger, freezeReceipt } from '../../scripts/pilot/freeze-receipt.js';
import { RULE } from '../../scripts/pilot/gate-set.js';

/** §10 pins ten pilot scripts plus `src/memory/retrieval.ts` by their `git hash-object` value, and
 *  an operator must be able to reproduce every one of them with the real command. So the only
 *  meaningful test of the in-process implementation is agreement with `git hash-object` itself —
 *  a self-consistent but wrong blob id would pin nothing an outside reader could check. */
describe('gitHashObject', () => {
  it('reproduces the real `git hash-object` value for a repo file', () => {
    const path = 'src/memory/retrieval.ts';
    const real = execFileSync('git', ['hash-object', '--', path], { cwd: process.cwd(), encoding: 'utf8' }).trim();
    expect(gitHashObject(readFileSync(path))).toBe(real);
  });
});

// `hashPinnedInputs` — the ten-name pin surface — is covered in test/pilot/pin-hashes.test.ts,
// which owns the whole hashing module's contract; only the freeze-side helpers are tested here.

describe('hashTools', () => {
  /** §10 lists these eleven rows by name. The VALUES are deliberately not asserted — several of
   *  these files are under active edit, and a test that pinned their current bytes would fail on
   *  every legitimate change while proving nothing about this program. What must hold is that the
   *  set is complete and every entry is a well-formed blob id. */
  it('covers every path §10 pins AND every tool of the chain §9 requires, with a blob id for each', () => {
    // The first eleven are §10's own rows, in the table's order. The five after `run-pilot.ts` are
    // the producers §9b records as having no producer yet — the freeze receipt, the pins, the
    // ordering receipt and the release record, plus the hashing they share. §10's table predates
    // them and does not list them; pinning the method while leaving the programs that ISSUE the
    // method's evidence unpinned would leave the chain's own tooling free to change unnoticed.
    // The last row joined at the SECOND freeze: the adjudication producer issues the `--adjudication`
    // input the score phase requires, and building it inside the first window is what reset that
    // window — so the path the Reset clause has already been triggered by is one the mechanical
    // divergence check now covers. Its test is not here on purpose; no test file is.
    expect(PINNED_TOOL_PATHS).toEqual([
      'scripts/pilot/derive.ts', 'scripts/pilot/generate-manifest.ts', 'scripts/pilot/snapshot.ts',
      'scripts/pilot/classify-o67.ts', 'scripts/pilot/candidate-universe.ts', 'scripts/pilot/gate-set.ts',
      'scripts/pilot/prepare-gate.ts', 'scripts/pilot/score-gate.ts', 'scripts/pilot/binomial.ts',
      'scripts/pilot/run-pilot.ts',
      'scripts/pilot/freeze-receipt.ts', 'scripts/pilot/input-pins.ts', 'scripts/pilot/ordering-receipt.ts',
      'scripts/pilot/release-record.ts', 'scripts/pilot/pin-hashes.ts', 'scripts/pilot/artifact-io.ts',
      'src/memory/retrieval.ts', 'src/memory/store.ts', 'src/memory/expansion.ts',
      'src/memory/ownership.ts', 'src/memory/verified-read.ts', 'src/memory/verified-projection.ts',
      'src/memory/witness-store.ts', 'src/memory/witness-read.ts', 'src/memory/witness-core.ts',
      'scripts/close/adjudication-skeleton.ts',
    ]);
    const tools = hashTools(process.cwd());
    expect(Object.keys(tools)).toEqual([...PINNED_TOOL_PATHS]);
    for (const [path, id] of Object.entries(tools)) expect(id, path).toMatch(/^[0-9a-f]{40}$/);
  });

  it('refuses a pinned path that is not there rather than pinning a hole', () => {
    // A missing tool is the one case where an absent hash would be indistinguishable from a file
    // that legitimately has none — and §10's table has no "n/a" row for tooling.
    expect(() => hashTools(join(tmpdir(), 'no-such-repo-root'))).toThrow(/tool-unreadable/);
  });
});

describe('sha256Bytes', () => {
  /** The BYTE hash, and it is not `sha256Hex` with a Buffer waved at it. Two files differing only
   *  in an invalid UTF-8 byte decode to the SAME string — every ill-formed sequence becomes
   *  U+FFFD — so a utf8-decoded hash pins them identically. Where a hash has a counterparty that
   *  must reproduce a decode (`prepare-gate` reads its inputs as utf8 text), matching that decode
   *  is the contract; where it has none, decoding first only discards distinctions. */
  it('distinguishes byte sequences that a utf8 decode collapses into the same string', () => {
    const a = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]);
    const b = Buffer.from([0x7b, 0x22, 0xfe, 0x22, 0x7d]);
    expect(a.toString('utf8')).toBe(b.toString('utf8'));          // the premise: the decode collapses them
    expect(sha256Hex(a.toString('utf8'))).toBe(sha256Hex(b.toString('utf8')));
    expect(sha256Bytes(a)).not.toBe(sha256Bytes(b));
    expect(sha256Bytes(a)).toBe(createHash('sha256').update(a).digest('hex'));
  });
});

describe('hashMethodDocs', () => {
  /** §10 line 452 pins `o67-class-rule-2026-07.md` by sha256, and the preregistration's governing
   *  texts line names it and `gate-decision-2026-07-22.md` BINDING. Element 1 of §9's chain asks
   *  for "the method and tool hashes": these documents ARE the method — `inputs.classifier` hashes
   *  the classifier's OUTPUT, not the rule the classifier applied. */
  it('pins the two binding rule documents by their bytes, reproducibly with sha256sum', () => {
    expect(PINNED_METHOD_DOCS).toEqual([
      'docs/release/o67-class-rule-2026-07.md', 'docs/release/gate-decision-2026-07-22.md',
    ]);
    const docs = hashMethodDocs(process.cwd());
    expect(Object.keys(docs)).toEqual([...PINNED_METHOD_DOCS]);
    for (const [rel, hash] of Object.entries(docs)) {
      expect(hash, rel).toBe(createHash('sha256').update(readFileSync(rel)).digest('hex'));
    }
  });

  it('refuses a missing rule document rather than pinning a method it never read', () => {
    expect(() => hashMethodDocs(join(tmpdir(), 'no-such-repo-root'))).toThrow(/method-doc-unreadable/);
  });
});

const CUTOFF = '2026-07-21T00:00:00.000Z';
const CLOSE = '2026-08-18T00:00:00.000Z';
const RUNTIME = 'b'.repeat(40);
/** §10 line 436 pins the runtime as "installed plugin gitCommitSha, **both load paths**". Two
 *  paths, therefore, and a scalar has nowhere to record that they agreed. */
const loadPaths = () => [
  { path: '/opt/claude/plugins/cache/helix/helix/bin/helix-mcp.mjs', gitCommitSha: RUNTIME },
  { path: '/opt/claude/plugins/marketplaces/helix/bin/helix-mcp.mjs', gitCommitSha: RUNTIME },
];
/** The pinned bytes the fixture's commit "contains". Hashes are one-way, so the fixture is built
 *  bytes-first: pick the bytes, derive the working-tree hashes FROM them, and let the injected
 *  `pinnedBytesAtCommit` return the same bytes — a tree/commit AGREEMENT by construction. The
 *  divergence tests below then perturb exactly one side. */
const TOOL_BYTES: Record<string, Buffer> = { 'scripts/pilot/derive.ts': Buffer.from('fixture tool bytes\n') };
const DOC_BYTES: Record<string, Buffer> = { 'docs/release/o67-class-rule-2026-07.md': Buffer.from('fixture doc bytes\n') };
const TOOLS = Object.fromEntries(Object.entries(TOOL_BYTES).map(([rel, b]) => [rel, gitHashObject(b)]));
const DOCS = Object.fromEntries(Object.entries(DOC_BYTES).map(([rel, b]) => [rel, sha256Bytes(b)]));
const pinnedBytesAt = (over: Record<string, Buffer | null> = {}) =>
  (_commit: string, rels: string[]): Record<string, Buffer | null> =>
    Object.fromEntries(rels.map((rel) => [rel, Object.hasOwn(over, rel) ? over[rel]! : (TOOL_BYTES[rel] ?? DOC_BYTES[rel] ?? null)]));
const base = {
  candidateCommit: 'a'.repeat(40),
  runtime: { gitCommitSha: RUNTIME, loadPaths: loadPaths() },
  configPath: '/opt/helix/config.json',
  configBytes: Buffer.from('{"redacted":true}\n', 'utf8'),
  cutoff: CUTOFF,
  k: 20,
  tools: TOOLS,
  methodDocs: DOCS,
  // §2's derivation, injected: the freeze must VERIFY the operator's cutoff against the repository
  // rather than trust a transcription, and a program that calls git inside itself cannot be tested
  // against a cutoff it does not already agree with.
  commitAuthoredAt: () => CUTOFF,
  // The commit's view of the pinned paths, injected for the same reason as the line above.
  pinnedBytesAtCommit: pinnedBytesAt(),
  now: () => '2026-08-01T09:00:00.000Z',
};

describe('freezeReceipt — the window', () => {
  it('DERIVES txClose as cutoff + 28 days instead of accepting a second instant', () => {
    const receipt = freezeReceipt(base);
    expect(receipt.payload.txAfter).toBe(CUTOFF);
    expect(receipt.payload.txClose).toBe(CLOSE);
    expect(receipt.payload.windowDays).toBe(28);
  });

  it('refuses a cutoff that is not the canonical spelling', () => {
    // §2 compares the window bounds with a strict STRING comparison, so an instant that is equal
    // but spelled differently silently changes which rows fall inside the window.
    for (const bad of ['2026-07-21T00:00:00Z', '2026-07-21T00:00:00.000+00:00', '2026-07-21', '2026-07-21T00:00:00.000000Z']) {
      expect(() => freezeReceipt({ ...base, cutoff: bad }), bad).toThrow(/non-canonical-instant/);
    }
    // Well-formed in shape but not a real instant: `new Date` would roll it over to a valid one.
    expect(() => freezeReceipt({ ...base, cutoff: '2026-02-30T00:00:00.000Z' })).toThrow(/non-canonical-instant/);
  });

  it('refuses a shape-valid instant that names NO real time with the slug, not a RangeError', () => {
    // `2026-02-30` is the friendly case: V8 rolls it over to March, so the round-trip comparison
    // sees a different string and refuses. Nothing rolls over out-of-range MONTHS, hours or
    // minutes — `new Date(...)` returns Invalid Date and `.toISOString()` THROWS before the
    // comparison runs, so the CLI died with `RangeError: Invalid time value` and no slug at all.
    // Every refusal of this program is supposed to name what was refused and why (`fail`).
    for (const bad of ['2026-13-01T00:00:00.000Z', '2026-00-01T00:00:00.000Z',
      '2026-07-21T25:00:00.000Z', '2026-07-21T00:60:00.000Z', '2026-07-32T00:00:00.000Z']) {
      expect(() => freezeReceipt({ ...base, cutoff: bad }), bad).toThrow(/non-canonical-instant/);
    }
  });

  /** §2 lines 74-79 name this derivation as a trap that "must not be repeated" — the wrong
   *  `--date` spelling silently renders in the commit's own timezone. A CLI that accepts the
   *  result as a typed string repeats the trap in a different place: the cutoff would be whatever
   *  the operator pasted. So the cutoff stays explicit and is CHECKED against the repository. */
  it('refuses a cutoff that is not the candidate commit\'s authored time', () => {
    const authored = '2026-07-21T00:00:01.000Z';
    expect(() => freezeReceipt({ ...base, commitAuthoredAt: () => authored }))
      .toThrow(/cutoff-not-commit-time/);
    // One second out is the case worth naming: it is a plausible transcription, it produces a
    // well-formed receipt, and it moves the window's open edge across every row minted in between.
    expect(() => freezeReceipt({ ...base, commitAuthoredAt: () => authored })).toThrow(/00:00:01/);
  });

  it('resolves the CANDIDATE COMMIT, not some other revision, and lets an unresolvable one through', () => {
    const asked: string[] = [];
    freezeReceipt({ ...base, commitAuthoredAt: (c: string) => { asked.push(c); return CUTOFF; } });
    expect(asked).toEqual([base.candidateCommit]);
    // Pinning a commit the repository cannot resolve is not a freeze at all, so the resolver's
    // refusal is propagated rather than caught and downgraded to an unverified pin.
    expect(() => freezeReceipt({
      ...base,
      commitAuthoredAt: () => { throw new Error('commit-unresolved: no such object'); },
    })).toThrow(/commit-unresolved/);
  });
});

describe('freezeReceipt — the identity pins', () => {
  it('refuses a candidate commit or runtime sha that is not a 40- or 64-hex object id', () => {
    for (const bad of ['', 'abc123', 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), 'A'.repeat(40), `${'a'.repeat(40)}\n`]) {
      expect(() => freezeReceipt({ ...base, candidateCommit: bad }), `commit ${JSON.stringify(bad)}`)
        .toThrow(/malformed-object-id/);
      expect(() => freezeReceipt({ ...base, runtime: { gitCommitSha: bad, loadPaths: loadPaths() } }),
        `runtime ${JSON.stringify(bad)}`).toThrow(/malformed-object-id/);
      const one = loadPaths();
      one[0]!.gitCommitSha = bad;
      expect(() => freezeReceipt({ ...base, runtime: { gitCommitSha: RUNTIME, loadPaths: one } }),
        `load path ${JSON.stringify(bad)}`).toThrow(/malformed-object-id/);
    }
    // sha256 object format is a legitimate spelling and must not be refused along with the junk.
    expect(freezeReceipt({ ...base, candidateCommit: 'a'.repeat(64) }).payload.candidateCommit)
      .toBe('a'.repeat(64));
  });

  /** §10 line 436 pins "installed plugin gitCommitSha, **both load paths**", and the deploy
   *  runbook verifies them as a pair. A single scalar cannot record that they agreed, and this
   *  deployment's own history is why it matters: the marketplace cache and the installed copy have
   *  drifted before, and the version that serves recall is not always the one you just built. */
  describe('the runtime identity', () => {
    it('requires at least TWO load paths, because agreement between one thing is not agreement', () => {
      for (const paths of [[], [loadPaths()[0]!]]) {
        expect(() => freezeReceipt({ ...base, runtime: { gitCommitSha: RUNTIME, loadPaths: paths } }),
          `${paths.length} path(s)`).toThrow(/runtime-load-paths-insufficient/);
      }
    });

    it('REFUSES a disagreement between the load paths instead of picking one', () => {
      const split = loadPaths();
      split[1]!.gitCommitSha = 'c'.repeat(40);
      expect(() => freezeReceipt({ ...base, runtime: { gitCommitSha: RUNTIME, loadPaths: split } }))
        .toThrow(/runtime-load-paths-disagree/);
      // And a declared gitCommitSha that matches NEITHER path is the same failure: the scalar is
      // supposed to be what both paths carry, not a third claim about them.
      expect(() => freezeReceipt({ ...base, runtime: { gitCommitSha: 'd'.repeat(40), loadPaths: loadPaths() } }))
        .toThrow(/runtime-load-paths-disagree/);
    });

    it('refuses the same path listed twice, which is one load path wearing two rows', () => {
      const twice = [loadPaths()[0]!, { ...loadPaths()[0]! }];
      expect(() => freezeReceipt({ ...base, runtime: { gitCommitSha: RUNTIME, loadPaths: twice } }))
        .toThrow(/runtime-load-paths-duplicate/);
    });

    it('refuses two spellings that NORMALIZE to one path, and records the normalized spelling', () => {
      // '/a/x' and '/a//x' are one path wearing two rows: a raw string compare counted them as the
      // two independent copies the floor stands for. These are DECLARED paths, never opened, so
      // normalization is as far as the check can honestly reach — a symlink alias survives it.
      const spellings = [
        { path: '/cache/helix/bin/helix-mcp.mjs', gitCommitSha: RUNTIME },
        { path: '/cache/helix//bin/./helix-mcp.mjs', gitCommitSha: RUNTIME },
      ];
      expect(() => freezeReceipt({ ...base, runtime: { gitCommitSha: RUNTIME, loadPaths: spellings } }))
        .toThrow(/runtime-load-paths-duplicate/);
      // And a NON-duplicate odd spelling is stored normalized, because the payload is hashed: two
      // receipts describing one runtime must not differ by a `//` no reader would notice.
      const odd = [loadPaths()[0]!, { path: '/marketplaces/helix//bin/./helix-mcp.mjs', gitCommitSha: RUNTIME }];
      const receipt = freezeReceipt({ ...base, runtime: { gitCommitSha: RUNTIME, loadPaths: odd } });
      expect(receipt.payload.runtime.loadPaths[1]!.path).toBe('/marketplaces/helix/bin/helix-mcp.mjs');
    });

    it('refuses a shape that is not a runtime identity at all, naming which part is wrong', () => {
      const cases: [unknown, RegExp][] = [
        [null, /malformed-runtime-identity/],
        // The shape this flag USED to take. A bare sha is the thing §10 line 436 says is not
        // enough, so it must be refused rather than read as a one-path identity.
        ['b'.repeat(40), /malformed-runtime-identity/],
        [{}, /malformed-object-id/],
        [{ gitCommitSha: RUNTIME }, /malformed-runtime-identity/],
        [{ gitCommitSha: RUNTIME, loadPaths: 'x' }, /malformed-runtime-identity/],
        [{ gitCommitSha: RUNTIME, loadPaths: [{ gitCommitSha: RUNTIME }, ...loadPaths()] }, /malformed-runtime-identity/],
        [{ gitCommitSha: RUNTIME, loadPaths: [{ path: '', gitCommitSha: RUNTIME }, ...loadPaths()] }, /malformed-runtime-identity/],
      ];
      for (const [bad, slug] of cases) {
        expect(() => freezeReceipt({ ...base, runtime: bad as never }), JSON.stringify(bad)).toThrow(slug);
      }
    });

    it('records the load paths in the hashed payload, normalised to path + sha', () => {
      // Normalised because the payload is hashed: anything else the runtime file happens to carry
      // would otherwise ride into the hash, and two receipts over the same runtime would differ.
      const receipt = freezeReceipt({
        ...base,
        runtime: { gitCommitSha: RUNTIME, loadPaths: loadPaths().map((p) => ({ ...p, mtime: 'whenever' })) } as never,
      });
      expect(receipt.payload.runtime).toEqual({ gitCommitSha: RUNTIME, loadPaths: loadPaths() });
      expect(Object.keys(receipt.payload.runtime.loadPaths[0]!)).toEqual(['path', 'gitCommitSha']);
    });
  });

  /** The configuration hash has no counterparty. `prepare-gate` re-reads and re-hashes the five
   *  `inputs` as utf8 TEXT, so matching that decode is those hashes' contract; nothing re-derives
   *  the config hash, so decoding it first only throws distinctions away. */
  it('hashes the configuration BYTES, not a utf8 decode of them', () => {
    const a = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]);
    const b = Buffer.from([0x7b, 0x22, 0xfe, 0x22, 0x7d]);
    const hashOf = (bytes: Buffer) => freezeReceipt({ ...base, configBytes: bytes }).payload.config.sha256;
    expect(a.toString('utf8')).toBe(b.toString('utf8'));   // both invalid bytes decode to U+FFFD
    expect(hashOf(a)).not.toBe(hashOf(b));
    expect(hashOf(a)).toBe(createHash('sha256').update(a).digest('hex'));
  });

  it('records WHICH file was hashed, since a bare hash names nothing', () => {
    const receipt = freezeReceipt(base);
    expect(receipt.payload.config.path).toBe(base.configPath);
    // A declaration the program does NOT verify, and named so: §10 pins the redacted form, and
    // nothing here inspects the file for secrets.
    expect(receipt.payload.config.redactionAcknowledged).toBe(true);
  });

  /** A REGRESSION LOCK, not a driven behaviour — it held the moment the payload existed. It is
   *  here because both properties it pins are silent when broken: §10 keeps the candidate commit
   *  and the installed runtime as SEPARATE pins (a repository commit is not proof of what is
   *  installed, and this deployment has already produced a window where the two disagreed), and
   *  the key order is inside a hashed payload, so reordering it changes `payloadSha256` for every
   *  receipt ever issued while every field still reads correctly. */
  it('pins the two identities separately, in the payload key order that is hashed', () => {
    const receipt = freezeReceipt(base);
    expect(receipt.payload.candidateCommit).toBe('a'.repeat(40));
    expect(receipt.payload.runtime.gitCommitSha).toBe(RUNTIME);
    expect(Object.keys(receipt.payload)).toEqual([
      'rule', 'artifactKind', 'candidateCommit', 'runtime', 'config', 'k', 'txAfter', 'txClose',
      'windowDays', 'tools', 'methodDocs',
    ]);
    expect(receipt.artifact).toBe('freeze-receipt');
    expect(receipt.payload.artifactKind).toBe('freeze-receipt');
    expect(receipt.payload.rule).toBe(RULE);
    expect(receipt.payloadSha256).toBe(sha256Hex(JSON.stringify(receipt.payload)));
  });

  /** The METHOD half of §9's element 1, and nothing from the close. §9 orders the freeze receipt
   *  FIRST and the manifest / universe / classifier three steps later, so an input hash cannot be
   *  in here: none of those files exists yet at the freeze instant. */
  it('carries no close-time input pins, which do not exist when it is issued', () => {
    const receipt = freezeReceipt(base) as unknown as { payload: Record<string, unknown> };
    for (const absent of ['inputs', 'pins', 'pinsSha256', 'manifest', 'classifier', 'universe', 'snapshot']) {
      expect(Object.keys(receipt.payload), absent).not.toContain(absent);
    }
  });

  it('carries the method documents, which no other pin covers', () => {
    // `inputs.classifier` hashes what the classifier PRODUCED. The rule it applied could be
    // amended with every other pin still matching, which is exactly what §10 line 452 forecloses.
    expect(freezeReceipt(base).payload.methodDocs).toEqual(DOCS);
  });

  it('refuses a k that is not a positive integer', () => {
    for (const bad of [0, -20, 20.5, NaN]) {
      expect(() => freezeReceipt({ ...base, k: bad }), String(bad)).toThrow(/non-integer-k/);
    }
  });
});

describe('freezeReceipt — the working tree must BE the candidate commit for every pinned path', () => {
  /** The round-4 honesty finding: the receipt juxtaposes `candidateCommit` with tool hashes taken
   *  from the WORKING TREE, and nothing compared the two — this very repository froze HEAD while
   *  `run-pilot.ts` differed from HEAD and `freeze-receipt.ts` existed in no commit, at exit 0. A
   *  reader resolving the commit and running `git rev-parse <commit>:<path>` got a contradiction
   *  the artifact never warned about. A freeze that pins bytes no commit contains is not a freeze. */
  it('refuses a pinned tool whose working-tree bytes differ from the commit', () => {
    const rel = 'scripts/pilot/derive.ts';
    const divergent = freezeReceipt.bind(null, {
      ...base,
      pinnedBytesAtCommit: pinnedBytesAt({ [rel]: Buffer.from('different bytes in the commit\n') }),
    });
    expect(divergent).toThrow(/tree-commit-divergence/);
    expect(divergent).toThrow(new RegExp(rel.replace(/[./]/g, '\\$&')));
  });

  it('refuses a pinned method document ABSENT from the commit, naming it as absent', () => {
    const rel = 'docs/release/o67-class-rule-2026-07.md';
    const absent = freezeReceipt.bind(null, {
      ...base,
      pinnedBytesAtCommit: pinnedBytesAt({ [rel]: null }),
    });
    expect(absent).toThrow(/tree-commit-divergence/);
    expect(absent).toThrow(/ABSENT from the commit/);
  });

  it('asks the commit for EVERY pinned path — tools and method documents both', () => {
    const asked: string[][] = [];
    freezeReceipt({
      ...base,
      pinnedBytesAtCommit: (c, rels) => { asked.push(rels); return pinnedBytesAt()(c, rels); },
    });
    expect(asked).toHaveLength(1);
    expect([...asked[0]!].sort()).toEqual([...Object.keys(DOCS), ...Object.keys(TOOLS)].sort());
  });
});

describe('decimalInteger', () => {
  /** `Number()` is a coercion, not a parser, and the CLI used it. Every spelling below produced a
   *  well-formed, correctly-hashed receipt: the first four pinned K=20 under a spelling §10 does
   *  not use, and `1e-0` — one keystroke from `1e-01` — pinned K=1, a DIFFERENT method (§3 defines
   *  every metric against K) wearing a valid signature. */
  it('parses a plain positive decimal integer and refuses everything Number() would coerce', () => {
    expect(decimalInteger('--k', '20')).toBe(20);
    expect(decimalInteger('--k', '1')).toBe(1);
    for (const bad of ['2e1', '0x14', ' 20 ', '+20', '1e-0', '20.0', '020', '0', '-1', '', 'twenty', 'Infinity']) {
      expect(() => decimalInteger('--k', bad), JSON.stringify(bad)).toThrow(/non-integer-k/);
    }
  });
});
