// Opt-in METERED acceptance: one real `codex exec` through the stdin + Windows-safe
// spawn path. Spends the user's Codex quota — gated behind HELIX_REAL_CODEX=1 so the
// normal suite never burns quota. Run manually:  HELIX_REAL_CODEX=1 npx vitest run test/acceptance/real-codex.e2e.test.ts
import { describe, it, expect } from 'vitest';
import { createCodexRunner, resolveCodexInvocation, checkCodexAvailable } from '../../src/verify/codex.js';

// Without the opt-in the block below is skipped. The skip is the only signal, so there is no
// companion block asserting `expect(enabled).toBe(false)`: an assertion that cannot fail in the
// default environment would count toward the pass total and hide the absence.
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
