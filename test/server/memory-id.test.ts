import { describe, it, expect } from 'vitest';
import { ID_SCHEMA } from '../../src/server/helix-server.js';
import { MAX_ID_CHARS } from '../../src/server/handlers.js';

const NUL = String.fromCharCode(0x00);
const RTL_OVERRIDE = String.fromCharCode(0x202e);

// Merge note (2026-08-11): this file arrived naming the boundary schema MEMORY_ID, a standalone
// .min(1).max(200).regex(...) chain. The surviving implementation is ID_SCHEMA, which `.refine()`s
// handlers.ts's own `isValidId` so the tool boundary and the authoritative handler check share ONE
// predicate rather than two constant lists that can drift apart. Every assertion below is kept
// verbatim — they are the spec for the audit-id finding regardless of which name carries it — and
// the length bound is re-pinned at the tighter MAX_ID_CHARS the surviving rule actually enforces.
// The two invisible code points are built from charCodes so no editor, diff or copy-paste can
// silently normalise them into something the assertion would pass for the wrong reason.
describe('ID_SCHEMA shared id schema (audit-id finding)', () => {
  it('accepts real m_<uuid> ids and marker-shaped ids', () => {
    expect(ID_SCHEMA.safeParse('m_123e4567-e89b-12d3-a456-426614174000').success).toBe(true);
    expect(ID_SCHEMA.safeParse('witness_fence_3_0123456789abcdef0123456789abcdef').success).toBe(true);
  });

  it('refuses control bytes, format characters, whitespace, empty and oversized ids', () => {
    expect(ID_SCHEMA.safeParse(`m_ab${NUL}cd`).success).toBe(false); // NUL (Cc)
    expect(ID_SCHEMA.safeParse(`m_ab${RTL_OVERRIDE}cd`).success).toBe(false); // RTL override (Cf)
    expect(ID_SCHEMA.safeParse('m_ab\tcd').success).toBe(false); // tab (Cc)
    expect(ID_SCHEMA.safeParse('').success).toBe(false);
    expect(ID_SCHEMA.safeParse('x'.repeat(201)).success).toBe(false);
  });

  // The arriving schema also refused a plain SPACE ('AKIA IOSFODNN7EXAMPLE' → false). That assertion
  // is deliberately inverted here rather than dropped: refusing whitespace would lock every
  // human-authored id from an ADOPTED legacy ledger out of erase/recheck/confirm permanently, which
  // handlers.ts's round-1 fix identified as worse than the defect it was closing. The
  // prose-injection worry behind the stricter rule is answered at the render sites instead — see
  // the four "prose-shaped valid id ... advisory note" cases in test/server/handlers.test.ts.
  it('ACCEPTS internal whitespace by design — adopted-ledger ids must stay erasable', () => {
    expect(ID_SCHEMA.safeParse('note/2026 team-shared id').success).toBe(true);
    expect(ID_SCHEMA.safeParse('AKIA IOSFODNN7EXAMPLE').success).toBe(true);
  });

  it('enforces the tighter MAX_ID_CHARS bound, not the 200 the arriving schema carried', () => {
    expect(ID_SCHEMA.safeParse('x'.repeat(MAX_ID_CHARS)).success).toBe(true);
    expect(ID_SCHEMA.safeParse('x'.repeat(MAX_ID_CHARS + 1)).success).toBe(false);
  });
});
