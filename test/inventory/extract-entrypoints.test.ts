import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractHooks, extractClis } from '../../scripts/inventory/extract-entrypoints.js';

describe('hook extraction', () => {
  it('derives hooks from the registration, and resolves each to an existing bundle', () => {
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const hooks = extractHooks();
    expect(hooks.map((h) => h.event).sort()).toEqual(['SessionEnd', 'SessionStart']);
    for (const h of hooks) {
      // The empty string is excluded first. `join(ROOT, '')` normalises to `ROOT` itself and the
      // repository root always exists, so without this assertion both checks below pass even when
      // the regex failed and `bundle` came back empty. The committed inventory snapshot pins this
      // value verbatim.
      expect(h.bundle.length, `${h.event} resolved to an empty bundle path`).toBeGreaterThan(0);
      // The value that enters the snapshot is repository-relative. An absolute path differs per
      // machine and would make the drift test meaningless anywhere but here.
      expect(h.bundle.startsWith('/'), `${h.event} carries an absolute path: ${h.bundle}`).toBe(false);
      expect(existsSync(join(ROOT, h.bundle)), `${h.event} resolves to a missing bundle: ${h.bundle}`).toBe(true);
    }
  });

  it('carries the declared timeout, which is part of the contract', () => {
    for (const h of extractHooks()) {
      expect(typeof h.timeout, `${h.event} has no declared timeout`).toBe('number');
    }
  });
});

describe('operator CLI extraction', () => {
  it('recovers each CLI usage line by executing it with no arguments', () => {
    const clis = extractClis();
    expect(clis.length).toBe(3); // helix-trigger, helix-rebaseline, helix-trust-resolve (C1.4-③)
    for (const c of clis) {
      expect(c.usage.length, `${c.bundle} printed no usage`).toBeGreaterThan(0);
      expect(c.noArgsExitCode, `${c.bundle} did not exit 2 on a usage error`).toBe(2);
    }
  }, 60_000);

  it('the trigger CLI declares required arguments in its usage', () => {
    const trigger = extractClis().find((c) => c.bundle.includes('helix-trigger'));
    expect(trigger, 'the trigger CLI is no longer shipped').toBeDefined();
    // The contract that establishes why the argument-less invocation the docs show does not run.
    expect(trigger!.usage).toContain('--root');
    expect(trigger!.usage).toContain('--run');
  }, 60_000);
});
