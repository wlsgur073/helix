import { describe, it, expect } from 'vitest';
import { MEMORY_ID } from '../../src/server/helix-server.js';

describe('MEMORY_ID shared id schema (audit-id finding)', () => {
  it('accepts real m_<uuid> ids and marker-shaped ids', () => {
    expect(MEMORY_ID.safeParse('m_123e4567-e89b-12d3-a456-426614174000').success).toBe(true);
    expect(MEMORY_ID.safeParse('witness_fence_3_0123456789abcdef0123456789abcdef').success).toBe(true);
  });

  it('refuses control bytes, format characters, whitespace, empty and oversized ids', () => {
    expect(MEMORY_ID.safeParse('m_ab\u0000cd').success).toBe(false); // NUL
    expect(MEMORY_ID.safeParse('m_ab\u202Ecd').success).toBe(false); // RTL override (Cf)
    expect(MEMORY_ID.safeParse('m_ab\tcd').success).toBe(false); // tab (Cc)
    expect(MEMORY_ID.safeParse('AKIA IOSFODNN7EXAMPLE').success).toBe(false); // whitespace
    expect(MEMORY_ID.safeParse('').success).toBe(false);
    expect(MEMORY_ID.safeParse('x'.repeat(201)).success).toBe(false);
  });
});
