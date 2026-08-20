// Hooks are recovered from their registration; CLI contracts are recovered by running them.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HookFacet { event: string; command: string; timeout: number | null; bundle: string }
export interface CliFacet { bundle: string; usage: string; noArgsExitCode: number }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(ROOT, 'bin');

interface HooksJson {
  hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>>;
}

export function extractHooks(): HookFacet[] {
  const raw = JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8')) as HooksJson;
  const out: HookFacet[] = [];
  for (const [event, groups] of Object.entries(raw.hooks)) {
    for (const group of groups) {
      for (const entry of group.hooks) {
        // `node "${CLAUDE_PLUGIN_ROOT}/bin/hooks/x.mjs"` resolves to a path relative to the repository root.
        const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"']+)/.exec(entry.command);
        out.push({
          event,
          command: entry.command,
          timeout: entry.timeout ?? null,
          // Repository-relative. An absolute path would make the snapshot machine-dependent.
          // It reads `m?.[1] ?? ''` because `noUncheckedIndexedAccess` types a capture group as
          // `string | undefined`, and `m ? m[1] : ''` does not narrow it.
          bundle: m?.[1] ?? '',
        });
      }
    }
  }
  // Compared by code point. `localeCompare` degrades on a `--without-intl` / small-icu Node and
  // orders differently there, and this snapshot exists precisely to be diffed on another machine.
  return out.sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
}

/** A top-level `bin/*.mjs` that is neither a hook bundle nor the MCP server is an operator CLI. */
function cliBundles(): string[] {
  return readdirSync(BIN)
    .filter((e) => e.endsWith('.mjs') && e !== 'helix-mcp.mjs')
    .map((e) => join(BIN, e))
    .filter((p) => statSync(p).isFile())
    .sort();
}

/**
 * The minimal environment handed to the child. `HELIX_*` is stripped so the operator's own
 * configuration cannot leak into the contract; `NODE_OPTIONS` and `NODE_DEBUG` are stripped because
 * they make Node itself write diagnostics to stderr. Both CLIs print usage to stderr only (measured:
 * stdout is the empty string), so deriving `usage` from stdout alone would leave the contract empty.
 * The fix is to remove the contamination rather than to split the field. Those diagnostic strings
 * carry a PID and so do not reproduce even on the same machine, which means a single regeneration
 * could have committed a contaminated value as the CLI contract.
 */
function childEnv(): NodeJS.ProcessEnv {
  const drop = (k: string): boolean => k.startsWith('HELIX_') || k === 'NODE_OPTIONS' || k === 'NODE_DEBUG';
  return Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && !drop(k)),
  );
}

export function extractClis(): CliFacet[] {
  return cliBundles().map((bundle) => {
    const r = spawnSync(process.execPath, [bundle], {
      encoding: 'utf8',
      env: childEnv(),
      // This call returns immediately from argument validation. Without a ceiling, one regression
      // would stall inventory generation indefinitely.
      timeout: 10_000,
    });
    return {
      bundle: relative(ROOT, bundle),
      usage: `${r.stdout}${r.stderr}`.trim(),
      noArgsExitCode: r.status ?? -1,
    };
  });
}
