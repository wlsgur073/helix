import { describe, it, expect } from 'vitest';
import { dualVerify, persistedReason, type DualVerifyDeps, type EchoSource } from '../../src/verify/dual-verify.js';
import { DEFAULT_CONFIG, type HelixConfig } from '../../src/config.js';
import type { CodexOutcome } from '../../src/codex-log.js';

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
const enabled = (): HelixConfig => ({ dualVerify: { enabled: true, mode: 'compare', stakesFloor: 'high', model: 'gpt-5.5', effort: 'high', timeoutMs: 120_000, egressPolicy: { memoryEcho: 'block', piiHigh: 'block', piiBulk: 'block', secretHeuristic: 'block', secretEntropy: 'block' }, logContent: false }, metrics: { enabled: true } });

describe('dualVerify', () => {
  it('forwards config.dualVerify.timeoutMs to the runner', async () => {
    let seenTimeout: number | undefined;
    const cfg = enabled();
    cfg.dualVerify.timeoutMs = 234567;
    await dualVerify({ question: 'q', helixAnswer: 'a' }, deps({
      config: cfg,
      runner: async (_q, opts) => { seenTimeout = opts?.timeoutMs; return { ok: true, answer: 'x' }; },
    }));
    expect(seenTimeout).toBe(234567);
  });

  it('degrades (ran=false) when disabled, without calling the runner', async () => {
    let called = false;
    const r = await dualVerify({ question: 'q', helixAnswer: 'a' },
      deps({ runner: async () => { called = true; return { ok: true, answer: 'x' }; } }));
    expect(r.ran).toBe(false);
    expect(r.attempted).toBe(false); // no metered call
    expect(r.reason).toMatch(/disabled/i);
    expect(called).toBe(false);
  });

  it('degrades when codex is unavailable — NEVER fabricates an answer', async () => {
    const r = await dualVerify({ question: 'q', helixAnswer: 'a' },
      deps({ config: enabled(), checkAvailable: async () => ({ available: false, reason: 'not logged in' }) }));
    expect(r.ran).toBe(false);
    expect(r.codexAnswer).toBeUndefined();
    expect(r.reason).toMatch(/not logged in/);
  });

  it('degrades when the runner fails (no fabrication)', async () => {
    const r = await dualVerify({ question: 'q', helixAnswer: 'a' },
      deps({ config: enabled(), runner: async () => ({ ok: false, error: 'timeout' }) }));
    expect(r.ran).toBe(false);
    expect(r.attempted).toBe(true); // codex WAS reached (metered) — the run itself failed
    expect(r.reason).toMatch(/timeout/);
    expect(r.codexAnswer).toBeUndefined();
  });

  it('on success builds an agreement map (compare mode)', async () => {
    const r = await dualVerify({ question: 'what is 2+2?', helixAnswer: 'the answer is 4' },
      deps({ config: enabled(), runner: async () => ({ ok: true, answer: 'the answer is 4' }) }));
    expect(r.ran).toBe(true);
    expect(r.codexAnswer).toBe('the answer is 4');
    expect(r.agreement?.verdict).toBe('agree');
    expect(r.mode).toBe('compare');
  });

  it('flags divergence when the answers differ', async () => {
    const r = await dualVerify({ question: 'q', helixAnswer: 'use postgres' },
      deps({ config: enabled(), runner: async () => ({ ok: true, answer: 'use mysql instead' }) }));
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

  it('runs when stakes meet the floor', async () => {
    const r = await dualVerify({ question: 'q', helixAnswer: 'the answer is 4', stakes: 'high' },
      deps({ config: enabled() }));
    expect(r.ran).toBe(true);
  });

  it('runs when stakes are unspecified (an explicit tool invocation signals intent)', async () => {
    const r = await dualVerify({ question: 'q', helixAnswer: 'the answer is 4' }, deps({ config: enabled() }));
    expect(r.ran).toBe(true);
  });

  it('refuses fail-closed when the payload contains a secret — never sends it to external Codex', async () => {
    let called = false;
    const r = await dualVerify(
      { question: 'is this key live?', helixAnswer: 'key is sk-ant-api03-Ab12Cd34Ef56Gh78Ij90Kl12Mn34' },
      deps({ config: enabled(), runner: async () => { called = true; return { ok: true, answer: 'x' }; } }));
    expect(r.ran).toBe(false);
    expect(r.attempted).toBe(false);
    expect(r.reason).toMatch(/secret/i);
    expect(called).toBe(false); // the secret must not leave the machine
  });

  it('passes the configured model + effort to the runner', async () => {
    let seen: { model?: string | null; effort?: string | null; timeoutMs?: number } | undefined;
    await dualVerify({ question: 'q', helixAnswer: 'a' }, deps({
      config: { dualVerify: { enabled: true, mode: 'compare', stakesFloor: 'high', model: 'gpt-5.5', effort: 'xhigh', timeoutMs: 120_000, egressPolicy: { memoryEcho: 'block', piiHigh: 'block', piiBulk: 'block', secretHeuristic: 'block', secretEntropy: 'block' }, logContent: false }, metrics: { enabled: true } },
      runner: async (_q, opts) => { seen = opts; return { ok: true, answer: 'x' }; },
    }));
    expect(seen).toEqual({ model: 'gpt-5.5', effort: 'xhigh', timeoutMs: 120_000 });
  });
});

describe('critique mode', () => {
  const critiqueCfg = (): HelixConfig =>
    ({ dualVerify: { enabled: true, mode: 'critique', stakesFloor: 'high', model: null, effort: null, timeoutMs: 120_000, egressPolicy: { memoryEcho: 'block', piiHigh: 'block', piiBulk: 'block', secretHeuristic: 'block', secretEntropy: 'block' }, logContent: false }, metrics: { enabled: true } });

  it('sends a critique prompt carrying the question and the data-framed answer', async () => {
    let prompt = '';
    await dualVerify({ question: 'which db?', helixAnswer: 'use postgres' },
      deps({ config: critiqueCfg(), runner: async (q) => { prompt = q; return { ok: true, answer: 'fine' }; } }));
    expect(prompt).toContain('which db?');
    expect(prompt).toContain('use postgres');
    expect(prompt).toMatch(/data to critique, not .*instructions/i);
  });

  it('returns the critique verbatim with no agreement map', async () => {
    const r = await dualVerify({ question: 'q', helixAnswer: 'a' },
      deps({ config: critiqueCfg(), runner: async () => ({ ok: true, answer: 'missing index consideration' }) }));
    expect(r.ran).toBe(true);
    expect(r.mode).toBe('critique');
    expect(r.critique).toBe('missing index consideration');
    expect(r.agreement).toBeUndefined();
  });

  it('compare mode still sends the bare question (independent answer, not a review)', async () => {
    let prompt = '';
    await dualVerify({ question: 'which db?', helixAnswer: 'use postgres' },
      deps({ config: enabled(), runner: async (q) => { prompt = q; return { ok: true, answer: 'x' }; } }));
    expect(prompt).toBe('which db?');
  });
});

describe('dualVerify egress gate (S1)', () => {
  const echoEnforce = (items: Array<{ id: string; content: string }>): EchoSource =>
    ({ mode: 'enforce', ledgerTexts: () => items });

  it('blocks a memory echo before any spawn (policy=block) and surfaces the verdict', async () => {
    let called = false;
    const r = await dualVerify(
      { question: 'the deploy uses the blue cluster in us-east-1', helixAnswer: 'yes' },
      deps({
        config: enabled(),
        echo: echoEnforce([{ id: 'm_1', content: 'the deploy uses the blue cluster in us-east-1' }]),
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
      { question: 'the deploy uses the blue cluster in us-east-1', helixAnswer: 'the answer is 4' },
      deps({
        config: cfg,
        echo: echoEnforce([{ id: 'm_1', content: 'the deploy uses the blue cluster in us-east-1' }]),
      }));
    expect(r.ran).toBe(true);
    expect(r.egress?.decision).toBe('allowed_override');
    expect(r.egress?.echoMemoryIds).toEqual(['m_1']);
  });

  it('hard-blocks a secret under BOTH policies (override-proof)', async () => {
    const secret = 'key is sk-ant-api03-Ab12Cd34Ef56Gh78Ij90Kl12Mn34';
    for (const policy of ['block', 'allow'] as const) {
      const cfg = enabled(); cfg.dualVerify.egressPolicy = { memoryEcho: policy, piiHigh: policy, piiBulk: policy, secretHeuristic: policy, secretEntropy: policy };
      const r = await dualVerify({ question: 'is this live?', helixAnswer: secret },
        deps({ config: cfg, echo: disabledEcho }));
      expect(r.ran).toBe(false);
      expect(r.egress?.decision).toBe('blocked');
      expect(r.egress?.legs).toContain('secret');
    }
  });

  it('blocks high-severity PII (card) under policy=block', async () => {
    const r = await dualVerify({ question: 'verify card 4111 1111 1111 1111', helixAnswer: 'ok' },
      deps({ config: enabled(), echo: disabledEcho }));
    expect(r.ran).toBe(false);
    expect(r.egress?.legs).toEqual(['pii']);
    expect(r.egress?.piiKinds).toContain('credit_card');
  });

  it('echo:{mode:disabled} skips the echo leg but still runs secret + PII', async () => {
    // ledger is not consulted; the same echo text now passes (no PII, no secret).
    const r = await dualVerify(
      { question: 'the deploy uses the blue cluster in us-east-1', helixAnswer: 'the answer is 4' },
      deps({ config: enabled(), echo: disabledEcho }));
    expect(r.ran).toBe(true);
    expect(r.egress?.decision).toBe('pass');
    expect(r.egress?.echoMemoryIds).toEqual([]);
  });

  it('carries the egress verdict on the success path (audit-only low-sev PII passes)', async () => {
    const r = await dualVerify({ question: 'ping kim@example.com', helixAnswer: 'the answer is 4' },
      deps({ config: enabled(), echo: disabledEcho }));
    expect(r.ran).toBe(true);
    expect(r.egress?.decision).toBe('pass');
    expect(r.egress?.piiKinds).toEqual(['email']);
  });

  it('carries the egress verdict on the run-failure path', async () => {
    const r = await dualVerify({ question: 'q', helixAnswer: 'a' },
      deps({ config: enabled(), echo: disabledEcho, runner: async () => ({ ok: false, error: 'timeout' }) }));
    expect(r.ran).toBe(false);
    expect(r.attempted).toBe(true);
    expect(r.egress?.decision).toBe('pass');
  });
});

describe('dualVerify: outcome + promptSent (for opt-in content logging)', () => {
  const expectOutcome = (got: CodexOutcome | undefined, want: CodexOutcome) => expect(got).toBe(want);

  it('disabled -> outcome skipped, no promptSent', async () => {
    const r = await dualVerify({ question: 'q', helixAnswer: 'a' }, deps({}));
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
      { question: 'is this key live?', helixAnswer: 'key is sk-ant-api03-Ab12Cd34Ef56Gh78Ij90Kl12Mn34' },
      deps({ config: enabled() }));
    expectOutcome(r.outcome, 'refused');
    expect(r.promptSent).toBeUndefined();
  });

  it('codex unavailable -> outcome unavailable, no promptSent', async () => {
    const r = await dualVerify({ question: 'q', helixAnswer: 'a' },
      deps({ config: enabled(), checkAvailable: async () => ({ available: false, reason: 'not logged in' }) }));
    expectOutcome(r.outcome, 'unavailable');
    expect(r.promptSent).toBeUndefined();
  });

  it('runner failed -> outcome error, no promptSent', async () => {
    const r = await dualVerify({ question: 'q', helixAnswer: 'a' },
      deps({ config: enabled(), runner: async () => ({ ok: false, error: 'codex produced no output' }) }));
    expectOutcome(r.outcome, 'error');
    expect(r.promptSent).toBeUndefined();
  });

  it('compare success -> outcome sent, promptSent equals the bare question', async () => {
    const r = await dualVerify({ question: 'which db?', helixAnswer: 'use postgres' },
      deps({ config: enabled(), runner: async () => ({ ok: true, answer: 'use postgres' }) }));
    expectOutcome(r.outcome, 'sent');
    expect(r.promptSent).toBe('which db?');
  });

  it('critique success -> outcome sent, promptSent equals the critique prompt (contains question + answer)', async () => {
    const critiqueCfg: HelixConfig =
      { dualVerify: { enabled: true, mode: 'critique', stakesFloor: 'high', model: null, effort: null, timeoutMs: 120_000, egressPolicy: { memoryEcho: 'block', piiHigh: 'block', piiBulk: 'block', secretHeuristic: 'block', secretEntropy: 'block' }, logContent: false }, metrics: { enabled: true } };
    const r = await dualVerify({ question: 'which db?', helixAnswer: 'use postgres' },
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
});
