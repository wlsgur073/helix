// Four audit findings — F10, D1, D4, D6 — were all "the shipped docs and the code disagree", and all
// four were closed by editing the docs. Nothing then held them: at the time this file was written NO
// test in the repository opened README.md or SECURITY.md at all. Five test files cite them, every one
// in a comment. So each of the four could silently revert and the suite would stay green.
//
// The rule this file follows, and the reason it is not just four string matches: every assertion
// RECOVERS its expected value from the code — by executing the shipped path, or by searching the
// shipped source — and only then requires the doc to state it. A guard that hardcodes the number it
// checks for cannot notice the code moving underneath the sentence, which is the exact failure the
// findings describe. Where a claim is irreducibly prose (a negative promise has no value to read out
// of code), the shortest load-bearing phrase is pinned rather than the whole sentence, so that
// rewording stays cheap and deleting the claim does not.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryStore } from '../../src/memory/store.js';
import { buildServer } from '../../src/server/helix-server.js';
import { classifyEgress, type EgressInput } from '../../src/risk/trifecta.js';
import { dualVerify } from '../../src/verify/dual-verify.js';
import { hardenHomePermissions } from '../../src/memory/home-permissions.js';
import { assessGradeLoss, strayTrustFiles } from '../../src/memory/trust-store-layout.js';
import { parseLedger } from '../../src/memory/ledger.js';
import { noopMetricsSink, type CompactionInput } from '../../src/metrics.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { appendAudit } from '../../src/audit.js';
import { staleBundles } from '../helpers/bundle-freshness.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const doc = (name: string): string => readFileSync(join(ROOT, name), 'utf8');

// 이 파일의 나머지 사례는 `src/`를 실행해 값을 회수한다. 그것이 사용자가 실행하는 배포 번들에
// 대한 증거가 되는 근거는 오직 `bin/`이 `src/`의 재빌드와 바이트 동일하다는 사슬이다. 사슬이
// 끊어지면 아래 사례들은 사용자가 실행하지 않는 코드에 대한 진술이 되므로, 그 사슬을 여기서
// 직접 측정한다. `test/plugin/packaging.test.ts`가 같은 헬퍼로 같은 사실을 확인하지만, 그 파일이
// 사라져도 이 파일이 스스로 자신의 전제를 증명해야 한다.
describe('the evidence chain that lets this file measure src/ and still speak for the bundle', () => {
  it('the shipped bundle is a byte-identical rebuild of the source these pins execute', () => {
    expect(
      staleBundles(),
      'bin/ is stale — every pin in this file is currently a claim about code users do not run',
    ).toEqual([]);
  }, 30_000);
});

describe('shipped docs state what the code actually does', () => {
  // ---- D2.c, D3.c, D6.c, F5.DOC -------------------------------------------------------------
  // Four more doc legs from the same rounds, each an INDEPENDENT writer from the case that already
  // covers its finding: D6 was asserted against SECURITY.md only, so the README sentences carrying
  // the same caps could be deleted with the suite green; D2 and D3 had no doc assertion at all; F5's
  // documentation half was never pinned anywhere. They follow this file's rule — recover the value
  // from the code first, and pin prose only where there is no value to recover.

  it('README quotes the same egress scan caps SECURITY.md does, recovered from the code (D6.c)', () => {
    const allow = { memoryEcho: 'allow', piiHigh: 'allow', piiBulk: 'allow', secretHeuristic: 'allow', secretEntropy: 'allow', secretEntropyExempt: 'allow' } as EgressInput['policy'];
    const huge = 'z'.repeat(20_000_000);
    const formVerdict = classifyEgress({ texts: [huge], outbound: huge, ledger: null, policy: allow });
    const formCap = Number(/\((\d+) chars\)/.exec(formVerdict.reason)![1]);
    const ledgerVerdict = classifyEgress({ texts: ['x'], outbound: 'x', ledger: [{ id: 'a', content: 'y'.repeat(20_000_000) }] as never, policy: allow });
    const ledgerCap = Number(/\((\d+) chars\)/.exec(ledgerVerdict.reason)![1]);

    // README writes them with thousands separators; the numbers still come from execution, so raising
    // either constant fails this until the prose is updated too.
    const readme = doc('README.md');
    expect(readme).toContain(`over ${formCap.toLocaleString('en-US')} characters`);
    expect(readme).toContain(`over ${ledgerCap.toLocaleString('en-US')} characters`);
    expect(readme).toContain('refused unscanned rather than sent');
  });

  it('both documents name the entropy exemption and the default the code actually ships (D2.c)', () => {
    const shipped = DEFAULT_CONFIG.dualVerify.egressPolicy.secretEntropyExempt;
    expect(shipped).toBe('allow');   // non-vacuity: if this flipped, the sentences below would be wrong

    const readme = doc('README.md');
    expect(readme).toContain('with one documented exemption on the egress side');
    expect(readme).toContain('secretEntropyExempt');

    const sec = doc('SECURITY.md');
    expect(sec).toContain('One documented exception to "blocked by default"');
    expect(sec).toContain(`\`secretEntropyExempt\` (default \`${shipped}\`)`);
  });

  it('both documents warn against allow-listing adopt, the tool the server actually registers (D3.c)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-docs-d3c-'));
    const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 's1' });
    const server = buildServer(store);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'doc-guard-d3c', version: '0' });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const { tools } = await client.listTools();

    // Recovered, not assumed: the warning is only owed while the tool is on the surface at all.
    const adopt = tools.find((t) => t.name === 'helix_memory_adopt');
    expect(adopt, 'helix_memory_adopt is no longer registered — the docs below would be stale').toBeDefined();
    expect(adopt!.description).toContain('do not allow-list this tool');

    expect(doc('README.md')).toContain('adopting a project ledger is a trust decision only you can make');
    expect(doc('README.md')).toContain('the only other tool that moves what Helix trusts');
    expect(doc('SECURITY.md')).toContain('do **not** allow-list `helix_memory_adopt`');
  }, 30_000);

  it('both documents disclose that the guard is not a sandbox around the CLI (F5.DOC)', () => {
    // Irreducibly prose: a negative promise about what a separate program can still reach has no
    // value to read out of the code, so this pins the shortest load-bearing phrase in each document
    // rather than the paragraph. Deleting the disclosure fails; rewording around it stays cheap.
    expect(doc('README.md')).toContain('What the CLI itself can still reach');
    expect(doc('SECURITY.md')).toContain('it is not a sandbox around the');
  });

  // ---- D6 ----------------------------------------------------------------------------------
  // The egress scan caps were implemented and documented nowhere. Both constants are module-private
  // in src/risk/trifecta.ts, so a test cannot import them — but the enforcement interpolates each one
  // into its own content-free reason string, which makes the value recoverable by EXECUTION. That is
  // what gives this test teeth: raise MAX_FORM_SCAN and the recovered number stops matching the
  // prose, so the guard fails until SECURITY.md is updated too.
  it('SECURITY.md quotes the egress scan caps the code actually enforces (D6)', () => {
    const allow = { memoryEcho: 'allow', piiHigh: 'allow', piiBulk: 'allow', secretHeuristic: 'allow', secretEntropy: 'allow', secretEntropyExempt: 'allow' } as EgressInput['policy'];

    // A payload far above any plausible cap, so the form leg decides and O(1) rejects it.
    const huge = 'z'.repeat(20_000_000);
    const formVerdict = classifyEgress({ texts: [huge], outbound: huge, ledger: null, policy: allow });
    expect(formVerdict.decidedBy).toBe('scan_limit');
    const formCap = Number(/\((\d+) chars\)/.exec(formVerdict.reason)![1]);

    // Same idea for the ledger leg: a small payload, an oversized aggregate ledger.
    const ledger = [{ id: 'm_1', content: 'y'.repeat(20_000_000) }];
    const ledgerVerdict = classifyEgress({ texts: ['q'], outbound: 'q', ledger, policy: allow });
    expect(ledgerVerdict.decidedBy).toBe('scan_limit');
    const ledgerCap = Number(/\((\d+) chars\)/.exec(ledgerVerdict.reason)![1]);

    expect(formCap).toBeGreaterThan(0);
    expect(ledgerCap).toBeGreaterThan(formCap);

    // The prose form is DERIVED from the recovered values, never typed in.
    const sec = doc('SECURITY.md');
    expect(sec).toContain(`${formCap.toLocaleString('en-US')} characters`);
    expect(sec).toContain(`${ledgerCap.toLocaleString('en-US')} characters`);
    // The direction and the decider matter as much as the numbers: a cap documented without
    // fail-closed semantics reads as a truncation, which is the opposite guarantee.
    expect(sec).toMatch(/fails closed/i);
    expect(sec).toContain("decidedBy: 'scan_limit'");
  });

  // ---- F10 ---------------------------------------------------------------------------------
  // README promised physical erasure in three places while the MCP tool only tombstones. The code
  // side is already well guarded (test/acceptance/bundle.e2e.test.ts drives a real client and asserts
  // both the schema and the plaintext's survival); what nothing held is that the docs keep saying so.
  // The schema key set is read from the running server, so adding a `permanent` knob fails this test
  // before anyone reaches the docs.
  it('the docs describe erase as soft-only, and the tool schema agrees (F10)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-docs-'));
    const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 's1' });
    const server = buildServer(store);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'doc-guard', version: '0' });
    await Promise.all([client.connect(ct), server.connect(st)]);

    const { tools } = await client.listTools();
    const erase = tools.find((t) => t.name === 'helix_memory_erase')!;
    const keys = Object.keys((erase.inputSchema as { properties: Record<string, unknown> }).properties).sort();
    expect(keys).toEqual(['id']); // no `permanent` — physical destruction is not on the tool surface

    // SECURITY.md names the schema shape explicitly; README carries the user-facing wording.
    const sec = doc('SECURITY.md');
    expect(sec).toContain(`\`helix_memory_erase\`'s schema is \`{${keys.join(', ')}}\` only`);

    // The README half used to be one loose alternation, /helix_memory_erase[^\n]*\*\*soft\*\*|soft
    // erase/. README satisfies that at TWO independent sentences ~19.5 kB apart, so reverting the
    // NORMATIVE one to the pre-fix physical-erasure claim left the assertion green — measured, not
    // supposed. An assertion a document can keep satisfying while saying the opposite thing is not a
    // guard. Each place the finding named is pinned separately instead, so rewording any ONE of them
    // fails here.
    // FOUR sites, not three. The intro paragraph is the one a first-time reader actually meets, and
    // the first version of this repair left it out — the pins covered the Quick-start parenthetical,
    // the tools-table row and the Right-to-erasure bullet, so reversing the intro alone kept every
    // assertion green. That is the same shape as the loose alternation it replaced, one paragraph
    // narrower.
    const readme = doc('README.md');
    expect(readme).toContain('reversible by default — physical destruction is a separate step');
    expect(readme).toContain('(a soft erase — it leaves every live view immediately, and stays reversible by default)');
    expect(readme).toContain('(soft: tombstoned and audited, recoverable until a compaction)');
    expect(readme).toContain('The `helix_memory_erase` tool is a **soft** erase: it appends a content-free tombstone');

    // A line-scoped negative would be wrong here: the Right-to-erasure bullet legitimately explains
    // that "Physical destruction — rewriting the ledger without the record — is the operator-run
    // `permanent` path", on the same line as the tool name. This excludes one specific phrasing —
    // the tool described as a physical erase — and no more; the four pins above are what actually
    // hold the guarantee. An earlier draft also asserted that "is a **soft** erase" appeared exactly
    // once, which was worse than useless: it forbade adding that wording to any OTHER site, i.e. it
    // stood in the way of closing the intro gap it was meant to help guard.
    expect(readme).not.toMatch(/`helix_memory_erase`[^\n.]*\bis a \*\*physical\*\*/);
  });

  // ---- D4 ----------------------------------------------------------------------------------
  // stakesFloor was documented as an unconditional gate, and a follow-up (S2) found that under the
  // SHIPPED default the bypass is the ordinary path rather than an edge case. The code leg runs the
  // real gate at the real default floor and counts metered invocations — `ran === true` alone would
  // not distinguish "the floor was skipped" from "the floor let it through".
  it('README discloses that omitting `stakes` bypasses stakesFloor, which it does (D4)', async () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.dualVerify.enabled = true;                       // flip ONLY this; keep the shipped floor
    const floor = cfg.dualVerify.stakesFloor;
    expect(floor).not.toBe('low');                       // else there is no below-floor value to contrast

    let metered = 0;
    const deps = {
      config: cfg,
      runner: async () => { metered += 1; return { ok: true as const, answer: 'the answer is 4' }; },
      checkAvailable: async () => ({ available: true }),
      echo: { mode: 'disabled' as const },
    };

    const declared = await dualVerify({ question: 'q', helixAnswer: 'a', stakes: 'low' }, deps);
    expect(declared.attempted).toBe(false);              // the floor DOES gate a declared low call
    expect(metered).toBe(0);

    const omitted = await dualVerify({ question: 'q', helixAnswer: 'a' }, deps);
    expect(omitted.attempted).toBe(true);                // omitting the argument spends quota anyway
    expect(metered).toBe(1);

    // The two shortest phrases that carry the claim. Pinned deliberately narrow: a rewrite is allowed
    // to fail this and be re-pinned, but a DELETION of the disclosure must not pass.
    const readme = doc('README.md').replace(/\s+/g, ' ');
    expect(readme).toContain('gates only calls that');
    expect(readme).toContain('bypasses the floor');
  });

  // ---- D1 ----------------------------------------------------------------------------------
  // README claimed `.helix/` "is gitignored" as a privacy default that no shipped code implements.
  // The corrected sentence makes it an instruction to the reader plus an explicit promise not to act.
  // A negative promise has no value to read out of code, so the code leg is an exhaustive search of
  // the shipped surface: the moment anything starts touching a .gitignore, this fails.
  it('no shipped code touches a .gitignore, which is what README promises (D1)', () => {
    const NEEDLE = 'git' + 'ignore'; // split so this file's own source cannot satisfy the search
    let hits = '';
    try {
      hits = execFileSync('git',
        ['-C', ROOT, 'grep', '-il', NEEDLE, '--', 'src', 'bin', 'hooks', 'scripts', '.claude-plugin', 'build.mjs'],
        { encoding: 'utf8' });
    } catch (e) {
      const r = e as { status?: number; stdout?: string };
      if (r.status === 1) hits = r.stdout ?? ''; // git grep exits 1 when nothing matches
      else throw e;
    }
    expect(hits.split('\n').filter(Boolean)).toEqual([]);

    const readme = doc('README.md').replace(/\s+/g, ' ');
    expect(readme).toContain('never edits your');
    expect(readme).toContain(`.helix/\` to your repo's \`.${NEEDLE}\``);
  });
});

// The non-Linux pid-reuse limitation lived only in a source comment, which is why it did not count as
// an accepted limitation: a user cannot read it. Now that SECURITY.md states it, this binds the
// sentence to the behaviour, so the disclosure cannot outlive the constraint or disappear before it.
describe('SECURITY.md states the lock-liveness limitation the code actually has', () => {
  it('the doc names the /proc dependency, and the classifier still behaves that way', async () => {
    const { classifyHolder, selfIdentity, realProbe } = await import('../../src/memory/lock-liveness.js');
    const foreign = { platform: 'darwin', bootId: null, pidNs: null };
    const base = { ...selfIdentity('a'.repeat(32)), ...foreign };
    const probe = { ...realProbe, kill0: () => 'alive' as const, startTicksOf: () => null, stateOf: () => null };

    // No recorded start time: unreclaimable, exactly as the doc says.
    expect(classifyHolder({ ...base, token: 'b'.repeat(32), pid: 4242, startTicks: null }, base, probe))
      .toBe('alive-unknown');
    // With one, the SAME rule reclaims — so the doc's "only the measurement is Linux-specific" is true.
    expect(classifyHolder({ ...base, token: 'b'.repeat(32), pid: 4242, startTicks: '900000' }, base,
      { ...probe, startTicksOf: () => '900123' })).toBe('dead');

    const sec = doc('SECURITY.md');
    expect(sec).toMatch(/\/proc/);
    expect(sec).toMatch(/alive-unknown/);
    expect(sec).toMatch(/age is deliberately not used/i);
  });
});

// D5.b — the at-rest section listed `~/.helix/audit.jsonl` as content-free and said nothing about its
// mode, directly above a `codex-log.jsonl` bullet that states `0o600`. The round read that adjacency
// as a guarantee the audit trail did not have, and it was right to: nothing in the document claimed
// one. The code has since been fixed — appendAudit opens with an explicit mode — so the adjacency
// reading became accidentally true, which is worse than false. A reader still cannot tell whether the
// mode is promised or inferred, and nothing fails if the appender drops it.
//
// The assertion is scoped to the audit bullet ON PURPOSE. `toContain('is created `0o600`')` against
// the whole document passes today on the codex-log sentence alone — a doc guard satisfied by an
// unrelated line is the same defect this file was written to repair, and it would be a particularly
// poor way to close a finding whose subject IS reading one bullet as covering its neighbour.
describe('SECURITY.md states the mode the audit trail is actually created with (D5.b)', () => {
  // The bullet line plus its indented continuation lines, whitespace-collapsed. Two deliberate
  // choices: an earlier draft ended the match at `$`, which under /m matches every line end and so
  // silently returned only the first line — a scoped guard that quietly stops being scoped is worse
  // than an unscoped one. And collapsing whitespace binds the assertions to the SENTENCE rather than
  // to where the paragraph happens to wrap, so reflowing the document stays free.
  const auditBullet = (sec: string): string =>
    (/^- `~\/\.helix\/audit\.jsonl`.*(?:\n {2,}.*)*/m.exec(sec)?.[0] ?? '').replace(/\s+/g, ' ');

  it('the mode is recovered from the appender, observed on disk, and stated in the document', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'helix-d5b-')), '.helix', 'audit.jsonl');
    appendAudit(path, { kind: 'adopt', ts: '2026-06-09T00:00:00.000Z', scope: '/x' });

    // Recovered by SEARCHING THE SHIPPED SOURCE, never hardcoded: change the literal in src/audit.ts
    // and this test starts demanding the new number from SECURITY.md instead of silently agreeing.
    const declared = /openSync\(path, 'a', (0o\d+)\)/.exec(readFileSync(join(ROOT, 'src', 'audit.ts'), 'utf8'))?.[1];
    expect(declared, 'src/audit.ts no longer opens the audit trail with an explicit mode').toBeDefined();

    // The promise is kept on this filesystem — the recovered literal is what the file actually gets.
    expect(`0o${(statSync(path).mode & 0o777).toString(8)}`).toBe(declared);

    const bullet = auditBullet(doc('SECURITY.md'));
    expect(bullet, 'the at-rest section no longer has an audit.jsonl bullet to bind').not.toBe('');
    expect(bullet).toContain(`created \`${declared}\``);
  });

  it('the document limits the appender\'s guarantee to creation, which is all open(2) gives it', () => {
    // Irreducibly prose: a mode passed to openSync applies when the call CREATES the file and never
    // afterwards. Stating the guarantee without that limit would repeat the finding with the sign
    // flipped — a document promising more than the appender delivers, instead of less.
    //
    // This is a PHRASE match, and the case below exists because a phrase match is not enough: it is
    // satisfied by a sentence that goes on to draw a false conclusion from the true premise.
    expect(auditBullet(doc('SECURITY.md'))).toMatch(/at creation/i);
  });

  it('a pre-existing over-broad trail IS repaired at startup, and the document says so', () => {
    // Why this case exists. The bullet used to continue "...so a trail that already exists keeps
    // whatever mode it has", which is false of the shipped system: hardenHomePermissions runs
    // unconditionally at startup, audit.jsonl is in its OWNED_FILES, and a 0644 trail comes back
    // 0600 with the server saying so on stderr. Observed on a real ~/.helix across a restart, then
    // reproduced in a temp home. The clause survived review because the only guard on it was the
    // phrase match above — while test/memory/home-permissions.test.ts had been asserting the
    // OPPOSITE behavior all along. Two suites, contradictory readings of one file, both green.
    //
    // So this case does not ask what the sentence says about repair; it DRIVES the repair first and
    // then requires the document to describe what was just observed. A doc claim about runtime
    // behavior needs a test that runs the behavior — a guard that only reads prose can only ever
    // confirm that the prose is still the prose.
    const home = mkdtempSync(join(tmpdir(), 'helix-d5b-harden-'));
    const trail = join(home, 'audit.jsonl');
    writeFileSync(trail, '{"kind":"adopt","ts":"2026-06-09T00:00:00.000Z","scope":"/x"}\n');
    chmodSync(trail, 0o644);

    const warnings: string[] = [];
    hardenHomePermissions(home, { warn: (m) => warnings.push(m) });

    expect(`0o${(statSync(trail).mode & 0o777).toString(8)}`,
      'the startup pass no longer repairs a pre-existing audit trail — the document below is now the accurate one, so fix this test, not the prose').toBe('0o600');
    expect(warnings.join('\n'), 'the repair happened silently; the document promises it is announced').toContain(trail);

    const bullet = auditBullet(doc('SECURITY.md'));
    expect(bullet, 'the bullet still tells the reader a pre-existing trail keeps its mode').not.toMatch(/keeps whatever mode/i);
    expect(bullet, 'the bullet does not mention that the next start repairs the mode').toMatch(/start/i);
  });
});

// The split-trust-store refusal. Both documents state it UNCONDITIONALLY — "The server refuses to
// start if it finds trust-store files beside a relocated ledger" — but src/server/index.ts gates it on
// assessGradeLoss(...).loses, and its comment block says why in detail: two earlier unconditional
// proxies were themselves a startup denial of service, where one shape-valid planted witness.json
// killed every session at exit 78 on an install with nothing at risk. So the CODE is the fixed
// version and the prose is pre-fix. Driven 2026-08-18 on exactly the pre-pin layout the README
// sentence is about — genuine key + witness beside a relocated ledger, fresh HELIX_HOME — the server
// starts, and mints its own second key, whenever the ledger carries no elevated grade.
//
// Following this file's rule, the two outcomes are RECOVERED by executing the shipped gate rather
// than asserted from the prose, and only then is each document required to describe both.
describe('the documents describe the split-trust-store refusal as the code actually gates it', () => {
  /** The pre-pin layout, built by the shipped store: trust files beside the ledger, a fresh HOME. */
  function prePinLayout(elevate: boolean): { home: string; ledger: string } {
    const dir = mkdtempSync(join(tmpdir(), 'helix-stray-doc-'));
    const oldHome = join(dir, 'oldhome');
    const repo = join(dir, 'repo');
    mkdirSync(oldHome, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const ledger = join(repo, 'memory.jsonl');

    const store = new MemoryStore(ledger, { home: oldHome, sessionId: 's1' });
    const r = store.commit({ content: 'A fact for the stray-trust-store guard.', source: 'user' });
    if (elevate) store.confirm(r.id);                       // the only thing that puts a grade in play

    // What an older build produced: the trust store sits next to the ledger, HELIX_HOME is fresh.
    for (const f of readdirSync(oldHome)) if (f !== 'memory.jsonl') cpSync(join(oldHome, f), join(repo, f));
    const home = join(dir, 'newhome');
    mkdirSync(home, { recursive: true });
    return { home, ledger };
  }

  /** The sentence in `text` that carries the refusal claim, whitespace-collapsed so a reflow is free. */
  const refusalSentence = (text: string): string =>
    (/[^.]*refuses to start[^.]*\./.exec(text.replace(/\s+/g, ' '))?.[0] ?? '').trim();

  it('the gate is per measured grade loss, not per layout — both outcomes recovered by execution', () => {
    const lossless = prePinLayout(false);
    const losing = prePinLayout(true);

    // Non-vacuity: the layout must actually BE the one the documents describe in both runs, or the
    // assertions below would pass on a state where no stray file was ever found.
    expect(strayTrustFiles(lossless.home, lossless.ledger).length,
      'the lossless fixture no longer reproduces the pre-pin layout').toBeGreaterThan(0);
    expect(strayTrustFiles(losing.home, losing.ledger).length,
      'the elevated fixture no longer reproduces the pre-pin layout').toBeGreaterThan(0);

    // The same layout, two answers. This is the whole point: the layout does not decide.
    expect(assessGradeLoss(lossless.home, lossless.ledger).loses,
      'a ledger with nothing elevated now refuses — the unconditional prose would be accurate again').toBe(false);
    expect(assessGradeLoss(losing.home, losing.ledger).loses,
      'a ledger that stands to lose a grade no longer refuses').toBe(true);
  });

  it('each document states the condition, not just the refusal', () => {
    for (const name of ['README.md', 'SECURITY.md']) {
      const sentence = refusalSentence(doc(name));
      expect(sentence, `${name} no longer has a refusal sentence to bind`).not.toBe('');
      // "only" is the quantifier the shipped gate needs and the pre-fix prose lacked: without it the
      // sentence reads as a property of the LAYOUT, which is the reading that is false.
      expect(sentence, `${name} states the refusal unconditionally`).toMatch(/only/i);
      expect(sentence, `${name} does not say what the refusal is conditioned ON`).toMatch(/grade/i);
    }
  });

  it('each document also says what happens in the case that does NOT refuse', () => {
    // The half a reader needs most: they will meet the note, not the refusal, on any install whose
    // ledger never got a grade. A document that mentions only the refusal leaves that unexplained.
    //
    // SCOPED to the paragraph that carries the refusal, deliberately. An earlier draft asserted
    // /note/i against the whole README, which already passed on an unrelated sentence elsewhere in
    // the file — a guard satisfied by a line that has nothing to do with the claim, which is the
    // defect this whole file exists to repair.
    for (const name of ['README.md', 'SECURITY.md']) {
      // Collapse BEFORE searching, not after: prose wraps, so the phrase being looked for is split
      // across a newline in the file as often as not. Matching the raw paragraph made this report
      // "no refusal paragraph to bind" against a document that plainly had one.
      const para = doc(name).split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' '))
        .find((p) => p.includes('refuses to start')) ?? '';
      expect(para, `${name} no longer has a refusal paragraph to bind`).not.toBe('');
      expect(para, `${name}'s refusal paragraph never says what the other outcome is`).toMatch(/note/i);
    }
  });
});

// Compaction is the one destructive subsystem a user opts into, and two of README's statements about
// it do not survive being driven. Both are the same shape as the other doc findings this file now
// carries: the CODE is right and the prose rounds it off.
//
//   1. "Fire when reclaimable rows / total rows reaches this" reads as a count of dead rows. The
//      estimate is NET of the markers the rewrite itself mints — store.ts nets out the epoch fence
//      deliberately (counting it would make a witnessed compaction re-fire forever on the fence
//      alone), and the horizon marker lands in `kept` without a counterpart in the input on a
//      never-compacted ledger. So exactly one dead row nets to zero, and no ratio in the legal range
//      can fire it. That is truthful — the rewrite really would reclaim nothing; measured, the file
//      NET-GREW from 6 rows to 7 — but it is not what the sentence describes.
//   2. `CompactionStats.droppedRows` is documented "Always >= 0 in practice", and README extends its
//      negativity note only to `reclaimed_bytes`. Driven at minDirtyBytes:1 with one dead row, the
//      shipped code emits droppedRows: -1.
describe('the documents describe compaction as the shipped gate and stats actually behave', () => {
  const FUTURE = '2100-01-01T00:00:00.000Z';   // any real mtime is "old", so quiescence is deterministic
  const BASE = { auto: true, dirtyRatio: 0.01, minRows: 0, graceMs: 0, maxBytes: 52_428_800 };

  /** Commit `facts`, soft-erase `dead` of them, then recall — the trigger. */
  function drive(minDirtyBytes: number, facts: number, dead: number) {
    const home = mkdtempSync(join(tmpdir(), 'helix-doc-compact-'));
    const ledger = join(home, 'memory.jsonl');
    const emitted: CompactionInput[] = [];
    const store = new MemoryStore(ledger, {
      home, sessionId: 't', now: () => FUTURE,
      compaction: { ...BASE, minDirtyBytes },
      metricsSink: { ...noopMetricsSink, emitCompaction: (c) => { emitted.push(c); } },
    });
    const ids: string[] = [];
    for (let i = 0; i < facts; i++) ids.push(store.commit({ content: `fact ${i} for the compaction doc guard`, source: 'user' }).id);
    for (let i = 0; i < dead; i++) store.erase(ids[i]!);
    const rowsBefore = parseLedger(ledger).length;
    store.recall('fact compaction doc guard');
    return { emitted, rowsBefore, rowsAfter: parseLedger(ledger).length };
  }

  it('the ratio gate cannot fire on exactly one dead row — recovered by execution', () => {
    const CLOSED = 999_999_999;   // shuts the absolute-bytes branch so only the ratio can decide

    expect(drive(CLOSED, 5, 1).emitted,
      'one dead row now reaches the ratio gate — README\'s plain reading became accurate again').toHaveLength(0);
    // Non-vacuity: the fixture must be capable of firing at all, or the assertion above proves nothing.
    expect(drive(CLOSED, 5, 2).emitted,
      'two dead rows no longer fire either — the fixture stopped exercising the gate').toHaveLength(1);
  });

  it('droppedRows is legitimately negative, and the ledger can net-grow', () => {
    const r = drive(1, 5, 1);     // absolute branch open, so the same one-dead-row ledger DOES compact
    expect(r.emitted, 'the absolute-bytes branch no longer fires on this fixture').toHaveLength(1);
    expect(r.emitted[0]!.droppedRows, 'droppedRows is no longer negative here').toBeLessThan(0);
    expect(r.rowsAfter, 'the rewrite no longer net-grows the ledger').toBeGreaterThan(r.rowsBefore);
  });

  it('README says what the ratio is measured against, not just the plain quotient', () => {
    const bullet = (/^- `dirtyRatio`.*(?:\n {2,}.*)*/m.exec(doc('README.md'))?.[0] ?? '').replace(/\s+/g, ' ');
    expect(bullet, 'README no longer has a dirtyRatio bullet to bind').not.toBe('');
    expect(bullet, 'the bullet still reads as a plain count of dead rows').toMatch(/net|marker/i);
  });

  it('both the shipped contract and README admit droppedRows can be negative', () => {
    // Recovered from the source, this file's rule: the comment is the contract a caller reads.
    expect(readFileSync(join(ROOT, 'src', 'memory', 'ledger.ts'), 'utf8'),
      'the droppedRows contract still promises it is always >= 0').not.toContain('Always >= 0 in practice');
    const obs = doc('README.md').replace(/\s+/g, ' ');
    expect(obs, 'README extends the negativity note to reclaimed_bytes only')
      .toMatch(/`dropped_rows`[^.]*negative|negative[^.]*`dropped_rows`/i);
  });
});

// The proof-of-read guard on superseding a Verified fact is a security control that appears in NO
// shipped document: `supersedesDigest` occurs nowhere in README.md or SECURITY.md. Its entire
// rationale — including the residual its own author insisted on stating rather than hiding — lives in
// a comment in src/memory/store.ts. A user cannot act on a control they cannot read about, and the
// residual is the half that decides whether they should rely on it.
describe('SECURITY.md documents the proof-of-read guard on superseding a verified fact', () => {
  it('the guard is real, and the read path dispenses the token — both recovered by driving them', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-doc-supersede-'));
    const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 't' });
    const target = store.commit({ content: 'A fact the user vouched for.', source: 'user' });
    store.confirm(target.id);

    // Blind: a caller that never read the target cannot displace it, even claiming source=user —
    // which is the cheap credential the tier below this one was protected by.
    expect(() => store.commit({ content: 'A blind replacement.', source: 'user', supersedes: target.id }))
      .toThrow(/supersedesDigest/);

    // And the cost the guard actually imposes on an honest caller is exactly one extra read.
    const digest = store.inspect().find((r) => r.record.id === target.id)?.contentDigest;
    expect(digest, 'the read path no longer dispenses contentDigest — the remedy the error names is gone').toBeDefined();
    expect(() => store.commit({
      content: 'An informed replacement.', source: 'user', supersedes: target.id, supersedesDigest: digest,
    })).not.toThrow();
  });

  it('SECURITY.md states the guard, what it is not, and the residual', () => {
    const sec = doc('SECURITY.md');
    expect(sec, 'the guard is still absent from the security document').toContain('supersedesDigest');
    expect(sec, 'the document does not say what the guard proves').toMatch(/proof of read/i);
    // The two honesty clauses the code comment insists on, so the prose cannot promise more than the
    // code delivers — the failure mode every other finding in this file has taken.
    expect(sec, 'the document does not say this is not an authorization check').toMatch(/not an authorization/i);
    expect(sec, 'the document does not disclose the guess-the-content residual').toMatch(/guess/i);
  });
});

// 배포된 CHANGELOG가 런타임이 실제로 등록하는 도구 수를 적는지. 이 저장소는 그 수를 사람이
// 눈으로 세어 적었고 실제와 어긋난 채로 배포되었다. 그래서 이 사례는 문서의 숫자를 읽어
// 확인하지 않고, 등록부를 구동하여 얻은 수로부터 문서가 무엇을 적어야 하는지를 도출한다.
describe('the shipped changelog states the tool count the runtime actually registers', () => {
  it('the spelled-out number in CHANGELOG matches the registry, recovered by execution', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-doc-count-'));
    const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 't' });
    const server = buildServer(store);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'doc-guard-count', version: '0' });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const { tools } = await client.listTools();
    await client.close();

    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    const word = words[tools.length];
    // 등록 도구가 이 표를 넘어서면 문서가 무엇을 적어야 하는지 도출할 수 없다. 조용히
    // 지나가면 그 순간부터 이 사례는 아무것도 확인하지 않으므로 여기서 멈춘다.
    if (word === undefined) throw new Error(`no spelled-out word for ${tools.length} registered tools`);

    const changelog = doc('CHANGELOG.md');
    expect(changelog, `CHANGELOG does not say "${word} MCP tools" — the registry has ${tools.length}`)
      .toMatch(new RegExp(`${word} MCP tools`, 'i'));

    // 다른 수를 동시에 주장하지 않는지. 한쪽만 정정되어 두 수가 공존하는 경우를 막는다.
    for (const [i, other] of words.entries()) {
      if (i === tools.length) continue;
      expect(changelog, `CHANGELOG still claims "${other} MCP tools"`)
        .not.toMatch(new RegExp(`${other} MCP tools`, 'i'));
    }
  }, 30_000);
});
