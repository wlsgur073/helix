import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ledgerDigest, subkeyFingerprint, keyVectorEqual, KEY_ABSENT, type ScopeKeyComponent } from '../src/memory/recall-cache.js';

describe('recall-cache key primitives', () => {
  it('ledgerDigest is stable per bytes and changes on any byte change', () => {
    const a = Buffer.from('deploy timeout config', 'utf8');
    const b = Buffer.from('deploy timexxx config', 'utf8');   // same length, one word changed
    expect(a.length).toBe(b.length);
    expect(ledgerDigest(a)).toBe(ledgerDigest(Buffer.from('deploy timeout config', 'utf8')));
    expect(ledgerDigest(a)).not.toBe(ledgerDigest(b));
    expect(ledgerDigest(Buffer.alloc(0))).toHaveLength(64);   // hex sha256 of empty
  });

  it('subkeyFingerprint hides the key, is stable, and sentinels on null', () => {
    const k = randomBytes(32);
    expect(subkeyFingerprint(k)).toBe(subkeyFingerprint(Buffer.from(k)));
    expect(subkeyFingerprint(k)).not.toBe(subkeyFingerprint(randomBytes(32)));
    expect(subkeyFingerprint(k)).not.toBe(k.toString('hex'));   // never the raw key
    expect(subkeyFingerprint(k)).toHaveLength(64);
    expect(subkeyFingerprint(null)).toBe(KEY_ABSENT);
    expect(KEY_ABSENT).not.toMatch(/^[0-9a-f]{64}$/);          // sentinel can never collide a real fingerprint
  });

  it('keyVectorEqual is true only for identical ordered vectors', () => {
    const base: ScopeKeyComponent[] = [{ scopeId: '/g', digest: 'd', fingerprint: 'f' }];
    expect(keyVectorEqual(base, [{ scopeId: '/g', digest: 'd', fingerprint: 'f' }])).toBe(true);
    expect(keyVectorEqual(base, [{ scopeId: '/g', digest: 'D', fingerprint: 'f' }])).toBe(false);
    expect(keyVectorEqual(base, [{ scopeId: '/g', digest: 'd', fingerprint: 'F' }])).toBe(false);
    expect(keyVectorEqual(base, [{ scopeId: '/p', digest: 'd', fingerprint: 'f' }])).toBe(false);
    expect(keyVectorEqual(base, [...base, { scopeId: '/p', digest: 'd', fingerprint: 'f' }])).toBe(false);
  });
});
