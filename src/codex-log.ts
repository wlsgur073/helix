import { mkdirSync, readFileSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Outcome of a Helix-mediated Codex call. Only 'sent' carries prompt/response content. */
export type CodexOutcome = 'sent' | 'refused' | 'skipped' | 'unavailable' | 'error';

export interface CodexLogEntry {
  ts: string;
  kind: 'compare' | 'critique';   // the configured dual-verify mode
  outcome: CodexOutcome;
  model?: string | null;
  effort?: string | null;
  prompt?: string;    // ONLY when outcome === 'sent' (exact text sent to codex)
  response?: string;  // ONLY when outcome === 'sent' (exact text received)
  reason?: string;    // for every non-'sent' outcome (metadata only — never the payload)
}

/** Soft retention cap: a local log must not grow without bound. Best-effort, no lock. */
export const MAX_ENTRIES = 1000;

/**
 * Append one CodexLogEntry as a JSONL line. Fail-safe: any I/O error is swallowed (logging must
 * never break dual-verify). Creates the file with mode 0o600 (user-only; best-effort on Windows,
 * where the file relies on the ~/.helix profile-dir ACL). After append, applies a soft MAX_ENTRIES
 * retention cap by rewriting the last MAX_ENTRIES lines. The caller decides WHETHER to call this
 * (the opt-in logContent gate lives in the handler); this function decides HOW to persist safely.
 */
export function appendCodexLog(path: string, entry: CodexLogEntry): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Create owner-only AT OPEN TIME (the mode applies when the file is created), so the exact
    // prompt/response bytes are never briefly group/world-readable and a crash before a separate
    // chmod can never leave them that way permanently.
    const fd = openSync(path, 'a', 0o600);
    try { writeSync(fd, JSON.stringify(entry) + '\n'); } finally { closeSync(fd); }
    // Soft retention cap (best-effort; an unlocked read-modify-write — a rare two-session race can
    // momentarily over/undershoot the cap). The rewrite preserves the existing 0o600 mode.
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');
    if (lines.length > MAX_ENTRIES) {
      writeFileSync(path, lines.slice(lines.length - MAX_ENTRIES).join('\n') + '\n');
    }
  } catch {
    /* swallowed: best-effort, post-hoc logging never breaks the verify path */
  }
}
