import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherScopedRecords } from '../../src/hooks/session-start.js';
import { formatSessionStartContext } from '../../src/hooks/format-context.js';
import { UNADOPTED_LEDGER_NOTE } from '../../src/memory/content-frame.js';
import type { MemoryRecord, ScopedRecord } from '../../src/types.js';

const N = 'd'.repeat(32); // fixed test nonce

// B2: the SessionStart hook's unadopted-ledger disclosure note. format-context.ts:38 used to return
// '' on empty memory — that empty auto-load IS the misdiagnosis surface a foreign, unadopted ledger
// would otherwise hide behind, so the note must render EVEN THEN. session-start.ts computes the B1
// disposition via the SAME shared helper the store uses (ownership.ts's projectDispositionOf).

function foreignLedgerFixture(root: string): void {
  mkdirSync(join(root, '.helix'), { recursive: true });
  writeFileSync(join(root, '.helix', 'memory.jsonl'), JSON.stringify({
    id: 'm_foreign', tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content: 'foreign fact',
    provenance: { source: 'user', sessionId: 'x' }, supersedes: null, blastRadius: null,
    reverifyTrigger: null, classification: 'normal',
  }) + '\n');
}

function rec(over: Partial<MemoryRecord> & { content: string }): MemoryRecord {
  return {
    id: `m_${over.content.slice(0, 8)}`, tx: '2026-06-10T00:00:00.000Z',
    validFrom: '2026-06-10T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', provenance: { source: 'user', sessionId: 's1' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    ...over,
  };
}

describe('SessionStart hook unadopted-ledger disclosure (B2)', () => {
  it('renders the note ALONE when memory is empty and the project layer is unadopted-present', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-ssud-home-'));
    const proj = mkdtempSync(join(tmpdir(), 'helix-ssud-proj-'));
    try {
      foreignLedgerFixture(proj); // foreign, unowned project ledger present
      const globalLedger = join(home, 'memory.jsonl'); // never created -> zero global records

      const { records, integrityAvailable, projectDisposition } = gatherScopedRecords({ home, globalLedger, cwd: proj });
      expect(projectDisposition).toBe('unadopted-present');
      expect(records).toHaveLength(0); // the foreign row is excluded, not just clamped

      const out = formatSessionStartContext(records, N, {
        integrityAvailable, unadoptedPresent: projectDisposition === 'unadopted-present',
      });
      // Note-only output: no frame at all (there is nothing to frame), just the trusted advisory.
      expect(out).toBe(UNADOPTED_LEDGER_NOTE);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it('omits the note (returns "") when memory is empty and there is no unadopted project layer', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-ssud-home-'));
    try {
      const globalLedger = join(home, 'memory.jsonl');
      const { records, integrityAvailable, projectDisposition } = gatherScopedRecords({ home, globalLedger });
      expect(projectDisposition).toBe('inactive');
      const out = formatSessionStartContext(records, N, {
        integrityAvailable, unadoptedPresent: projectDisposition === 'unadopted-present',
      });
      expect(out).toBe('');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('renders the note AFTER the frame alongside real (populated) memory content', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-ssud-home-'));
    const proj = mkdtempSync(join(tmpdir(), 'helix-ssud-proj-'));
    try {
      foreignLedgerFixture(proj);
      const globalLedger = join(home, 'memory.jsonl');
      writeFileSync(globalLedger, JSON.stringify({
        id: 'm_real', tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
        type: 'assert', state: 'Fresh', content: 'real global fact survives the disclosure note',
        provenance: { source: 'user', sessionId: 's' },
        supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
      }) + '\n');

      const { records, integrityAvailable, projectDisposition } = gatherScopedRecords({ home, globalLedger, cwd: proj });
      expect(projectDisposition).toBe('unadopted-present');
      expect(records.length).toBeGreaterThan(0);

      const out = formatSessionStartContext(records, N, {
        integrityAvailable, unadoptedPresent: projectDisposition === 'unadopted-present',
      });
      expect(out).toContain('DATA[Fresh:global]| real global fact survives the disclosure note');
      expect(out).toContain(UNADOPTED_LEDGER_NOTE);
      // The note is a trusted advisory OUTSIDE the frame, like the integrity-unavailable note.
      const noteLine = out.split('\n').find((l) => l === UNADOPTED_LEDGER_NOTE)!;
      expect(noteLine).toBeDefined();
      const closeIdx = out.indexOf(`===HELIX ${N} END===`);
      expect(out.indexOf(UNADOPTED_LEDGER_NOTE)).toBeGreaterThan(closeIdx);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it('reserves the note outside the maxChars truncation accounting — a saturated context still carries it', () => {
    // Enough large records to fully saturate a small budget (the drop-loop will shed every line it
    // can). The note must still be present in the final output, even though the budget is tight.
    const many: ScopedRecord[] = Array.from({ length: 20 }, (_, i) =>
      ({ record: rec({ content: `long fact ${i} ${'x'.repeat(120)}`, id: `m_${i}` }), scope: 'global' }));
    const out = formatSessionStartContext(many, N, { maxChars: 300, unadoptedPresent: true });
    expect(out).toContain(UNADOPTED_LEDGER_NOTE);
    // Discriminating: with the flag off, the same saturated input never mentions the note.
    const outWithoutFlag = formatSessionStartContext(many, N, { maxChars: 300 });
    expect(outWithoutFlag).not.toContain(UNADOPTED_LEDGER_NOTE);
  });

  it('an internal read error yields no output at all — mirrors main()\'s fail-closed catch', () => {
    // gatherScopedRecords has NO try/catch around its top-level global-ledger read — a directory where
    // the ledger FILE should be makes readFileSync throw EISDIR (not the tolerated ENOENT), so the
    // function itself throws. main() wraps gatherScopedRecords + formatSessionStartContext + writeSync
    // in exactly ONE try/catch that swallows any error and writes nothing; reproduce that composition.
    const home = mkdtempSync(join(tmpdir(), 'helix-ssud-err-'));
    const globalLedgerAsDir = join(home, 'memory.jsonl');
    mkdirSync(globalLedgerAsDir);
    try {
      expect(() => gatherScopedRecords({ home, globalLedger: globalLedgerAsDir })).toThrow();

      let text: string | null = null;
      try {
        const { records, integrityAvailable, projectDisposition } = gatherScopedRecords({ home, globalLedger: globalLedgerAsDir });
        text = formatSessionStartContext(records, N, {
          integrityAvailable, unadoptedPresent: projectDisposition === 'unadopted-present',
        });
      } catch {
        text = null; // fail-closed: no memory block rather than a broken session
      }
      expect(text).toBeNull(); // nothing would reach writeSync — no output, exit 0
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
