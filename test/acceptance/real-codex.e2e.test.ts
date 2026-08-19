// Opt-in METERED acceptance: one real `codex exec` through the stdin + Windows-safe
// spawn path. Spends the user's Codex quota — gated behind HELIX_REAL_CODEX=1 so the
// normal suite never burns quota. Run manually:  HELIX_REAL_CODEX=1 npx vitest run test/acceptance/real-codex.e2e.test.ts
import { describe, it, expect } from 'vitest';
import { createCodexRunner, resolveCodexInvocation, checkCodexAvailable } from '../../src/verify/codex.js';

// 옵트인이 없으면 아래 블록은 스킵된다. 스킵이 유일한 신호이므로,
// `expect(enabled).toBe(false)`만 하는 짝 블록은 두지 않는다 — 기본 환경에서 실패할 수 없는
// 단언이 통과 건수에 집계되면 부재가 가려진다.
const enabled = process.env.HELIX_REAL_CODEX === '1';

describe.runIf(enabled)('real codex exec (metered, opt-in)', () => {
  it('answers a trivial prompt via stdin through the resolved launcher', async () => {
    const inv = await resolveCodexInvocation();
    expect(inv).not.toBeNull();
    const avail = await checkCodexAvailable(inv);
    expect(avail.available).toBe(true);

    const run = createCodexRunner();
    const res = await run('Reply with exactly one word: pong');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.answer).toMatch(/pong/i);
  }, 180_000);
});
