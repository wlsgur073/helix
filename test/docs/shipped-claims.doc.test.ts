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
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryStore } from '../../src/memory/store.js';
import { buildServer } from '../../src/server/helix-server.js';
import { classifyEgress, type EgressInput } from '../../src/risk/trifecta.js';
import { dualVerify } from '../../src/verify/dual-verify.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const doc = (name: string): string => readFileSync(join(ROOT, name), 'utf8');

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
