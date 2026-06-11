import { describe, it, expect } from 'vitest';
import { dualVerify, type DualVerifyDeps } from '../../src/verify/dual-verify.js';
import { DEFAULT_CONFIG, type HelixConfig } from '../../src/config.js';

function deps(over: Partial<DualVerifyDeps>): DualVerifyDeps {
  return {
    config: structuredClone(DEFAULT_CONFIG),
    runner: async () => ({ ok: true, answer: 'the answer is 4' }),
    checkAvailable: async () => ({ available: true }),
    ...over,
  };
}
const enabled = (): HelixConfig => ({ dualVerify: { enabled: true, mode: 'compare', stakesFloor: 'high', model: 'gpt-5.5', effort: 'high' } });

describe('dualVerify', () => {
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
    let seen: { model?: string | null; effort?: string | null } | undefined;
    await dualVerify({ question: 'q', helixAnswer: 'a' }, deps({
      config: { dualVerify: { enabled: true, mode: 'compare', stakesFloor: 'high', model: 'gpt-5.5', effort: 'xhigh' } },
      runner: async (_q, opts) => { seen = opts; return { ok: true, answer: 'x' }; },
    }));
    expect(seen).toEqual({ model: 'gpt-5.5', effort: 'xhigh' });
  });
});

describe('critique mode', () => {
  const critiqueCfg = (): HelixConfig =>
    ({ dualVerify: { enabled: true, mode: 'critique', stakesFloor: 'high', model: null, effort: null } });

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
