// Pins the rendered read surfaces (recall/inspect proof lines) and the H6 echo-exemption pair against
// the SHIPPED classifyEgress. Scoped to what it can honestly prove: a production record id is
// `m_<uuid>` (38 chars), itself a non-exempt high-entropy token, so a complete rendering carrying REAL
// ids is blocked whatever the digest separator — recorded in the design and ruled record-only, NOT a
// defect these tests exist to catch. Every case below therefore uses this repo's standard short-id
// fixture (`genId: () => \`m_${++n}\``, the idiom at test/server/handlers.test.ts), and the claim they
// pin is precise: the id/digest adornments this batch adds — the digest itself, its colon-space
// separator, and the proof line's shape — trip no secret leg on their own. The fourth case pins the
// opposite boundary: a generic label=<hex> pairing still blocks, so a later well-meaning widening of
// the EH-4 exemption reddens here instead of shipping silently.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { handleCommit, handleRecall, handleInspect } from '../../src/server/handlers.js';
import { classifyEgress } from '../../src/risk/trifecta.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { digestContent } from '../../src/memory/ledger-mac.js';
import * as contentFrameMod from '../../src/memory/content-frame.js';

const POLICY = DEFAULT_CONFIG.dualVerify.egressPolicy;
const ENTROPY_LEGS = new Set(['secretEntropy', 'secretEntropyExempt']);

// The frame nonce is randomBytes(16) in hex. About 1.8% of nonces hold a run of 13 to 19 decimal digits
// and one in ten of those passes the Luhn check, so about 0.18% make detectPII read a credit_card and
// classifyEgress block the rendering on piiHigh (EGRESS-NONCE-PII). handleRecall and handleInspect mint
// their own nonce and take no injection, so the cases that classify a framed rendering pin
// content-frame's newNonce. NONCE has no digit run longer than 4; CARD_NONCE is a 14-digit Luhn-valid run.
const NONCE = 'c3a9f0e57b2d4816a9e0d3b7f5c1428e';
const CARD_NONCE = '45391488034364fa3c9e07b52d148e6a';
function pinNonce(nonce: string): void {
  vi.spyOn(contentFrameMod, 'newNonce').mockReturnValue(nonce);
}
afterEach(() => { vi.restoreAllMocks(); });

function store(): MemoryStore {
  let n = 0;
  const home = mkdtempSync(join(tmpdir(), 'helix-render-egress-'));
  return new MemoryStore(join(home, 'm.jsonl'), {
    home, sessionId: 's1', now: () => '2026-06-09T00:00:00.000Z', genId: () => `m_${++n}`,
  });
}
const text = (res: { content: Array<{ type: string; text?: string }> }) => res.content.map((c) => c.text ?? '').join('');

// Anchors the PROOF line's shape (IT-M16): a `PROOF[...]| ` mark at the start of the line, the id, the
// literal ' contentDigest: ' separator, and 64 lowercase hex chars ending the line — the idiom
// test/memory/store.test.ts's H10 case uses for the library-level surface, generalized here to any
// PROOF bracket and any id shape.
const PROOF_LINE_RE = /^PROOF\[[^\]]+\]\| (\S+) contentDigest: ([0-9a-f]{64})$/m;

describe('the rendered read surfaces and the EH-4 boundary', () => {
  it('a complete recall rendering clears the entropy leg (short-id fixture)', () => {
    // Short ids on purpose. A production m_<uuid> is itself a non-exempt high-entropy token, so a
    // rendering carrying real ids blocks whatever the separator — recorded in the design, ruled
    // record-only, and NOT what this test claims. What it claims: the adornments this batch adds —
    // the digest, its colon-space separator, and the proof line's shape — trip no secret leg.
    const s = store();
    pinNonce(NONCE);
    handleCommit(s, { content: 'the office coffee rota moves to the third floor kitchen', source: 'user' });
    handleCommit(s, { content: 'the office plant watering schedule moves to Mondays', source: 'user' });
    const rendered = text(handleRecall(s, { query: 'office moves' }));
    expect(rendered).toContain(`===HELIX ${NONCE} END===`); // the pin reached the handler's own nonce
    // Sanity: both rows actually carry a proof line, so this exercises "several rows", not one.
    expect(rendered.match(/contentDigest: [0-9a-f]{64}/g)?.length).toBe(2);
    const v = classifyEgress({ texts: [rendered], outbound: rendered, ledger: null, policy: POLICY, quoted: [] });
    expect(v.decision).not.toBe('blocked');
    expect(v.blockedLegs.some((l) => ENTROPY_LEGS.has(l))).toBe(false);
  });

  it('a complete inspect rendering clears the entropy leg (short-id fixture)', () => {
    const s = store();
    pinNonce(NONCE);
    handleCommit(s, { content: 'the office coffee rota moves to the third floor kitchen', source: 'user' });
    handleCommit(s, { content: 'the office plant watering schedule moves to Mondays', source: 'user' });
    const rendered = text(handleInspect(s, {}));
    expect(rendered).toContain(`===HELIX ${NONCE} END===`);
    expect(rendered.match(/contentDigest: [0-9a-f]{64}/g)?.length).toBe(2);
    const v = classifyEgress({ texts: [rendered], outbound: rendered, ledger: null, policy: POLICY, quoted: [] });
    expect(v.decision).not.toBe('blocked');
    expect(v.blockedLegs.some((l) => ENTROPY_LEGS.has(l))).toBe(false);
  });

  it('a frame nonce that reads as a card number blocks the rendering on piiHigh (why the cases above pin theirs)', () => {
    const s = store();
    pinNonce(CARD_NONCE);
    handleCommit(s, { content: 'the office coffee rota moves to the third floor kitchen', source: 'user' });
    const rendered = text(handleRecall(s, { query: 'office moves' }));
    expect(rendered).toContain(`===HELIX ${CARD_NONCE} END===`); // the precondition: the card-shaped nonce is in the text
    const v = classifyEgress({ texts: [rendered], outbound: rendered, ledger: null, policy: POLICY, quoted: [] });
    expect(v.decision).toBe('blocked');
    expect(v.blockedLegs).toContain('piiHigh');
  });

  it('an {id, contentDigest} pair parsed out of a recall rendering resolves against the guard ledger', () => {
    // Parse the proof line, declare the pair as quotedMemory, and observe the echo exemption.
    const s = store();
    const content = 'the payments service now writes to the green replica cluster in the secondary region';
    handleCommit(s, { content, source: 'user' });
    const rendered = text(handleRecall(s, { query: 'payments service writes' }));
    const m = PROOF_LINE_RE.exec(rendered);
    expect(m, 'no id+digest proof line on the recall rendering').not.toBeNull();
    const [, id, contentDigest] = m!;
    // Mirror the PRODUCTION ledger construction (src/server/helix-server.ts, src/server/index.ts),
    // not an invented shape.
    const ledger = s.inspect().map(({ record, contentDigest: cd }) => ({
      id: record.id, content: record.content, contentDigest: cd ?? digestContent(record.content),
    }));
    const exempted = classifyEgress({
      texts: [content], outbound: content, ledger, policy: POLICY, quoted: [{ id: id!, contentDigest: contentDigest! }],
    });
    expect(exempted.echoExemptIds).toContain(id);
    expect(exempted.decision).not.toBe('blocked');
    // Negative half (non-vacuity control): the identical call WITHOUT the declaration is blocked on
    // the echo leg — this is what proves the positive half above actually exercises the exemption.
    const undeclared = classifyEgress({ texts: [content], outbound: content, ledger, policy: POLICY, quoted: [] });
    expect(undeclared.decision).toBe('blocked');
    expect(undeclared.blockedLegs).toContain('memoryEcho');
  });

  it('a generic label=<hex> is still BLOCKED on the entropy leg — the EH-4 boundary is not widened', () => {
    // `contentDigest=<hex>` is the exact shape this batch measured as blocked, which is why the
    // rendered proof line uses a colon-space separator instead — so it is the boundary a later
    // exemption must not cross. A credential-keyword label (`apiKey=`) would block on the unrelated
    // heuristic leg regardless of the hex, so a widened hex exemption could never redden that case;
    // and an all-same-letter hex core carries no digit, so the entropy detector never fires on it at
    // all. A REAL digest under this NON-credential label is what actually exercises the entropy leg.
    const hex = digestContent('any content');
    const v = classifyEgress({ texts: [`contentDigest=${hex}`], outbound: `contentDigest=${hex}`, ledger: null, policy: POLICY, quoted: [] });
    expect(v.decision).toBe('blocked');
    expect(v.blockedLegs).toContain('secretEntropy');
  });
});
