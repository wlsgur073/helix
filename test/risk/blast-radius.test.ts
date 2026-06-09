import { describe, it, expect } from 'vitest';
import { classifyAction, type ActionDescriptor } from '../../src/risk/blast-radius.js';

const a = (p: Partial<ActionDescriptor>): ActionDescriptor => ({ kind: 'read', ...p });

describe('classifyAction', () => {
  it('reads are read-only', () => {
    expect(classifyAction(a({ kind: 'read' }))).toBe('read-only');
  });
  it('local file writes are local-reversible', () => {
    expect(classifyAction(a({ kind: 'write', target: '/proj/file.ts' }))).toBe('local-reversible');
  });
  it('shell exec is hard-to-reverse (fail-safe)', () => {
    expect(classifyAction(a({ kind: 'exec', command: 'git reset --hard' }))).toBe('hard-to-reverse');
    expect(classifyAction(a({ kind: 'exec', command: 'rm -rf node_modules' }))).toBe('hard-to-reverse');
  });
  it('network / external spends are external', () => {
    expect(classifyAction(a({ kind: 'spawn', command: 'codex exec ...' }))).toBe('external');
    expect(classifyAction(a({ kind: 'network', target: 'https://api' }))).toBe('external');
  });
  it('unknown shapes fail safe to hard-to-reverse (never read-only)', () => {
    expect(classifyAction(a({ kind: 'mystery' as ActionDescriptor['kind'] }))).toBe('hard-to-reverse');
  });
});
