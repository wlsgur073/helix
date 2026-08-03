// Freeze-guard: the committed receipt must verify against this repository's history
// (anchor comparison at the candidate commit), and any tampering with the receipt
// must be detected. Worktree divergence before the close is a warning, never a failure.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFreezeGuard } from '../scripts/freeze-guard.js';
import { sha256Hex } from '../scripts/pilot/pin-hashes.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RECEIPT = join(ROOT, 'docs/release/v2-freeze-receipt-2026-08.json');

describe('freeze-guard', () => {
  it('passes on the committed receipt against the real repository', () => {
    const r = runFreezeGuard(RECEIPT, ROOT);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    // out-of-scope pins are declared, not silent
    expect(r.notes.join(' ')).toMatch(/config/);
    expect(r.notes.join(' ')).toMatch(/runtime/);
  });

  it('fails when the payload bytes no longer match payloadSha256', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-'));
    const doc = JSON.parse(readFileSync(RECEIPT, 'utf8'));
    doc.payload.k = 21; // tamper INSIDE payload, leave payloadSha256 as committed
    const p = join(dir, 'receipt.json');
    writeFileSync(p, JSON.stringify(doc));
    const r = runFreezeGuard(p, ROOT);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes('payload-sha256'))).toBe(true);
  });

  it('fails on an anchor mismatch even when the payload hash is internally consistent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-'));
    const doc = JSON.parse(readFileSync(RECEIPT, 'utf8'));
    const toolKeys = Object.keys(doc.payload.tools);
    const firstTool = toolKeys[0];
    if (!firstTool) throw new Error('Receipt must have at least one tool');
    doc.payload.tools[firstTool] = '0'.repeat(40); // wrong anchor…
    // …with a RECOMPUTED payloadSha256, exactly how the issuer computes it,
    // so only the anchor check can catch it:
    doc.payloadSha256 = sha256Hex(JSON.stringify(doc.payload));
    const p = join(dir, 'receipt.json');
    writeFileSync(p, JSON.stringify(doc));
    const r = runFreezeGuard(p, ROOT);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes(firstTool))).toBe(true);
  });

  it('fails when the tools map is emptied, even with payloadSha256 recomputed to match (pin completeness)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-'));
    const doc = JSON.parse(readFileSync(RECEIPT, 'utf8'));
    const expectedFirstTool = Object.keys(doc.payload.tools)[0];
    if (!expectedFirstTool) throw new Error('Receipt must have at least one tool');
    doc.payload.tools = {}; // emptied — a per-entry anchor loop trivially "passes" over zero entries
    // …with a RECOMPUTED payloadSha256, exactly how the issuer computes it, so only a
    // completeness check against PINNED_TOOL_PATHS can catch the omission:
    doc.payloadSha256 = sha256Hex(JSON.stringify(doc.payload));
    const p = join(dir, 'receipt.json');
    writeFileSync(p, JSON.stringify(doc));
    const r = runFreezeGuard(p, ROOT);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes(expectedFirstTool))).toBe(true);
  });
});
