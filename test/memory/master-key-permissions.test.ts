// tryReadMaster tightens an over-broad master key to 0600 on every read — defence in depth for a
// key a shipped version created before creation-time modes existed. Nothing measured it. BOTH halves
// matter: a repair that refused the read instead would be a different and worse behaviour, so the
// test asserts the key is still usable after the repair, not only that the mode moved.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, chmodSync, statSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { ensureMaster } from '../../src/memory/ledger-mac.js';

const mode = (p: string): number => statSync(p).mode & 0o777;

describe('master key permission self-repair', () => {
  it('tightens an over-broad key to 0600 and still reads it', () => {
    if (platform() === 'win32') return;                  // POSIX mode bits only
    const home = mkdtempSync(join(tmpdir(), 'helix-mkperm-'));
    try {
      const first = ensureMaster(home);                    // mints it
      const keyPath = join(home, 'ledger-mac-master.key');

      chmodSync(keyPath, 0o644);                           // what a pre-mode shipped version left behind
      expect(mode(keyPath)).toBe(0o644);

      const second = ensureMaster(home);                   // reads it back through tryReadMaster
      expect(mode(keyPath)).toBe(0o600);                   // repaired
      expect(second.equals(first)).toBe(true);             // and NOT re-minted: same key bytes
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
