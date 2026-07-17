// Bundle the MCP server + hook entries into committed, dependency-free bin/*.mjs.
// Claude Code does NOT npm-install a plugin's dependencies, so everything the runtime
// needs (@modelcontextprotocol/sdk, zod) must be inlined here.
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
  entryPoints: { 'helix-trigger': 'scripts/trigger-cli.ts' },
  outdir: OUT,
  outExtension: { '.js': '.mjs' },
});
