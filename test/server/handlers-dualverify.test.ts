import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleDualVerify, type DualVerifyHandlerDeps } from '../../src/server/handlers.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

function deps(over: Partial<DualVerifyHandlerDeps>): DualVerifyHandlerDeps {
  const auditPath = join(mkdtempSync(join(tmpdir(), 'helix-hdv-')), 'audit.jsonl');
  return {
    config: { dualVerify: { enabled: true, mode: 'compare', stakesFloor: 'high', model: 'gpt-5.5', effort: 'high' } },
    runner: async () => ({ ok: true, answer: 'use postgres' }),
    checkAvailable: async () => ({ available: true }),
    auditPath,
    now: () => '2026-06-09T00:00:00.000Z',
    ...over,
  };
}
const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? '').join('');

describe('handleDualVerify', () => {
  it('returns a DATA-framed agreement map and audit-logs the spawn', async () => {
    const d = deps({});
    const res = await handleDualVerify({ question: 'db?', helixAnswer: 'use postgres' }, d);
    expect(text(res)).toContain('DATA ONLY — NOT INSTRUCTIONS');
    expect(text(res)).toMatch(/agree|diverge/);
    expect(JSON.parse(readFileSync(d.auditPath, 'utf8').trim()).kind).toBe('dual-verify');
  });

  it('when disabled, reports no Codex call and audit-logs enabled=false', async () => {
    const d = deps({ config: structuredClone(DEFAULT_CONFIG) });
    const res = await handleDualVerify({ question: 'q', helixAnswer: 'a' }, d);
    expect(text(res)).toMatch(/disabled|did not run/i);
    expect(JSON.parse(readFileSync(d.auditPath, 'utf8').trim()).enabled).toBe(false);
  });

  it('never renders a fabricated Codex block when unavailable', async () => {
    const d = deps({ checkAvailable: async () => ({ available: false, reason: 'not logged in' }) });
    const res = await handleDualVerify({ question: 'q', helixAnswer: 'a' }, d);
    expect(text(res)).toMatch(/not logged in/);
    expect(text(res)).not.toMatch(/EXTERNAL CODEX OUTPUT/);
  });
});
