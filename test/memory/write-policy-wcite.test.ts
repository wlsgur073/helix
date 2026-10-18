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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

// IT-M3 (second fix batch §4.6 item 1), Review Focus: `redactions` counts what the commit actually
// REPLACED, per kind — the write-policy selection — never every span the scan found. A released word
// chain is a span the scan finds and the default policy keeps verbatim, so beside a redacted hex token
// only the hex token is counted; with persistence.releaseWordChains false both spans are replaced and
// both are counted (measured on the prototype: {"high-entropy":1}, then {"high-entropy":2}).
describe('IT-M3: commitScoped counts what the commit actually replaced, per kind', () => {
  const content = `deployed ${HEX_SHA} per ${SPEC_PATH}`;

  it('the default policy counts the hex token and not the released word chain', () => {
    const out = storeAt().commitScoped({ content, source: 'user' });
    expect(out.record.content).toContain(SPEC_PATH);
    expect(out.redactions).toEqual({ 'high-entropy': 1 });
  });

  it('releaseWordChains false replaces both spans and counts both', () => {
    const out = storeAt({ releaseWordChains: false }).commitScoped({ content, source: 'user' });
    expect(out.record.content).toBe('deployed [redacted:high-entropy] per [redacted:high-entropy]');
    expect(out.redactions).toEqual({ 'high-entropy': 2 });
  });

  it('two kinds are counted apart, and a commit that replaced nothing has no redactions field', () => {
    const two = storeAt().commitScoped({ content: `aws key AKIAIOSFODNN7EXAMPLE and tag ${HEX_SHA}`, source: 'user' });
    expect(two.redactions).toEqual({ 'aws-access-key': 1, 'high-entropy': 1 });
    expect(storeAt().commitScoped({ content: `the spec at ${SPEC_PATH} is ratified`, source: 'user' })).not.toHaveProperty('redactions');
  });

  it('a marker the fact already carried is not counted: only the span this commit replaced', () => {
    const out = storeAt().commitScoped({ content: `the log line reads [redacted:token] and the build is ${HEX_SHA}`, source: 'user' });
    expect(out.record.content).toBe('the log line reads [redacted:token] and the build is [redacted:high-entropy]');
    expect(out.redactions).toEqual({ 'high-entropy': 1 });
  });
});

// Issue #5: a fact that names its file the Windows way, or quotes a setting, is persisted as written
// (measured on 862e13d: every one of these was stored as [redacted:high-entropy]). The controls keep
// a random token, a credential-named setting and a credential keyword nearby redacting, and
// persistence.releaseWordChains false redacts the wider shapes as before.
describe('issue #5: the write path keeps Windows paths and NAME=value settings', () => {
  for (const content of [
    'set `PYTHONIOENCODING=utf-8` before printing',
    'set "PYTHONIOENCODING=utf-8" before printing',
    'run node with --max-old-space-size=4096 for big builds',
    'set JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8 for the JVM',
    'the build config is C:\\Users\\dev\\projects\\app2\\src\\main.ts on this box',
    'the build config is C:/Users/dev/projects/app2/src/main.ts on this box',
    'the build config is projects\\app2\\src\\main.ts on this box',
    'the hosts file is C:\\Windows\\System32\\drivers\\etc\\hosts on this box',
    'the Maven settings are in %USERPROFILE%\\.m2\\settings.xml on this box',
  ]) {
    it(`persists verbatim: ${content}`, () => {
      const out = storeAt().commitScoped({ content, source: 'agent-inference' });
      expect(out.record.content).toBe(content);
      expect(out.record.classification).toBe('normal');
      expect(out).not.toHaveProperty('redactions');
    });
  }

  it('a path whose only digit is fullwidth is judged on its folded form, and persists as written', () => {
    // The raw token has no ASCII digit, so only the folded scan (F6) puts it in the entropy net, and
    // the write path's chain test must be asked of that folded form as well.
    const content = 'the build config is C:\\Users\\dev\\projects\\app\uFF12\\main.ts on this box';
    const out = storeAt().commitScoped({ content, source: 'agent-inference' });
    expect(out.record.content).toBe(content);
    expect(out).not.toHaveProperty('redactions');
  });

  it('control: a random token still redacts', () => {
    const out = storeAt().commitScoped({ content: 'the synthetic token Zx9Qv4Lm2Rt7Kp1Wc8Ny5Hb3 is not a real secret', source: 'agent-inference' });
    expect(out.record.content).toBe('the synthetic token [redacted:high-entropy] is not a real secret');
  });

  it('control: a setting whose name carries a credential word still redacts', () => {
    const out = storeAt().commitScoped({ content: 'the value AUTH_TOKEN=blue-sky-2024-mango-kiwi was set', source: 'agent-inference' });
    expect(out.record.content).toBe('the value [redacted:high-entropy] was set');
    expect(out.redactions).toEqual({ 'high-entropy': 1 });
  });

  it('control: a passphrase behind a short credential name and a padded base64 value still redact', () => {
    const out = storeAt().commitScoped({ content: 'set ADMIN_PW=correct-horse-battery-2024 and the blob Sb6/TpCTGo/OhIheobTuig== now', source: 'agent-inference' });
    expect(out.record.content).toBe('set [redacted:high-entropy] and the blob [redacted:high-entropy] now');
    expect(out.redactions).toEqual({ 'high-entropy': 2 });
  });

  it('control: a credential keyword in the same statement still vetoes the release', () => {
    const out = storeAt().commitScoped({ content: 'the password file is C:\\Users\\dev\\vault\\app2\\pw.txt now', source: 'agent-inference' });
    expect(out.record.content).toBe('the password file is [redacted:high-entropy] now');
  });

  it('releaseWordChains false redacts a Windows path as before', () => {
    const out = storeAt({ releaseWordChains: false }).commitScoped({ content: 'the hosts file is C:\\Windows\\System32\\drivers\\etc\\hosts here', source: 'agent-inference' });
    expect(out.record.content).toBe('the hosts file is [redacted:high-entropy] here');
  });

  it("a backslash path stored verbatim binds a file-contains recheck (the issue's R3)", () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-i5-'));
    const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 's1' });
    const rel = 'app2\\config\\dev\\notes.txt';
    const cwd = process.cwd();
    process.chdir(home);
    try {
      // A nested file on Windows; elsewhere one file whose name holds the backslashes.
      mkdirSync(join(home, 'app2', 'config', 'dev'), { recursive: true });
      writeFileSync(join(home, rel), 'always use the dry run flag\n');
      const a = store.commit({ content: `the file ${rel} contains the line: always use the dry run flag`, source: 'user-relayed' });
      expect(a.content).toContain(rel);
      const r = store.recheck(a.id, { kind: 'file-contains', path: rel, pattern: 'dry run flag' });
      expect(r.result).toEqual({ kind: 'state', state: 'Corroborated' });
    } finally {
      process.chdir(cwd);
    }
  });
});
