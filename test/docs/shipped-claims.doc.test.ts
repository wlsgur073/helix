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
    expect(doc('README.md')).toMatch(/helix_memory_erase[^\n]*\*\*soft\*\*|soft erase/);
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
