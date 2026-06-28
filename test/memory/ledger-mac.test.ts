import { describe, it, expect } from 'vitest';
import { digestContent } from '../../src/memory/ledger-mac.js';

describe('digestContent', () => {
  it('is a stable lowercase hex sha-256 over the UTF-8 bytes', () => {
    expect(digestContent('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
  it('is byte-sensitive: any change flips the digest', () => {
    expect(digestContent('a')).not.toBe(digestContent('A'));
  });
});
