import { describe, it, expect, vi } from 'vitest';

// Contract 1. bootInstantMs must not depend on the proc filesystem, so every /proc read throws
// here — which is what a host without /proc does. This lives in its OWN FILE because
// lock-liveness.test.ts exercises startTicksOf, stateOf and bootId, which all read /proc for real.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    readFileSync: (p: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.startsWith('/proc/')) {
        throw Object.assign(new Error('ENOENT: no proc filesystem'), { code: 'ENOENT' });
      }
      return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

describe('bootInstantMs without /proc (contract 1)', () => {
  it('still returns a number on an allowlisted platform', async () => {
    const { realProbe } = await import('../../src/memory/lock-liveness.js');
    expect(typeof realProbe.bootInstantMs()).toBe('number');   // this host is linux
  });
});
