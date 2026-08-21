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
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, readdirSync, statSync, chmodSync, existsSync } from 'node:fs';
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
import { parseLedger, isIntegrityMarker, isHorizonMarker, compactLedger } from '../../src/memory/ledger.js';
import { noopMetricsSink, type CompactionInput } from '../../src/metrics.js';
import { DEFAULT_CONFIG, compactionConfigFromGlobal } from '../../src/config.js';
import { appendAudit } from '../../src/audit.js';
import { staleBundles } from '../helpers/bundle-freshness.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const doc = (name: string): string => readFileSync(join(ROOT, name), 'utf8');

// Every other case in this file obtains its values by running `src/`. The only thing that makes
// those values evidence about the shipped bundle the user runs is the chain that `bin/` is byte
// identical to a rebuild of `src/`. Break the chain and the cases below become statements about
// code nobody executes, so the chain is measured here directly. `test/plugin/packaging.test.ts`
// checks the same fact through the same helper, but this file must prove its own premise even if
// that file disappears.
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
  // SHIPPED default the bypass was the ordinary path rather than an edge case. From 07-28 to 08-20 that
  // was resolved by DISCLOSING it (README + CHANGELOG) rather than closing it. DV-STAKES-OMIT reopened
  // it as a design decision and it is now CLOSED in code: an omitted `stakes` reads as the lowest tier,
  // so the floor refuses it. Both legs still matter — `ran === false` alone would not distinguish "the
  // floor refused it" from "a later gate did", and only the counter proves no quota was spent.
  it('README states that an omitted `stakes` is refused by stakesFloor, which it is (D4)', async () => {
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
    expect(omitted.attempted).toBe(false);               // omission is not an exemption
    expect(metered).toBe(0);                             // the silent path spends no quota either

    // The two shortest phrases that carry the claim. Pinned deliberately narrow: a rewrite is allowed
    // to fail this and be re-pinned, but a DELETION of the disclosure must not pass.
    const readme = doc('README.md').replace(/\s+/g, ' ');
    expect(readme).toContain('read as the lowest tier');
    expect(readme).toContain('omission is not an exemption');
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

// Does the shipped CHANGELOG state the number of tools the runtime actually registers? This
// repository once counted them by eye and shipped a number that disagreed with reality. So this
// case does not read the document's figure and check it: it drives the registry, and derives from
// the resulting count what the document has to say.
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
    // If the registered tools outgrow this table there is no way to derive what the document must
    // say. Passing quietly would mean this case establishes nothing from that moment on, so it
    // stops here instead.
    if (word === undefined) throw new Error(`no spelled-out word for ${tools.length} registered tools`);

    const changelog = doc('CHANGELOG.md');
    expect(changelog, `CHANGELOG does not say "${word} MCP tools" — the registry has ${tools.length}`)
      .toMatch(new RegExp(`${word} MCP tools`, 'i'));

    // And that it does not assert a different number at the same time — one correction landing
    // alone would leave two counts side by side.
    for (const [i, other] of words.entries()) {
      if (i === tools.length) continue;
      expect(changelog, `CHANGELOG still claims "${other} MCP tools"`)
        .not.toMatch(new RegExp(`${other} MCP tools`, 'i'));
    }
  }, 30_000);
});

// Does every shipped CLI invocation the README prints actually run? This repository shipped a CLI
// that requires arguments while showing it with none. So this case does not judge by reading the
// document's command: it runs the CLI, recovers the arguments it demands, and then checks that the
// document carries them.
describe('every shipped CLI invocation README prints can actually run', () => {
  it('the trigger invocation carries the arguments the CLI requires, recovered by executing it', () => {
    // The child gets a minimal environment, so a `HELIX_*` the developer exported cannot reach it
    // and node's own diagnostics cannot mix into the usage string.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k, v]) => v !== undefined && !k.startsWith('HELIX_') && k !== 'NODE_OPTIONS' && k !== 'NODE_DEBUG',
      ),
    ) as NodeJS.ProcessEnv;
    const bare = spawnSync(process.execPath, [join(ROOT, 'bin', 'helix-trigger.mjs')], { encoding: 'utf8', env, timeout: 10_000 });
    expect(bare.status, 'the trigger CLI no longer refuses a bare invocation').toBe(2);

    // The required flags are recovered from the run's own output, never copied from the document.
    // Anything wrapped in `[...]` is optional and is stripped first; otherwise the optional
    // arguments would be recovered as required, and the README would have to print those too to
    // pass — a test demanding a wrong document.
    const usage = `${bare.stdout}${bare.stderr}`.replace(/\[[^\]]*\]/g, '');
    const required = [...usage.matchAll(/--([a-z-]+) </g)]
      .map((m) => m[1])
      .filter((f): f is string => f !== undefined);
    expect(required.length, 'the usage line names no required flag — the recovery is broken').toBeGreaterThan(0);

    const line = doc('README.md').split('\n').find((l) => l.includes('bin/helix-trigger.mjs'));
    expect(line, 'README no longer mentions the trigger CLI').toBeDefined();
    for (const flag of required) {
      expect(line!, `README's trigger invocation omits the required --${flag}`).toContain(`--${flag}`);
    }
  }, 30_000);
});

// Does the README actually state the name and default of every egress leg it calls configurable?
// The document described the legs behaviourally and said "per-leg overridable" while naming exactly
// one key, so a user wanting to close the rest could not learn the key names. This case recovers
// both the names and the defaults from the code.
describe('README documents every egress leg the config actually accepts', () => {
  it('names each leg and its shipped default, recovered from DEFAULT_CONFIG', () => {
    const legs = Object.entries(DEFAULT_CONFIG.dualVerify.egressPolicy);
    expect(legs.length, 'no egress leg was recovered — the config shape changed').toBeGreaterThan(1);

    const readme = doc('README.md');
    expect(readme, 'README never names the `egressPolicy` key itself').toContain('`egressPolicy`');

    for (const [leg, shipped] of legs) {
      // It has to be a table row. If a name merely brushing past in prose were enough, the user
      // would still be left unable to learn the value.
      // The table is nested inside a bullet and so carries leading whitespace, which is trimmed
      // before matching: the indentation is an artefact of markdown nesting, not meaning.
      const row = readme.split('\n').map((l) => l.trim()).find((l) => l.startsWith('| `' + leg + '`'));
      if (row === undefined) throw new Error(`README has no table row for the egress leg \`${leg}\``);
      expect(row, `README's row for \`${leg}\` does not state its shipped default \`${shipped}\``)
        .toContain('`' + shipped + '`');
    }
  });
});

// Does the README's backup section name the audit log file? That section originally listed six
// files and omitted `audit.jsonl`, while the README promises elsewhere that an erase stays auditable
// and the recovery procedure depends on that log. The filename is not copied from prose: an audit
// record is actually written and the name recovered from it.
describe('README names the audit trail its erasure promise depends on', () => {
  it('the file the audit appender actually creates is named in the backup section', () => {
    // The name is recovered where the server composes it, not copied from the document.
    const wiring = readFileSync(join(ROOT, 'src/server/helix-server.ts'), 'utf8');
    const derived = /auditPath:\s*join\(home,\s*'([^']+)'\)/.exec(wiring)?.[1];
    if (derived === undefined) {
      throw new Error('the audit filename is no longer derived as join(home, ...) in helix-server.ts');
    }

    // That the recovered name is real is confirmed by running: a string in the source says nothing
    // about whether a file by that name is ever created.
    const home = mkdtempSync(join(tmpdir(), 'helix-doc-audit-'));
    appendAudit(join(home, derived), { kind: 'erase', ts: '2026-01-01T00:00:00.000Z', id: 'm_1', soft: true });
    expect(readdirSync(home), `the appender did not create ${derived}`).toContain(derived);

    const backupParagraph = doc('README.md').split('\n').find((l) => l.includes('**What to back up.**'));
    if (backupParagraph === undefined) throw new Error('README has no "What to back up" paragraph');
    expect(backupParagraph, `the backup section does not name \`${derived}\``).toContain('`' + derived + '`');
  });
});

// Is every environment variable the shipped bundles read named in the README? A variable the user
// can set that changes behaviour, absent from the docs, looks as though it does not exist while
// working all the same. The names are recovered from the shipped bundles, not copied from the
// document.
describe('README names every environment variable the shipped bundles read', () => {
  it('each HELIX_ variable recovered from bin/ appears in README', () => {
    const bundles = ['bin/helix-mcp.mjs', 'bin/helix-trigger.mjs', 'bin/helix-rebaseline.mjs', 'bin/hooks/session-start.mjs', 'bin/hooks/session-end.mjs'];
    const found = new Set<string>();
    for (const b of bundles) {
      for (const m of readFileSync(join(ROOT, b), 'utf8').matchAll(/process\.env\.(HELIX_[A-Z0-9_]*)/g)) {
        const name = m[1];
        if (name !== undefined) found.add(name);
      }
    }
    expect(found.size, 'no HELIX_ variable was recovered — the scan is broken').toBeGreaterThan(1);

    const readme = doc('README.md');
    for (const name of [...found].sort()) {
      // Matched on a word boundary. `HELIX_SESSION` is a prefix of `HELIX_SESSIONS`, so a
      // substring check would pass the former on the strength of documenting only the latter.
      expect(readme, `${name} is read by a shipped bundle but appears nowhere in README`)
        .toMatch(new RegExp(name + '\\b'));
    }
  });

  it('README discloses that the user API key is forwarded to the Codex child', () => {
    // Codex's variable rather than a Helix control, but dual-verify forwards it to the child, and
    // the section describing what leaves the machine has to say so. Whether it is really on the
    // allowlist is recovered from the source.
    const codex = readFileSync(join(ROOT, 'src/verify/codex.ts'), 'utf8');
    const allowlist = /CHILD_ENV_ALLOWLIST[^=]*=\s*\[([\s\S]*?)\]/.exec(codex)?.[1];
    if (allowlist === undefined) throw new Error('CHILD_ENV_ALLOWLIST is no longer an array literal in codex.ts');
    expect(allowlist, 'the API key is no longer forwarded — this disclosure would be stale')
      .toContain('OPENAI_API_KEY');

    expect(doc('README.md'), 'README does not name OPENAI_API_KEY among what reaches the Codex child')
      .toContain('OPENAI_API_KEY');
  });
});

// Does the tool really enforce the mutual exclusion the recovery playbook describes? The refusal is
// recovered by running rather than copied from the document's wording, and each argument alone must
// be shown NOT to be refused — otherwise the assertion would pass over a tool that refuses every
// call.
describe('the recovery playbook states the exclusion the inspect tool actually enforces', () => {
  it('history+asOf is refused while each alone is served, recovered by execution', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-doc-excl-'));
    const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 't' });
    store.commit({ content: 'a fact for the exclusion probe', source: 'user' });
    const server = buildServer(store);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'doc-guard-excl', version: '0' });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const say = async (args: Record<string, unknown>): Promise<string> => {
      const r = await client.callTool({ name: 'helix_memory_inspect', arguments: args });
      return ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('');
    };
    const TS = '2026-01-01T00:00:00.000Z';

    const both = await say({ history: true, asOf: TS });
    const onlyHistory = await say({ history: true });
    const onlyAsOf = await say({ asOf: TS });
    await client.close();

    // Non-vacuity: neither argument alone may be refused, or the assertion below would pass over an
    // implementation that refuses anything.
    expect(onlyHistory, 'history alone is refused — the refusal is not about the combination')
      .not.toMatch(/mutually exclusive/i);
    expect(onlyAsOf, 'asOf alone is refused — the refusal is not about the combination')
      .not.toMatch(/mutually exclusive/i);

    expect(both, 'inspect no longer refuses history+asOf — the playbook line would be stale')
      .toMatch(/mutually exclusive/i);

    expect(
      doc('docs/release/recovery-playbook.md'),
      'the playbook no longer states the exclusion the tool enforces',
    ).toContain('`history` and `asOf` are mutually exclusive');
  }, 30_000);
});

// SECURITY.md claims unforgeability at the file surface. The claim is recovered by running:
// appending raw JSON to the ledger to assert an elevated grade clamps to `Fresh`, and a verify with
// no MAC is ignored. Non-vacuity comes from an honestly promoted fact staying `Verified` in the same
// run — otherwise the assertion would pass over an implementation that makes every item `Fresh`.
describe('SECURITY.md states the forgery resistance the ledger actually has', () => {
  it('a hand-appended elevated assert is clamped while a tool-minted grade survives', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-doc-forge-'));
    const ledger = join(home, 'm.jsonl');
    const store = new MemoryStore(ledger, { home, sessionId: 't' });
    const honest = store.commit({ content: 'a fact the user vouched for', source: 'user' });
    store.confirm(honest.id);

    const now = new Date().toISOString();
    writeFileSync(ledger, readFileSync(ledger, 'utf8')
      + JSON.stringify({ id: 'm_forged-assert', tx: now, validFrom: now, validTo: null, type: 'assert',
          state: 'Verified', content: 'a forged top-grade fact',
          provenance: { source: 'user', sessionId: 'cli' },
          supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' }) + '\n'
      + JSON.stringify({ id: 'm_forged-verify', tx: now, type: 'verify', target: 'm_forged-assert',
          resultState: 'Verified', source: 'user' }) + '\n');

    const reread = new MemoryStore(ledger, { home, sessionId: 't2' }).inspect();
    const state = (id: string): string | undefined => reread.find((r) => r.record.id === id)?.record.state;

    // Non-vacuity: a grade the tool conferred must survive.
    expect(state(honest.id), 'the tool-minted grade did not survive — this case would pass on any all-Fresh build')
      .toBe('Verified');
    // The point: a hand-appended claim to an elevated grade is clamped.
    expect(state('m_forged-assert'), 'a hand-appended elevated assert kept its claimed grade').toBe('Fresh');

    const sec = doc('SECURITY.md');
    expect(sec, 'SECURITY.md no longer states that a forged verify record is ignored').toContain('is **ignored**');
    expect(sec, 'SECURITY.md no longer states that a forged elevated assert is clamped').toContain('clamped to `Fresh`');
  }, 30_000);
});

// SECURITY.md discloses that a marker's mere presence is forgeable. Whether that disclosure is true
// is checked here: a residual-risk statement that disagrees with reality gives false assurance. The
// predicate is driven directly.
describe('SECURITY.md states the marker forgeability the predicates actually have', () => {
  it('any marker-shaped row with the prefix is taken as canonical, with no MAC consulted', () => {
    // The shape of a verify with no MAC — exactly the form the disclosure names.
    const forged = (id: string): never =>
      ({ id, type: 'verify', supersedes: null, target: null } as unknown as never);

    expect(isIntegrityMarker(forged('integrity_anything_an_adversary_picks')),
      'an appended integrity_-prefixed row is no longer taken as the marker — the disclosure would be stale').toBe(true);
    expect(isHorizonMarker(forged('horizon_anything_an_adversary_picks')),
      'an appended horizon_-prefixed row is no longer taken as the marker').toBe(true);

    // Non-vacuity: a different prefix must be false, or the two assertions above would pass over a
    // predicate that always returns true.
    expect(isIntegrityMarker(forged('m_ordinary_row')), 'the predicate answers true for any id').toBe(false);
    expect(isHorizonMarker(forged('m_ordinary_row')), 'the predicate answers true for any id').toBe(false);

    const sec = doc('SECURITY.md');
    expect(sec, 'SECURITY.md no longer discloses that the marker presence is forgeable')
      .toContain('presence is forgeable');
    expect(sec, 'SECURITY.md no longer names the two prefixes an adversary can use')
      .toMatch(/integrity_[^a-z]/);
  });
});

// Does SECURITY.md's supported-versions table say the version actually shipping is supported? The
// table's figure is not read and checked: the version is recovered from the shipped manifest and its
// series looked up in the table.
describe('SECURITY.md supports the version the plugin actually ships', () => {
  it('the shipped version line is marked supported, recovered from the manifest', () => {
    const shipped = (JSON.parse(doc('.claude-plugin/plugin.json')) as { version: string }).version;
    expect(shipped, 'the manifest version is not x.y.z').toMatch(/^\d+\.\d+\.\d+$/);
    const parts = shipped.split('.');
    const series = `${parts[0]}.${parts[1]}.x`;

    const rows = doc('SECURITY.md').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
    const mine = rows.find((l) => l.startsWith(`| ${series}`));
    if (mine === undefined) throw new Error(`SECURITY.md has no support row for the shipped series ${series}`);
    expect(mine, `SECURITY.md does not mark ${series} supported`).toContain('✅');

    // Non-vacuity: the table must not mark every row as supported.
    expect(rows.some((l) => l.includes('❌')), 'the support table marks nothing unsupported').toBe(true);
  });
});

// The claim that the compaction settings are read from the global config only. The operation is
// destructive, so a cloned repository must be unable to enable or tune it. Recovered by driving the
// accessor against both locations.
describe('the compaction setting is read from the global config only, as the changelog states', () => {
  it('a project-side config cannot enable it while the global one can', () => {
    const globalHome = mkdtempSync(join(tmpdir(), 'helix-doc-cmpglobal-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'helix-doc-cmpproject-'));
    const enabled = JSON.stringify({ compaction: { auto: true, minRows: 1 } });

    // Placed on the project side alone: it must not turn on.
    writeFileSync(join(projectDir, 'config.json'), enabled);
    expect(compactionConfigFromGlobal(globalHome).auto,
      'a config outside the global home enabled compaction').toBe(false);

    // Non-vacuity: the same content in the global home must turn it on, or the assertion above
    // would pass over an implementation that always returns false.
    writeFileSync(join(globalHome, 'config.json'), enabled);
    expect(compactionConfigFromGlobal(globalHome).auto,
      'the global config could not enable compaction either — the case above proves nothing').toBe(true);

    expect(doc('CHANGELOG.md'), 'the changelog no longer states the global-only rule')
      .toContain('global `~/.helix/config.json` only');
  });
});

// The recovery playbook quotes the refusal of a cross-scope supersede down to its wording. That
// wording is recovered from an actual refusal rather than copied from the document, and the document
// is then checked to carry the same words.
describe('the playbook quotes the cross-scope refusal the store actually raises', () => {
  it('a supersede whose target lives in the other ledger is refused, recovered by execution', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-doc-scope-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-doc-scoperoot-'));
    mkdirSync(join(root, '.helix'));
    const store = new MemoryStore(join(home, 'memory.jsonl'), {
      home, sessionId: 't', project: { root, ledger: join(root, '.helix', 'memory.jsonl') },
    });

    const inGlobal = store.commit({ content: 'a fact in the global ledger', source: 'user', scope: 'global' });
    const inProject = store.commit({ content: 'a fact in the project ledger', source: 'user', scope: 'project' });

    // Non-vacuity: a supersede within one ledger must not be refused, or the assertion below would
    // pass over an implementation that refuses every supersede.
    const digest = store.inspect().find((r) => r.record.id === inGlobal.id)?.contentDigest;
    expect(digest, 'the read path no longer dispenses contentDigest').toBeDefined();
    expect(() => store.commit({ content: 'a same-scope replacement', source: 'user', scope: 'global',
      supersedes: inGlobal.id, supersedesDigest: digest })).not.toThrow();

    let raised = '';
    try {
      store.commit({ content: 'a cross-scope replacement', source: 'user', scope: 'global', supersedes: inProject.id });
    } catch (e) { raised = String((e as Error).message); }

    expect(raised, 'a cross-scope supersede was not refused — the playbook line would be stale')
      .toContain('cannot supersede across scopes');
    expect(doc('docs/release/recovery-playbook.md'), 'the playbook no longer quotes the refusal the store raises')
      .toContain(raised);
  }, 30_000);
});

// The recovery playbook's "what comes back" table. It says a re-commit restores the text only, and
// not the id, the grade, the signature or the interval. Three of its rows are recovered by running.
describe('the playbook table matches what a re-commit actually restores', () => {
  it('the text returns while the id and the grade do not, recovered by execution', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-doc-recommit-'));
    const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 't' });
    const TEXT = 'staging runs Postgres 16 on port 5433';
    const original = store.commit({ content: TEXT, source: 'user' });
    store.confirm(original.id);

    // Non-vacuity: "the grade does not come back" means something only if the original really held one.
    const before = store.inspect().find((r) => r.record.id === original.id)?.record.state;
    expect(before, 'the original never reached an elevated grade — the claim below would be untestable')
      .toBe('Verified');

    store.erase(original.id);
    const recommitted = store.commit({ content: TEXT, source: 'user' });
    const now = store.inspect().find((r) => r.record.id === recommitted.id)?.record;

    expect(now?.content, 'the text did not come back').toBe(TEXT);                    // table row: The text — Yes
    expect(recommitted.id, 'the re-commit reused the old id').not.toBe(original.id);  // table row: Item id — No
    expect(now?.state, 'the re-committed item kept the old grade').toBe('Fresh');     // table row: Trust grade — No

    const play = doc('docs/release/recovery-playbook.md');
    expect(play, 'the table no longer says the id does not come back').toContain('**No — a new `m_<uuid>`.**');
    expect(play, 'the table no longer says the grade does not come back').toContain('**No — the new item is `Fresh`**');
  }, 30_000);
});

// SECURITY.md describes the properties of the markers a compaction mints: content-free, unsigned,
// and coalesced onto one constant id per kind. All three are recovered by actually running a
// compaction.
describe('SECURITY.md describes the marker a compaction actually mints', () => {
  it('the minted integrity marker is content-free, unsigned, and carries the constant id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helix-doc-marker-'));
    const path = join(dir, 'm.jsonl');
    const row = (o: Record<string, unknown>): string => JSON.stringify({
      id: 'm', tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
      type: 'assert', state: 'Fresh', content: '', provenance: { source: 'user', sessionId: 's' },
      supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal', ...o,
    }) + '\n';
    writeFileSync(path, row({ id: 'm_1', content: 'the deploy target is staging' })
                      + row({ id: 'v_forged', type: 'verify', state: 'Verified', supersedes: 'm_1' }));

    // Non-vacuity: a marker must be minted only when a forged verify was really dropped. If a
    // compaction that drops nothing still left a marker, there would be no telling what the
    // assertion below establishes.
    const kept = mkdtempSync(join(tmpdir(), 'helix-doc-nomarker-'));
    const keptPath = join(kept, 'm.jsonl');
    writeFileSync(keptPath, row({ id: 'm_1', content: 'the deploy target is staging' }));
    compactLedger(keptPath, { erasedIds: new Set(), keepValidVerify: () => true, provesKey: () => true });
    expect(parseLedger(keptPath).some(isIntegrityMarker),
      'a compaction that dropped no forged verify still minted an integrity marker').toBe(false);

    compactLedger(path, { erasedIds: new Set(), keepValidVerify: () => false, provesKey: () => true });
    const marker = parseLedger(path).find(isIntegrityMarker);
    if (marker === undefined) throw new Error('the compaction minted no integrity marker after dropping a forged verify');

    expect(marker.id, 'the marker id is not the constant SECURITY.md names').toBe('integrity_marker');
    expect(marker.content, 'the marker carries content').toBe('');
    expect((marker as { mac?: string }).mac, 'the marker is signed — SECURITY.md calls it unsigned').toBeFalsy();

    const sec = doc('SECURITY.md');
    expect(sec, 'SECURITY.md no longer calls the minted marker unsigned').toContain('**unsigned**');
    expect(sec, 'SECURITY.md no longer names the constant ids').toContain('integrity_marker');
  }, 30_000);
});

// The README says automatic compaction is destructive and therefore off until you turn it on. That
// default is recovered by running the accessor.
describe('README states the compaction default the accessor actually returns', () => {
  it('auto compaction is off in an untouched home, recovered by execution', () => {
    const empty = mkdtempSync(join(tmpdir(), 'helix-doc-cmpdefault-'));
    const shipped = compactionConfigFromGlobal(empty);
    expect(shipped.auto, 'auto compaction is on by default — README says it is off').toBe(false);

    // Non-vacuity: the same run confirms the accessor does not simply return false whatever it is given.
    writeFileSync(join(empty, 'config.json'), JSON.stringify({ compaction: { auto: true } }));
    expect(compactionConfigFromGlobal(empty).auto,
      'the accessor answers false whatever the config says — the case above proves nothing').toBe(true);

    expect(doc('README.md'), 'README no longer says compaction is off unless you turn it on')
      .toContain('it is **destructive**, so it is\noff unless you turn it on');
  });
});

// The recovery playbook says the undo window closes only when a compaction physically rewrites the
// ledger. Recovered by having asOf return the content after a soft erase, and not after a
// compaction.
describe('the playbook states the only thing that closes the undo window', () => {
  it('an erased fact stays retrievable until a compaction rewrites the ledger', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-doc-window-'));
    const path = join(home, 'm.jsonl');
    const store = new MemoryStore(path, { home, sessionId: 't' });
    const TEXT = 'a fact that will be erased and then physically dropped';
    const rec = store.commit({ content: TEXT, source: 'user' });
    store.erase(rec.id);

    // Right after the erase: gone from the live view but still in the file — that is the undo window.
    expect(store.inspect().some((r) => r.record.id === rec.id), 'the erased fact is still live').toBe(false);
    expect(readFileSync(path, 'utf8'), 'the erased text left the file before any compaction').toContain(TEXT);

    compactLedger(path, { erasedIds: new Set([rec.id]), keepValidVerify: () => true, provesKey: () => true });

    expect(readFileSync(path, 'utf8'), 'a compaction did not physically drop the erased text').not.toContain(TEXT);
    expect(doc('docs/release/recovery-playbook.md'), 'the playbook no longer names compaction as what closes the window')
      .toContain('The window closes only when a **compaction** physically rewrites the ledger');
  }, 30_000);
});

// The README's first two paragraphs introduce the product and assert checkable things while doing
// it. Being an introduction is no reason to leave them unchecked: it is the first thing a new user
// reads.
describe('README opening states the surfaces and defaults the build actually has', () => {
  it('the engine is exposed as MCP tools and session hooks, recovered from the shipped artifacts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-doc-opening-'));
    const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 't' });
    const server = buildServer(store);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'doc-guard-opening', version: '0' });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const { tools } = await client.listTools();
    await client.close();

    const hooks = JSON.parse(doc('hooks/hooks.json')) as { hooks: Record<string, unknown[]> };
    const events = Object.keys(hooks.hooks).sort();

    expect(tools.length, 'no MCP tool is registered — the opening sentence would be wrong').toBeGreaterThan(0);
    expect(events, 'the two session hooks the opening names are not both declared')
      .toEqual(['SessionEnd', 'SessionStart']);

    const readme = doc('README.md');
    expect(readme, 'README no longer says the engine is exposed as MCP tools and session hooks')
      .toContain('exposed as MCP tools and session hooks');
  }, 30_000);

  it('the cross-validation the opening calls optional is off until configured', () => {
    // "optional" is a claim about a default, so it is recovered from the shipped default config
    // rather than from an accessor.
    expect(DEFAULT_CONFIG.dualVerify.enabled, 'dual-verify ships enabled — README calls it optional').toBe(false);

    const readme = doc('README.md');
    expect(readme, 'README no longer calls the Codex cross-validation optional')
      .toContain('**optional cross-validation**');
    expect(readme, 'README no longer says memory persists across sessions')
      .toContain('across sessions');
  });
});

// SECURITY.md says the signed witness makes the master key materialise on the first memory write
// rather than the first verify. Recovered with a single commit into an empty home.
describe('SECURITY.md states when the master signing key actually comes into existence', () => {
  it('one commit with no verify already materializes the key', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-doc-keybirth-'));
    const key = join(home, 'ledger-mac-master.key');

    // Non-vacuity: it must be absent before the write, or the assertion below is always true.
    expect(readdirSync(home), 'the home was not empty before the first write').toEqual([]);

    new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 't' })
      .commit({ content: 'the very first write', source: 'user' });

    expect(existsSync(key), 'the key did not appear on the first memory write').toBe(true);
    expect(doc('SECURITY.md'), 'SECURITY.md no longer states when the key materializes')
      .toContain('on the *first* memory write rather than the first `verify`');
  });
});

// SECURITY.md describes the marker-erase routing and cites the implementing functions and a
// committed probe by path. A citation can go stale, so all three names are checked to exist.
describe('SECURITY.md cites marker-erase routing that still exists', () => {
  it('the named resolver, family helper and committed probe are all present', () => {
    const sec = doc('SECURITY.md');
    const store = readFileSync(join(ROOT, 'src/memory/store.ts'), 'utf8');

    for (const fn of ['resolveEraseTarget', 'markerFamilyOf']) {
      expect(sec, `SECURITY.md no longer names ${fn}`).toContain(fn);
      // Both names are methods on MemoryStore; the declaration site is what is looked up.
      expect(store, `SECURITY.md names ${fn} but src/memory/store.ts does not declare it`)
        .toMatch(new RegExp(`(private\\s+)?${fn}\\s*\\(`));
    }

    // The probe the document cites by path. If the file goes or is renamed, the citation dangles.
    const cited = 'test/memory/provenance-audit/marker-erase-routing.test.ts';
    expect(sec, 'SECURITY.md no longer cites the marker-erase probe').toContain(cited);
    expect(existsSync(join(ROOT, cited)), `SECURITY.md cites ${cited} but it does not exist`).toBe(true);
    expect(readFileSync(join(ROOT, cited), 'utf8'), 'the cited probe no longer exercises a project-scope marker erase')
      .toMatch(/permanent/);
  });
});
