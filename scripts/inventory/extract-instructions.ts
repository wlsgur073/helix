// The server-instructions facet (issue #4), recovered from the bytes the user runs. The shipped bundle is
// started twice, each time in a fresh HELIX_HOME used as its cwd: first with no config file, then with the
// switch on. What a client reads from `initialize` is recorded, `null` where the field is absent. The
// source side is pinned by test/server/server-instructions.test.ts, so no second recovery is made here.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLE, cleanEnv } from './extract-tools.js';

export interface InstructionsFacet {
  /** The exact config.json written for the run, or `null` for a home with no config file. */
  configJson: string | null;
  instructions: string | null;
}

// Fixed order: the switch-off case first, so the snapshot reads "absent, then this text".
const CASES: readonly (string | null)[] = [null, '{"serverInstructions":true}'];

/** `bundle` defaults to the shipped bundle; a test passes a mutated temporary copy (bin/ is never touched). */
export async function instructionsFromBundle(bundle: string = BUNDLE): Promise<InstructionsFacet[]> {
  const out: InstructionsFacet[] = [];
  for (const configJson of CASES) {
    const home = mkdtempSync(join(tmpdir(), 'helix-inv-instr-'));
    try {
      if (configJson !== null) writeFileSync(join(home, 'config.json'), configJson);
      const client = new Client({ name: 'helix-inventory-instructions', version: '0.0.0' });
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [bundle],
        cwd: home,
        env: { ...cleanEnv(), HELIX_HOME: home },
      }));
      try {
        out.push({ configJson, instructions: client.getInstructions() ?? null });
      } finally {
        await client.close();
      }
    } finally {
      // The function that made the directory owns its lifetime (`npm run inventory` runs outside vitest).
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  return out;
}
