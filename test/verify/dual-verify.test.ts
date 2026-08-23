import { describe, it, expect } from 'vitest';
import { dualVerify, persistedReason, type DualVerifyDeps, type EchoSource } from '../../src/verify/dual-verify.js';
import { DEFAULT_CONFIG, type HelixConfig } from '../../src/config.js';
import type { CodexOutcome } from '../../src/codex-log.js';
import { digestContent } from '../../src/memory/ledger-mac.js';
import type { LedgerItem } from '../../src/risk/trifecta.js';

const disabledEcho: EchoSource = { mode: 'disabled' };

function deps(over: Partial<DualVerifyDeps>): DualVerifyDeps {
  return {
    config: structuredClone(DEFAULT_CONFIG),
    runner: async () => ({ ok: true, answer: 'the answer is 4' }),
    checkAvailable: async () => ({ available: true }),
    echo: disabledEcho,
    ...over,
  };
}
const enabled = (): HelixConfig => ({ dualVerify: { enabled: true, mode: 'compare', stakesFloor: 'high', model: 'gpt-5.5', effort: 'high', timeoutMs: 120_000, egressPolicy: { memoryEcho: 'block', piiHigh: 'block', piiBulk: 'block', secretHeuristic: 'block', secretEntropy: 'block', secretEntropyExempt: 'allow' }, logContent: false }, metrics: { enabled: true } });

describe('dualVerify', () => {
  it('forwards config.dualVerify.timeoutMs to the runner', async () => {
    let seenTimeout: number | undefined;
    const cfg = enabled();
    cfg.dualVerify.timeoutMs = 234567;
    await dualVerify({ stakes: 'high', question: 'q', helixAnswer: 'a' }, deps({
      config: cfg,
      runner: async (_q, opts) => { seenTimeout = opts?.timeoutMs; return { ok: true, answer: 'x' }; },
    }));
    expect(seenTimeout).toBe(234567);
  });

  it('degrades (ran=false) when disabled, without calling the runner', async () => {
    let called = false;
    const r = await dualVerify({ stakes: 'high', question: 'q', helixAnswer: 'a' },
      deps({ runner: async () => { called = true; return { ok: true, answer: 'x' }; } }));
    expect(r.ran).toBe(false);
    expect(r.attempted).toBe(false); // no metered call
    expect(r.reason).toMatch(/disabled/i);
    expect(called).toBe(false);
  });

  it('degrades when codex is unavailable — NEVER fabricates an answer', async () => {
    const r = await dualVerify({ stakes: 'high', question: 'q', helixAnswer: 'a' },
      deps({ config: enabled(), checkAvailable: async () => ({ available: false, reason: 'not logged in' }) }));
    expect(r.ran).toBe(false);
    expect(r.codexAnswer).toBeUndefined();
    expect(r.reason).toMatch(/not logged in/);
  });

  it('degrades when the runner fails (no fabrication)', async () => {
    const r = await dualVerify({ stakes: 'high', question: 'q', helixAnswer: 'a' },
      deps({ config: enabled(), runner: async () => ({ ok: false, error: 'timeout' }) }));
    expect(r.ran).toBe(false);
    expect(r.attempted).toBe(true); // codex WAS reached (metered) — the run itself failed
    expect(r.reason).toMatch(/timeout/);
    expect(r.codexAnswer).toBeUndefined();
  });

  it('on success builds an agreement map (compare mode)', async () => {
    const r = await dualVerify({ stakes: 'high', question: 'what is 2+2?', helixAnswer: 'the answer is 4' },
      deps({ config: enabled(), runner: async () => ({ ok: true, answer: 'the answer is 4' }) }));
    expect(r.ran).toBe(true);
    expect(r.codexAnswer).toBe('the answer is 4');
    expect(r.agreement?.verdict).toBe('agree');
    expect(r.mode).toBe('compare');
  });

  it('zero-pair answers surface as indeterminate through the pipeline', async () => {
    const r = await dualVerify({ stakes: 'high', question: 'q', helixAnswer: 'use postgres' },
      deps({ config: enabled(), runner: async () => ({ ok: true, answer: 'use mysql instead' }) }));
    expect(r.ran).toBe(true);
    expect(r.agreement?.verdict).toBe('indeterminate');
  });

  it('flags divergence when an anchored pair leaves differing remainders', async () => {
    const r = await dualVerify({ stakes: 'high', question: 'q', helixAnswer: 'Use postgres for the store. Add an index today.' },
      deps({ config: enabled(), runner: async () => ({ ok: true, answer: 'Use postgres for the store. Skip the index for now.' }) }));
    expect(r.ran).toBe(true);
    expect(r.agreement?.verdict).toBe('diverge');
  });

  it('degrades without any metered call when stakes are below the floor (free gate first)', async () => {
    let preflights = 0;
    const r = await dualVerify({ question: 'q', helixAnswer: 'a', stakes: 'low' },
      deps({ config: enabled(), checkAvailable: async () => { preflights++; return { available: true }; } }));
    expect(r.ran).toBe(false);
    expect(r.attempted).toBe(false);
    expect(r.reason).toMatch(/stakes 'low' below configured floor 'high'/);
    expect(preflights).toBe(0); // the floor gate must not even preflight
  });

  it('the floor refusal names the lowest accepted stakes and the config key (H4)', async () => {
    const r = await dualVerify({ question: 'q', helixAnswer: 'a', stakes: 'low' },
      deps({ config: enabled() }));
    expect(r.reason).toContain("lowest accepted: 'high'");
    expect(r.reason).toContain('dualVerify.stakesFloor');
  });

  it('runs when stakes meet the floor', async () => {
    const r = await dualVerify({ question: 'q', helixAnswer: 'the answer is 4', stakes: 'high' },
      deps({ config: enabled() }));
    expect(r.ran).toBe(true);
  });

  it('xhigh floor: a high-stakes call is below it and skips; only xhigh meets it', async () => {
    const withFloor = (f: HelixConfig['dualVerify']['stakesFloor']): HelixConfig => {
      const c = enabled(); c.dualVerify.stakesFloor = f; return c;
    };
    const below = await dualVerify({ question: 'q', helixAnswer: 'a', stakes: 'high' },
      deps({ config: withFloor('xhigh') }));
    expect(below.ran).toBe(false);
    expect(below.reason).toMatch(/stakes 'high' below configured floor 'xhigh'/);
    const meets = await dualVerify({ question: 'q', helixAnswer: 'the answer is 4', stakes: 'xhigh' },
      deps({ config: withFloor('xhigh') }));
    expect(meets.ran).toBe(true);
  });

  it('an omitted stakes value is treated as the lowest tier, so the floor refuses it with no metered call', async () => {
    let preflights = 0;
    let called = false;
    const r = await dualVerify({ question: 'q', helixAnswer: 'the answer is 4' }, deps({
      config: enabled(),
      checkAvailable: async () => { preflights++; return { available: true }; },
      runner: async () => { called = true; return { ok: true, answer: 'x' }; },
    }));
    expect(r.ran).toBe(false);
    expect(r.attempted).toBe(false);
    expect(preflights).toBe(0);   // still the free gate, still first
    expect(called).toBe(false);   // the quota the floor exists to protect is not spent
  });

  it('the refusal distinguishes an omitted stakes value from a declared-but-too-low one', async () => {
    const omitted = await dualVerify({ question: 'q', helixAnswer: 'a' }, deps({ config: enabled() }));
    const declared = await dualVerify({ question: 'q', helixAnswer: 'a', stakes: 'low' }, deps({ config: enabled() }));
    expect(omitted.reason).not.toBe(declared.reason);
    expect(omitted.reason).toContain('not declared');
    expect(declared.reason).toContain("stakes 'low' below");
    expect(omitted.reason).toContain("lowest accepted: 'high'");   // both still name the way forward (H4)
  });

  it("a 'low' floor still admits an omitted stakes value — the floor decides, not the omission", async () => {
    const cfg = enabled();
    cfg.dualVerify.stakesFloor = 'low';
    const r = await dualVerify({ question: 'q', helixAnswer: 'the answer is 4' }, deps({ config: cfg }));
    expect(r.ran).toBe(true);
  });

  it('a refusal names the gates that ran and the one that stopped it (H7)', async () => {
    const disabled = await dualVerify({ question: 'q', helixAnswer: 'a' }, deps({}));
    expect(disabled.gates).toEqual({ evaluated: ['enabled'], stoppedAt: 'enabled' });

    const belowFloor = await dualVerify({ question: 'q', helixAnswer: 'a', stakes: 'low' },
      deps({ config: enabled() }));
    expect(belowFloor.gates).toEqual({ evaluated: ['enabled', 'stakesFloor'], stoppedAt: 'stakesFloor' });

    const blocked = await dualVerify(
      { question: 'is this key live?', helixAnswer: 'key is sk-ant-api03-Ab12Cd34Ef56Gh78Ij90Kl12Mn34', stakes: 'high' },
      deps({ config: enabled() }));
    expect(blocked.gates).toEqual({ evaluated: ['enabled', 'stakesFloor', 'egress'], stoppedAt: 'egress' });

    const unavailable = await dualVerify({ question: 'q', helixAnswer: 'a', stakes: 'high' },
      deps({ config: enabled(), checkAvailable: async () => ({ available: false, reason: 'not logged in' }) }));
    expect(unavailable.gates)
      .toEqual({ evaluated: ['enabled', 'stakesFloor', 'egress', 'available'], stoppedAt: 'available' });
  });

  it('the gate trace records the floor BEFORE the egress leg — the order the guards actually run in', async () => {
    // The dogfood channel spent three weeks inferring this order from message strings and got it
    // backwards (merge doc C1). A below-floor call must therefore never report the egress leg as run.
    const r = await dualVerify({ question: 'q', helixAnswer: 'a', stakes: 'low' }, deps({ config: enabled() }));
    expect(r.gates?.evaluated).not.toContain('egress');
    expect(r.gates?.stoppedAt).toBe('stakesFloor');
  });

  it('a run that reaches the metered call and fails names the runner as the stopping gate', async () => {
    const r = await dualVerify({ question: 'q', helixAnswer: 'a', stakes: 'high' },
      deps({ config: enabled(), runner: async () => ({ ok: false, error: 'timeout' }) }));
    expect(r.attempted).toBe(true);
    expect(r.gates).toEqual({ evaluated: ['enabled', 'stakesFloor', 'egress', 'available', 'runner'], stoppedAt: 'runner' });
  });

  it('refuses fail-closed when the payload contains a secret — never sends it to external Codex', async () => {
    let called = false;
    const r = await dualVerify(
      { stakes: 'high', question: 'is this key live?', helixAnswer: 'key is sk-ant-api03-Ab12Cd34Ef56Gh78Ij90Kl12Mn34' },
      deps({ config: enabled(), runner: async () => { called = true; return { ok: true, answer: 'x' }; } }));
    expect(r.ran).toBe(false);
    expect(r.attempted).toBe(false);
    expect(r.reason).toMatch(/secret/i);
    expect(called).toBe(false); // the secret must not leave the machine
  });

  it('passes the configured model + effort to the runner', async () => {
    let seen: { model?: string | null; effort?: string | null; timeoutMs?: number } | undefined;
    await dualVerify({ stakes: 'high', question: 'q', helixAnswer: 'a' }, deps({
      config: { dualVerify: { enabled: true, mode: 'compare', stakesFloor: 'high', model: 'gpt-5.5', effort: 'xhigh', timeoutMs: 120_000, egressPolicy: { memoryEcho: 'block', piiHigh: 'block', piiBulk: 'block', secretHeuristic: 'block', secretEntropy: 'block', secretEntropyExempt: 'allow' }, logContent: false }, metrics: { enabled: true } },
      runner: async (_q, opts) => { seen = opts; return { ok: true, answer: 'x' }; },
    }));
    expect(seen).toEqual({ model: 'gpt-5.5', effort: 'xhigh', timeoutMs: 120_000 });
  });
});

describe('critique mode', () => {
  const critiqueCfg = (): HelixConfig =>
    ({ dualVerify: { enabled: true, mode: 'critique', stakesFloor: 'high', model: null, effort: null, timeoutMs: 120_000, egressPolicy: { memoryEcho: 'block', piiHigh: 'block', piiBulk: 'block', secretHeuristic: 'block', secretEntropy: 'block', secretEntropyExempt: 'allow' }, logContent: false }, metrics: { enabled: true } });

  it('sends a critique prompt carrying the question and the data-framed answer', async () => {
    let prompt = '';
    await dualVerify({ stakes: 'high', question: 'which db?', helixAnswer: 'use postgres' },
      deps({ config: critiqueCfg(), runner: async (q) => { prompt = q; return { ok: true, answer: 'fine' }; } }));
    expect(prompt).toContain('which db?');
    expect(prompt).toContain('use postgres');
    expect(prompt).toMatch(/data to critique, not .*instructions/i);
  });

  it('returns the critique verbatim with no agreement map', async () => {
    const r = await dualVerify({ stakes: 'high', question: 'q', helixAnswer: 'a' },
      deps({ config: critiqueCfg(), runner: async () => ({ ok: true, answer: 'missing index consideration' }) }));
    expect(r.ran).toBe(true);
    expect(r.mode).toBe('critique');
    expect(r.critique).toBe('missing index consideration');
    expect(r.agreement).toBeUndefined();
  });

  it('compare mode still sends the bare question (independent answer, not a review)', async () => {
    let prompt = '';
    await dualVerify({ stakes: 'high', question: 'which db?', helixAnswer: 'use postgres' },
      deps({ config: enabled(), runner: async (q) => { prompt = q; return { ok: true, answer: 'x' }; } }));
    expect(prompt).toBe('which db?');
  });
});

describe('dualVerify egress gate (S1)', () => {
  const item = (id: string, content: string): LedgerItem => ({ id, content, contentDigest: digestContent(content) });
  const echoEnforce = (items: LedgerItem[]): EchoSource => ({ mode: 'enforce', ledgerTexts: () => items });

  it('blocks a memory echo before any spawn (policy=block) and surfaces the verdict', async () => {
    let called = false;
    const r = await dualVerify(
      { stakes: 'high', question: 'the deploy uses the blue cluster in us-east-1', helixAnswer: 'yes' },
      deps({
        config: enabled(),
        echo: echoEnforce([item('m_1', 'the deploy uses the blue cluster in us-east-1')]),
        runner: async () => { called = true; return { ok: true, answer: 'x' }; },
      }));
    expect(r.ran).toBe(false);
    expect(r.attempted).toBe(false);
    expect(called).toBe(false); // gate is pre-spawn
    expect(r.egress?.decision).toBe('blocked');
    expect(r.egress?.echoMemoryIds).toEqual(['m_1']);
  });

  it('proceeds and carries an allowed_override verdict when policy=allow', async () => {
    const cfg = enabled(); cfg.dualVerify.egressPolicy.memoryEcho = 'allow';
    const r = await dualVerify(
      { stakes: 'high', question: 'the deploy uses the blue cluster in us-east-1', helixAnswer: 'the answer is 4' },
      deps({
        config: cfg,
        echo: echoEnforce([item('m_1', 'the deploy uses the blue cluster in us-east-1')]),
      }));
    expect(r.ran).toBe(true);
    expect(r.egress?.decision).toBe('allowed_override');
    expect(r.egress?.echoMemoryIds).toEqual(['m_1']);
  });

  it('hard-blocks a secret under BOTH policies (override-proof)', async () => {
    const secret = 'key is sk-ant-api03-Ab12Cd34Ef56Gh78Ij90Kl12Mn34';
    for (const policy of ['block', 'allow'] as const) {
      const cfg = enabled(); cfg.dualVerify.egressPolicy = { memoryEcho: policy, piiHigh: policy, piiBulk: policy, secretHeuristic: policy, secretEntropy: policy, secretEntropyExempt: 'allow' };
      const r = await dualVerify({ stakes: 'high', question: 'is this live?', helixAnswer: secret },
        deps({ config: cfg, echo: disabledEcho }));
      expect(r.ran).toBe(false);
      expect(r.egress?.decision).toBe('blocked');
      expect(r.egress?.legs).toContain('secret');
    }
  });

  it('blocks high-severity PII (card) under policy=block', async () => {
    const r = await dualVerify({ stakes: 'high', question: 'verify card 4111 1111 1111 1111', helixAnswer: 'ok' },
      deps({ config: enabled(), echo: disabledEcho }));
    expect(r.ran).toBe(false);
    expect(r.egress?.legs).toEqual(['pii']);
    expect(r.egress?.piiKinds).toContain('credit_card');
  });

  it('echo:{mode:disabled} skips the echo leg but still runs secret + PII', async () => {
    // ledger is not consulted; the same echo text now passes (no PII, no secret).
    const r = await dualVerify(
      { stakes: 'high', question: 'the deploy uses the blue cluster in us-east-1', helixAnswer: 'the answer is 4' },
      deps({ config: enabled(), echo: disabledEcho }));
    expect(r.ran).toBe(true);
    expect(r.egress?.decision).toBe('pass');
    expect(r.egress?.echoMemoryIds).toEqual([]);
  });

  it('carries the egress verdict on the success path (audit-only low-sev PII passes)', async () => {
    const r = await dualVerify({ stakes: 'high', question: 'ping kim@example.com', helixAnswer: 'the answer is 4' },
      deps({ config: enabled(), echo: disabledEcho }));
    expect(r.ran).toBe(true);
    expect(r.egress?.decision).toBe('pass');
    expect(r.egress?.piiKinds).toEqual(['email']);
  });

  it('carries the egress verdict on the run-failure path', async () => {
    const r = await dualVerify({ stakes: 'high', question: 'q', helixAnswer: 'a' },
      deps({ config: enabled(), echo: disabledEcho, runner: async () => ({ ok: false, error: 'timeout' }) }));
    expect(r.ran).toBe(false);
    expect(r.attempted).toBe(true);
    expect(r.egress?.decision).toBe('pass');
  });

  // H6: the declaration has to survive the trip from the caller's params to the classifier. The
  // second call asserts only that the ECHO leg stopped refusing — whether it then runs is the
  // stub runner's business, and asserting on that would couple this test to the stub.
  it('H6: a quoted declaration in params reaches the egress classifier', async () => {
    const memo = 'the deploy uses the blue cluster in us-east-1';
    let spawned = 0;
    const mk = (): DualVerifyDeps => deps({
      config: enabled(),
      echo: echoEnforce([item('m_1', memo)]),
      runner: async () => { spawned += 1; return { ok: true, answer: 'ok' }; },
    });

    const undeclared = await dualVerify({ stakes: 'high', question: `restate: ${memo}`, helixAnswer: 'ok' }, mk());
    expect(undeclared.outcome).toBe('refused');
    expect(undeclared.reason).toContain('memory-echo');
    expect(spawned).toBe(0);                       // refused BEFORE any spawn, as the S1 gate requires

    const declared = await dualVerify(
      { stakes: 'high', question: `restate: ${memo}`, helixAnswer: 'ok',
        quotedMemory: [{ id: 'm_1', contentDigest: digestContent(memo) }] }, mk());
    expect(declared.reason ?? '').not.toContain('memory-echo');
    expect(declared.egress?.echoExemptIds).toEqual(['m_1']);
  });
});

describe('dualVerify: outcome + promptSent (for opt-in content logging)', () => {
  const expectOutcome = (got: CodexOutcome | undefined, want: CodexOutcome) => expect(got).toBe(want);

  it('disabled -> outcome skipped, no promptSent', async () => {
    const r = await dualVerify({ stakes: 'high', question: 'q', helixAnswer: 'a' }, deps({}));
    expectOutcome(r.outcome, 'skipped');
    expect(r.promptSent).toBeUndefined();
  });

  it('below floor -> outcome skipped, no promptSent', async () => {
    const r = await dualVerify({ question: 'q', helixAnswer: 'a', stakes: 'low' }, deps({ config: enabled() }));
    expectOutcome(r.outcome, 'skipped');
    expect(r.promptSent).toBeUndefined();
  });

  it('secret in payload -> outcome refused, no promptSent (the secret is never retained)', async () => {
    const r = await dualVerify(
      { stakes: 'high', question: 'is this key live?', helixAnswer: 'key is sk-ant-api03-Ab12Cd34Ef56Gh78Ij90Kl12Mn34' },
      deps({ config: enabled() }));
    expectOutcome(r.outcome, 'refused');
    expect(r.promptSent).toBeUndefined();
  });

  it('codex unavailable -> outcome unavailable, no promptSent', async () => {
    const r = await dualVerify({ stakes: 'high', question: 'q', helixAnswer: 'a' },
      deps({ config: enabled(), checkAvailable: async () => ({ available: false, reason: 'not logged in' }) }));
    expectOutcome(r.outcome, 'unavailable');
    expect(r.promptSent).toBeUndefined();
  });

  it('runner failed -> outcome error, no promptSent', async () => {
    const r = await dualVerify({ stakes: 'high', question: 'q', helixAnswer: 'a' },
      deps({ config: enabled(), runner: async () => ({ ok: false, error: 'codex produced no output' }) }));
    expectOutcome(r.outcome, 'error');
    expect(r.promptSent).toBeUndefined();
  });

  it('compare success -> outcome sent, promptSent equals the bare question', async () => {
    const r = await dualVerify({ stakes: 'high', question: 'which db?', helixAnswer: 'use postgres' },
      deps({ config: enabled(), runner: async () => ({ ok: true, answer: 'use postgres' }) }));
    expectOutcome(r.outcome, 'sent');
    expect(r.promptSent).toBe('which db?');
  });

  it('critique success -> outcome sent, promptSent equals the critique prompt (contains question + answer)', async () => {
    const critiqueCfg: HelixConfig =
      { dualVerify: { enabled: true, mode: 'critique', stakesFloor: 'high', model: null, effort: null, timeoutMs: 120_000, egressPolicy: { memoryEcho: 'block', piiHigh: 'block', piiBulk: 'block', secretHeuristic: 'block', secretEntropy: 'block', secretEntropyExempt: 'allow' }, logContent: false }, metrics: { enabled: true } };
    const r = await dualVerify({ stakes: 'high', question: 'which db?', helixAnswer: 'use postgres' },
      deps({ config: critiqueCfg, runner: async () => ({ ok: true, answer: 'fine' }) }));
    expectOutcome(r.outcome, 'sent');
    expect(r.promptSent).toContain('which db?');
    expect(r.promptSent).toContain('use postgres');
    expect(r.promptSent).toMatch(/data to critique/i);
  });
});

describe('persistedReason (content-free reason for the durable sinks)', () => {
  it("reduces the 'error' outcome to a static label, dropping the embedded codex stderr", () => {
    const withStderr = 'codex run failed: codex exited 1: STDERR-MARKER traceback /tmp/x';
    expect(persistedReason({ outcome: 'error', reason: withStderr })).toBe('codex run failed');
    expect(persistedReason({ outcome: 'error', reason: withStderr })).not.toContain('STDERR-MARKER');
  });

  it('passes through the already content-free reason for every non-error outcome', () => {
    expect(persistedReason({ outcome: 'skipped', reason: 'dual-verify is disabled in config' }))
      .toBe('dual-verify is disabled in config');
    expect(persistedReason({ outcome: 'skipped', reason: "stakes 'low' below configured floor 'high'" }))
      .toBe("stakes 'low' below configured floor 'high'");
    expect(persistedReason({ outcome: 'refused', reason: 'blocked: memory-echo (2 items)' }))
      .toBe('blocked: memory-echo (2 items)');
    expect(persistedReason({ outcome: 'unavailable', reason: 'not logged in' })).toBe('not logged in');
    expect(persistedReason({ outcome: 'sent', reason: undefined })).toBeUndefined();
  });

  it("reduces the 'unavailable' preflight-failure reason to a static label (raw exception text never reaches the sinks)", () => {
    const raw = 'codex preflight failed: spawn codex ENOENT /opt/codex/bin';
    expect(persistedReason({ outcome: 'unavailable', reason: raw })).toBe('codex preflight failed');
    expect(persistedReason({ outcome: 'unavailable', reason: raw })).not.toContain('ENOENT');
    // interpretPreflight's static strings still pass through untouched
    expect(persistedReason({ outcome: 'unavailable', reason: 'codex launcher not found on PATH' }))
      .toBe('codex launcher not found on PATH');
  });
});

describe('G1: what the gate scanned is what the runner is sent', () => {
  it('a zero-width-padded memory is refused and NEVER reaches the runner', async () => {
    const MEMO = 'PROJECT ORION LAUNCH CODE IS ALPHA';
    const zw = MEMO.split('').join('​');
    let runnerSaw: string | null = null;
    const result = await dualVerify(
      { stakes: 'high', question: `please review: ${zw}`, helixAnswer: 'looks fine' },
      deps({
        config: enabled(),      // every egress leg already 'block' in this helper
        runner: async (prompt: string) => { runnerSaw = prompt; return { ok: true, answer: 'ok' }; },
        echo: { mode: 'enforce', ledgerTexts: () => [{ id: 'm_secret', content: MEMO, contentDigest: digestContent(MEMO) }] },
      }),
    );
    expect(result.outcome).toBe('refused');
    expect(result.ran).toBe(false);
    expect(runnerSaw).toBeNull();            // today: the runner receives the reconstituted memory
  });

  // Mutation-testing lock (task-2 Step 7, Isolate-B at the dual-verify caller level): compare mode's
  // `outbound` is built from `question` ALONE (see dual-verify.ts) -- helixAnswer is never transmitted
  // in that mode. A ZWSP-padded echo hidden ONLY in helixAnswer is therefore invisible to any
  // outbound-only scan, by construction. This still must block: Helix treats `texts` (both fields)
  // conservatively for detection/audit even though only `outbound` leaves the machine in this mode.
  // Only the raw-form scan with the Cf-strip (normalizeForMatch) active can catch it here.
  it('compare mode still blocks an echo hidden only in helixAnswer, though it is never sent', async () => {
    const MEMO = 'PROJECT ORION LAUNCH CODE IS ALPHA';
    const zw = MEMO.split('').join('​');
    let called = false;
    const result = await dualVerify(
      { stakes: 'high', question: 'what do you think?', helixAnswer: `echoing back: ${zw}` },
      deps({
        config: enabled(),   // mode: 'compare' -- helixAnswer is not part of the sent prompt
        runner: async () => { called = true; return { ok: true, answer: 'ok' }; },
        echo: { mode: 'enforce', ledgerTexts: () => [{ id: 'm_secret', content: MEMO, contentDigest: digestContent(MEMO) }] },
      }),
    );
    expect(result.outcome).toBe('refused');
    expect(called).toBe(false);
    expect(result.egress?.echoMemoryIds).toEqual(['m_secret']);
  });

  // Regression lock for the "build once, never rebuild" invariant (8a3bb1a): the string handed to
  // deps.runner must be BYTE-IDENTICAL to result.promptSent (what the gate scanned and what the opt-in
  // content log records), and it must differ from the raw question whenever normalizeUntrusted actually
  // changes it. Every other prompt assertion in this file (e.g. 'which db?') uses a pure-ASCII question
  // where normalizeUntrusted is the identity, so none of them can distinguish "sent the already-built
  // prompt" from "rebuilt the raw question at the call site" -- a bug this exact shape shipped once
  // already (8a3bb1a) and every existing test stayed green through it. This question contains a fence
  // run ("===") that normalizeUntrusted breaks ("= = ="), so a rebuild-at-send-site regression is
  // observable: the runner would see the untouched raw question instead.
  it('compare mode: the runner receives the SAME bytes the gate scanned, not a rebuilt raw question', async () => {
    const question = 'what does === mean in js?';
    let runnerSaw: string | null = null;
    const result = await dualVerify(
      { stakes: 'high', question, helixAnswer: 'strict equality, no type coercion' },
      deps({
        config: enabled(),   // mode: 'compare'
        runner: async (prompt: string) => { runnerSaw = prompt; return { ok: true, answer: 'x' }; },
      }),
    );
    expect(result.outcome).toBe('sent');
    expect(runnerSaw).toBe(result.promptSent);   // byte-identical to what the audit/content log records
    expect(runnerSaw).not.toBe(question);        // and NOT the raw, un-normalized question
  });
});
