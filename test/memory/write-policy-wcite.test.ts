// W-CITE: the write path redacts every high-entropy token, so a citation, dated path, or note
// slug cannot be remembered — measured at 53/53 live memory files, 293 spans, 157 of the 158
// exemption-shaped spans being word chains (design + Codex reconciliation:
// docs/issues/2026-08-05-provenance-trust-and-citation-egress-design.md Part 3; falsifier run
// 2026-09-01: 0 of 7 real values on this box would be released). The shipped repair: an
// entropy-only benign word chain is PERSISTED VERBATIM on the write path — hex keeps redacting
// (the native representation of random secret material), any named/heuristic overlap keeps
// redacting (deny-dominant `tiers` read), and a credential keyword in the same statement vetoes
// the release (nearCredential, the single shared definition). `secret-redacted` is set only when
// a span was actually replaced, so an all-exempt record keeps the caller's classification.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { loadConfig } from '../../src/config.js';
import { buildRankArtifacts, rankWithArtifacts } from '../../src/memory/retrieval.js';
import type { MemoryRecord } from '../../src/types.js';

function storeAt(opts: Record<string, unknown> = {}): MemoryStore {
  const home = mkdtempSync(join(tmpdir(), 'helix-wcite-'));
  return new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 's1', ...opts });
}

// A fictional path, deliberately NOT a real private-workspace path: the output-vocabulary lock
// forbids tracked files citing that tree, and it caught the first version of this fixture.
const SPEC_PATH = 'notes/archive/2026-08-09-helix-feedback-merge-design.md';
const HEX_SHA = '3bd63d0aa11f8ee35410dddf5dd9a57b25536f5e';

describe('W-CITE: the write path releases entropy-only benign word chains', () => {
  it('a dated spec path persists verbatim and the record stays classification normal', () => {
    const rec = storeAt().commit({ content: `the spec at ${SPEC_PATH} is ratified`, source: 'user' });
    expect(rec.content).toContain(SPEC_PATH);
    expect(rec.content).not.toContain('[redacted:');
    expect(rec.classification).toBe('normal');
  });

  it('an all-exempt record keeps the caller classification (personal survives)', () => {
    const rec = storeAt().commit({ content: `my notes live at ${SPEC_PATH}`, source: 'user', classification: 'personal' });
    expect(rec.classification).toBe('personal');
  });

  it('a source citation with a line reference persists verbatim', () => {
    const rec = storeAt().commit({ content: 'the consumer is scripts/pilot/run-pilot.ts:256 in the frozen surface', source: 'user' });
    expect(rec.content).toContain('scripts/pilot/run-pilot.ts:256');
  });

  it('mixed content: hex is replaced, the word chain survives, classification flags the redaction', () => {
    const rec = storeAt().commit({ content: `deployed ${HEX_SHA} per ${SPEC_PATH}`, source: 'user' });
    expect(rec.content).toContain(SPEC_PATH);
    expect(rec.content).not.toContain(HEX_SHA);
    expect(rec.content).toContain('[redacted:');
    expect(rec.classification).toBe('secret-redacted');
  });

  it('control: a pure-hex token still redacts and flags', () => {
    const rec = storeAt().commit({ content: `deployed ${HEX_SHA} to prod`, source: 'user' });
    expect(rec.content).not.toContain(HEX_SHA);
    expect(rec.classification).toBe('secret-redacted');
  });

  it('control: a credential keyword in the same statement vetoes the release', () => {
    const rec = storeAt().commit({ content: 'the password vault moved to docs/keys/2026-vault-recovery.md today', source: 'user' });
    expect(rec.content).not.toContain('docs/keys/2026-vault-recovery.md');
    expect(rec.classification).toBe('secret-redacted');
  });

  it('control: a named provider secret still redacts (deny-dominant tiers)', () => {
    const rec = storeAt().commit({ content: 'aws key AKIAIOSFODNN7EXAMPLE was rotated', source: 'user' });
    expect(rec.content).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(rec.classification).toBe('secret-redacted');
  });

  it('releaseWordChains false restores unconditional entropy redaction', () => {
    const rec = storeAt({ releaseWordChains: false }).commit({ content: `the spec at ${SPEC_PATH} is ratified`, source: 'user' });
    expect(rec.content).not.toContain(SPEC_PATH);
    expect(rec.classification).toBe('secret-redacted');
  });
});

describe('W-CITE: persistence policy config key', () => {
  it('persistence.releaseWordChains parses from the config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helix-wcite-cfg-'));
    const g = join(dir, 'global.json');
    writeFileSync(g, JSON.stringify({ persistence: { releaseWordChains: false } }));
    const cfg = loadConfig({ projectPath: join(dir, 'nope.json'), globalPath: g });
    expect(cfg.persistence?.releaseWordChains).toBe(false);
  });

  it('the default is release (true), and an invalid value falls back to it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helix-wcite-cfg-'));
    const g = join(dir, 'global.json');
    writeFileSync(g, JSON.stringify({ persistence: { releaseWordChains: 'yes' } }));
    const cfg = loadConfig({ projectPath: join(dir, 'nope.json'), globalPath: g });
    expect(cfg.persistence?.releaseWordChains).toBe(true);
  });
});

describe('W-CITE: the redaction marker is not indexable', () => {
  const rec = (id: string, content: string): MemoryRecord => ({
    id, tx: '2026-09-01T00:00:00.000Z', validFrom: '2026-09-01T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content,
    provenance: { source: 'user', sessionId: 's1' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'secret-redacted',
  });

  it('the marker tokens do not hijack entropy-vocabulary queries', () => {
    const records = [rec('m_1', '[redacted:high-entropy] deploy note rewrite')];
    const hits = rankWithArtifacts(records, buildRankArtifacts(records), 'redacted high entropy');
    expect(hits).toHaveLength(0);
  });

  it('control: the record stays reachable by its real words', () => {
    const records = [rec('m_1', '[redacted:high-entropy] deploy note rewrite')];
    const hits = rankWithArtifacts(records, buildRankArtifacts(records), 'deploy note');
    expect(hits).toHaveLength(1);
  });
});
