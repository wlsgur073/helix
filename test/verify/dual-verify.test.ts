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
const enabled = (): HelixConfig => ({ dualVerify: { enabled: true, mode: 'compare', stakesFloor: 'high' } });

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
});
