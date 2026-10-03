// Which project ledger the server's startup integrity scan reads (src/server/index.ts), as the pure
// rule ownership.ts startupScanReadsProject: IT-M15 (second fix batch §4.3 item 3) skips an ALIASED
// layer the way every read path does, and ruling R9 also skips an UNADOPTED working-directory project
// whose ledger leads — kernel-resolved — to another registered project's ledger, or cannot be resolved.
// The bundle-level counterpart is test/acceptance/startup-scan-classes.test.ts.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { startupScanReadsProject, stampOwnership, projectLedgerPath, projectDispositionOf } from '../../src/memory/ownership.js';

/** An adopted project B (with or without its ledger file) and a project U holding an empty `.helix/`. */
function fixture(opts: { bLedger: boolean }) {
  const home = mkdtempSync(join(tmpdir(), 'helix-scanscope-home-'));
  const b = mkdtempSync(join(tmpdir(), 'helix-scanscope-proj-'));
  const u = mkdtempSync(join(tmpdir(), 'helix-scanscope-proj-'));
  stampOwnership(b, home, {});
  if (opts.bLedger) writeFileSync(projectLedgerPath(b), '');
  mkdirSync(join(u, '.helix'));
  const reads = (origin: 'cwd' | 'ancestor' = 'cwd'): boolean =>
    startupScanReadsProject({ root: u, ledger: projectLedgerPath(u), origin }, home);
  return { home, b, u, reads };
}

describe('startupScanReadsProject (IT-M15 scope, R9)', () => {
  it("an unadopted cwd project's OWN memory file is read (a foreign file, or none yet)", () => {
    const f = fixture({ bLedger: true });
    expect(f.reads()).toBe(true);                                                     // inactive: no file yet
    writeFileSync(projectLedgerPath(f.u), '');
    expect(projectDispositionOf({ root: f.u, ledger: projectLedgerPath(f.u), home: f.home, origin: 'cwd' })).toBe('unadopted-present');
    expect(f.reads()).toBe(true);
  });

  it('an owned project is read; an owned project aliased to another adopted project is not', () => {
    const f = fixture({ bLedger: true });
    stampOwnership(f.u, f.home, {});
    expect(f.reads()).toBe(true);
    symlinkSync(projectLedgerPath(f.b), projectLedgerPath(f.u));
    expect(f.reads()).toBe(false);
  });

  it('an unadopted PARENT project is never read', () => {
    const f = fixture({ bLedger: true });
    writeFileSync(projectLedgerPath(f.u), '');
    expect(f.reads('ancestor')).toBe(false);
  });

  it("R9: an unadopted cwd project whose memory file links to a registered project's existing file is not read", () => {
    const f = fixture({ bLedger: true });
    symlinkSync(projectLedgerPath(f.b), projectLedgerPath(f.u));
    expect(projectDispositionOf({ root: f.u, ledger: projectLedgerPath(f.u), home: f.home, origin: 'cwd' })).toBe('unadopted-present');
    expect(f.reads()).toBe(false);
  });

  it("R9: the same through `dl/..` (the kernel's reading, not the textual one) and as a dangling link to the absent file", () => {
    const viaDotDot = fixture({ bLedger: true });
    mkdirSync(join(viaDotDot.u, 'x'));
    symlinkSync(join(viaDotDot.u, 'x'), join(viaDotDot.u, '.helix', 'dl'));
    symlinkSync(['dl', '..', '..', basename(viaDotDot.b), '.helix', 'memory.jsonl'].join('/'), projectLedgerPath(viaDotDot.u));
    expect(viaDotDot.reads()).toBe(false);

    const dangling = fixture({ bLedger: false });
    symlinkSync(projectLedgerPath(dangling.b), projectLedgerPath(dangling.u));
    expect(dangling.reads()).toBe(false);
  });

  it('R9: an unadopted cwd project whose memory file Helix cannot resolve (a non-UTF-8 link body) is not read', () => {
    const f = fixture({ bLedger: true });
    symlinkSync(Buffer.from([0xff]), projectLedgerPath(f.u));
    expect(f.reads()).toBe(false);
  });

  it("control: a link inside the project's own tree is still its own file, and is read", () => {
    const f = fixture({ bLedger: true });
    mkdirSync(join(f.u, 'data'));
    writeFileSync(join(f.u, 'data', 'mem.jsonl'), '');
    symlinkSync(join(f.u, 'data', 'mem.jsonl'), projectLedgerPath(f.u));
    expect(f.reads()).toBe(true);
  });
});
