// The supersede gate had NO test anywhere. It reads two fields to decide whether one record may
// replace another, and both are caller-supplied and outside the MAC:
//
//   const targetIsAuthoritative = isVerifyingSource(target.provenance.source) || target.state === 'Verified';
//   if (targetIsAuthoritative && !isVerifyingSource(source)) throw ...
//
// These cases pin what it actually does today, including the hole, so the fix has a baseline to move
// against. `state` IS MAC-covered; `provenance.source` is not, on either side of the comparison.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';

function store() {
  const home = mkdtempSync(join(tmpdir(), 'helix-supersede-'));
  return new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's1' });
}

describe('supersede gate — what it protects today', () => {
  it('refuses an agent-inference commit superseding a Verified fact', () => {
    const s = store();
    const a = s.commit({ content: 'the prod database is db.prod.internal', source: 'user' });
    s.confirm(a.id); // genuine signed verify -> state Verified, MAC-covered
    expect(() => s.commit({ content: 'the prod database is evil.example', source: 'agent-inference', supersedes: a.id }))
      .toThrow(/cannot supersede an authoritative fact/);
  });

  it('refuses an agent-inference commit superseding a user-claimed Fresh fact', () => {
    const s = store();
    const a = s.commit({ content: 'the staging host is stg.internal', source: 'user' });
    // still Fresh — never confirmed. Its ONLY protection is the unauthenticated provenance disjunct.
    expect(() => s.commit({ content: 'the staging host is evil.example', source: 'agent-inference', supersedes: a.id }))
      .toThrow(/cannot supersede an authoritative fact/);
  });

  it('allows an agent-inference commit superseding another agent-inference fact', () => {
    const s = store();
    const a = s.commit({ content: 'the cache ttl looks like 60s', source: 'agent-inference' });
    const b = s.commit({ content: 'the cache ttl is 300s', source: 'agent-inference', supersedes: a.id });
    expect(b.id).not.toBe(a.id);
  });

  // THE HOLE. `source` is a model-supplied enum on the ordinary commit tool, so declaring 'user' is
  // free. The gate therefore restrains only a caller that reports itself honestly — it is an accident
  // guard, not the authorization check its error message describes.
  it('DOCUMENTS THE HOLE: declaring source=user lets any caller supersede a Verified fact', () => {
    const s = store();
    const a = s.commit({ content: 'the prod database is db.prod.internal', source: 'user' });
    s.confirm(a.id);
    const b = s.commit({ content: 'the prod database is evil.example', source: 'user', supersedes: a.id });
    expect(b.id).not.toBe(a.id); // no throw: the gate was passed by a self-asserted claim
  });

  // The MAC does hold independently: replacement content cannot inherit the grade.
  it('a superseding commit never inherits the Verified grade', () => {
    const s = store();
    const a = s.commit({ content: 'the prod database is db.prod.internal', source: 'user' });
    s.confirm(a.id);
    const b = s.commit({ content: 'the prod database is db2.prod.internal', source: 'user', supersedes: a.id });
    const live = s.inspect().find((r) => r.record.id === b.id)!;
    expect(live.record.state).toBe('Fresh');
  });
});
