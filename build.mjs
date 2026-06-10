// Bundle the MCP server + hook entries into committed, dependency-free bin/*.mjs.
// Claude Code does NOT npm-install a plugin's dependencies, so everything the runtime
// needs (@modelcontextprotocol/sdk, zod) must be inlined here.
import { build } from 'esbuild';

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
  outdir: 'bin',
  outExtension: { '.js': '.mjs' },
});

await build({
  ...common,
  entryPoints: {
    'session-start': 'src/hooks/session-start.ts',
    'session-end': 'src/hooks/session-end.ts',
  },
  outdir: 'bin/hooks',
  outExtension: { '.js': '.mjs' },
});
