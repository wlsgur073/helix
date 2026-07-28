import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { qualifiedId, probeUniverse, countLedgerRows, corpusPrecondition, assertScopeParticipated } from '../../scripts/pilot/candidate-universe.js';

describe('qualifiedId', () => {
  it('joins scope and record id into the rule\'s (scope, record-id) exposure unit', () => {
    expect(qualifiedId('project', 'm_e15e4482-8f83-4d0d-8132-59be1ab792a7'))
      .toBe('project:m_e15e4482-8f83-4d0d-8132-59be1ab792a7');
    expect(qualifiedId('global', 'm_abc')).toBe('global:m_abc');
  });

  it('is splittable at the first colon (neither scope nor a record id contains one)', () => {
    const q = qualifiedId('global', 'm_abc');
    const cut = q.indexOf(':');
    expect(q.slice(0, cut)).toBe('global');
    expect(q.slice(cut + 1)).toBe('m_abc');
  });
});

describe('probeUniverse', () => {
  it('emits a sorted identity set, discarding recall order (rule §3: order is never recorded)', () => {
    // Deliberately supplied in "rank" order — the output must not preserve it.
    const universe = probeUniverse([
      { id: 'm_zzz', scope: 'project' },
      { id: 'm_aaa', scope: 'project' },
      { id: 'm_mmm', scope: 'global' },
    ]);
    expect(universe).toEqual(['global:m_mmm', 'project:m_aaa', 'project:m_zzz']);
  });

  it('carries the scope, so the same bare id in either scope is a DIFFERENT identity', () => {
    // Note these are two separate one-candidate recalls. A single recall containing both is a
    // corpus defect, refused by the precondition below — not something this function resolves.
    expect(probeUniverse([{ id: 'm_x', scope: 'global' }])).toEqual(['global:m_x']);
    expect(probeUniverse([{ id: 'm_x', scope: 'project' }])).toEqual(['project:m_x']);
  });

  it('is empty for an empty recall', () => {
    expect(probeUniverse([])).toEqual([]);
  });

  it('FAILS CLOSED on a duplicate record id — the scope tag cannot be trusted there', () => {
    // store.ts:523 keys its scope lookup by bare id (last wins), so under a colliding id BOTH
    // rows come back tagged with one scope. Emitting either tag would assert something the
    // code cannot justify, so the artifact refuses to be written.
    expect(() => probeUniverse([
      { id: 'm_dup', scope: 'global' },
      { id: 'm_dup', scope: 'project' },
    ])).toThrow(/candidate-id-collision/);
  });
});

describe('countLedgerRows', () => {
  // Rule §3 requires a FULL-SIZE recall. The bound is the physical row count, and since every live
  // record is one row, a correct bound can never truncate. The real hazard is the opposite: a bound
  // computed from a swallowed read error (classify-o67.ts:91 returns 0 for ANY failure), which
  // silently shrinks the recall. So the guard belongs on the read, not on the returned count.
  const dir = mkdtempSync(join(tmpdir(), 'universe-'));
  const row = (id: string) => JSON.stringify({ id, content: 'x' }) + '\n';

  it('counts the rows of a present ledger', () => {
    const p = join(dir, 'a.jsonl');
    writeFileSync(p, row('m_1') + row('m_2') + row('m_3'));
    expect(countLedgerRows(p)).toBe(3);
  });

  it('reports an ABSENT ledger as zero — a snapshot may legitimately have no global ledger', () => {
    expect(countLedgerRows(join(dir, 'does-not-exist.jsonl'))).toBe(0);
  });

  it('FAILS CLOSED on a ledger that exists but cannot be read — the silent-zero hazard', () => {
    const unreadable = join(dir, 'is-a-directory.jsonl');
    mkdirSync(unreadable, { recursive: true });
    expect(() => countLedgerRows(unreadable)).toThrow(/ledger-unreadable/);
  });

});

describe('corpusPrecondition', () => {
  // The per-probe collision guard sits BEHIND recall's relevance filter (retrieval.ts:373), so when
  // only one copy of a colliding id survives, no duplicate is ever seen and the artifact emits the
  // scope of the copy that did NOT survive. Identity uniqueness is a property of the CORPUS, so it
  // is checked once, up front, over the ledgers themselves.
  const dir = mkdtempSync(join(tmpdir(), 'corpus-'));
  const ledger = (name: string, ids: string[]) => {
    const p = join(dir, name);
    writeFileSync(p, ids.map((id) => JSON.stringify({ id, content: 'x' })).join('\n') + '\n');
    return p;
  };

  it('returns the recall bound and the per-scope row counts', () => {
    const g = ledger('g1.jsonl', ['m_a']);
    const p = ledger('p1.jsonl', ['m_b', 'm_c']);
    expect(corpusPrecondition([{ scope: 'global', path: g }, { scope: 'project', path: p }]))
      .toEqual({ bound: 3, rowsByScope: { global: 1, project: 2 } });
  });

  it('FAILS CLOSED on an id shared across scopes, even though no single recall need show both', () => {
    const g = ledger('g2.jsonl', ['m_dup']);
    const p = ledger('p2.jsonl', ['m_dup', 'm_other']);
    expect(() => corpusPrecondition([{ scope: 'global', path: g }, { scope: 'project', path: p }]))
      .toThrow(/corpus-id-collision/);
  });

  it('tolerates an absent scope ledger but refuses a corpus with no rows at all', () => {
    const g = ledger('g3.jsonl', ['m_a']);
    expect(corpusPrecondition([{ scope: 'global', path: g }, { scope: 'project', path: join(dir, 'absent.jsonl') }]))
      .toEqual({ bound: 1, rowsByScope: { global: 1, project: 0 } });
    expect(() => corpusPrecondition([{ scope: 'global', path: join(dir, 'none.jsonl') }]))
      .toThrow(/empty-recall-bound/);
  });

  it('FAILS CLOSED on a ledger that exists but cannot be read', () => {
    const bad = join(dir, 'unreadable-dir.jsonl');
    mkdirSync(bad, { recursive: true });
    expect(() => corpusPrecondition([{ scope: 'global', path: bad }])).toThrow(/ledger-unreadable/);
  });
});

describe('assertScopeParticipated', () => {
  // Rule §6 line 103 prescribes "snapshot the cutoff corpus" at window close — and ownership is
  // keyed on the canonical ABSOLUTE path, so that very copy un-adopts the project scope. The rows
  // still count toward the bound while contributing nothing, which is the exact state the artifact
  // must never record as if it were a small corpus.
  it('accepts an owned project scope whose rows are in the bound', () => {
    expect(() => assertScopeParticipated({ global: 1, project: 25 }, 'owned')).not.toThrow();
  });

  it('accepts a corpus with no project ledger at all', () => {
    expect(() => assertScopeParticipated({ global: 1, project: 0 }, 'inactive')).not.toThrow();
  });

  it('FAILS CLOSED when project rows were counted but the scope did not participate', () => {
    expect(() => assertScopeParticipated({ global: 1, project: 25 }, 'unadopted-present'))
      .toThrow(/scope-did-not-participate/);
    expect(() => assertScopeParticipated({ global: 1, project: 25 }, 'inactive'))
      .toThrow(/scope-did-not-participate/);
  });
});
