// Bundle the MCP server + hook entries into committed, dependency-free bin/*.mjs.
// Everything the runtime needs (@modelcontextprotocol/sdk, zod) is inlined here, so package.json
// lists both as devDependencies: Claude Code installs the runtime dependencies a cache-installed
// plugin declares, and refuses a package.json with overrides (issue #10).
// HELIX_BUILD_OUT overrides the output root (the freshness test builds to a temp dir and
// byte-compares against the committed bin/).
import { build } from 'esbuild';
import { join } from 'node:path';

const OUT = process.env.HELIX_BUILD_OUT ?? 'bin';

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: { 'helix-mcp': 'src/server/index.ts' },
  outdir: OUT,
  outExtension: { '.js': '.mjs' },
});

await build({
  ...common,
  entryPoints: {
    'session-start': 'src/hooks/session-start.ts',
    'session-end': 'src/hooks/session-end.ts',
  },
  outdir: join(OUT, 'hooks'),
  outExtension: { '.js': '.mjs' },
});

await build({
  ...common,
  entryPoints: { 'helix-trigger': 'scripts/trigger-cli.ts', 'helix-rebaseline': 'scripts/rebaseline-cli.ts', 'helix-trust-resolve': 'scripts/trust-resolve-cli.ts' },
  outdir: OUT,
  outExtension: { '.js': '.mjs' },
});
