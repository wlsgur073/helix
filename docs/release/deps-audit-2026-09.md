# Dependency advisory triage — 2026-09 (release)

Snapshot date: 2026-09-09 · Tree: `feat/helix-v1`, the v0.1.0 release preparation · Node v24.20.0,
npm 12.0.2 · Method: `npm audit --json` and `npm audit --omit=dev --json`, then a **reachability
measurement against the shipped bundle** for every production advisory, rather than an assertion
about it.

**This supersedes `deps-audit-2026-08.md`**, which was removed in the same change. Its dispositions
are carried forward in §2, and its bytes remain recoverable:
`git log --diff-filter=D --oneline -- docs/release/deps-audit-2026-08.md`.

## 1. What the tree holds now

| | before this pass | after |
|---|---|---|
| all dependencies | 10 (2 low · 5 moderate · 3 high) | **5** (1 low · 3 moderate · 1 high) |
| production only | 5 (1 low · 3 moderate · 1 high) | **5** (unchanged) |

The five that remain are the same five in both columns, and they are the production set. Everything
the dev tree added — `vitest`, `@vitest/mocker`, `esbuild`, `nanoid`, `postcss` — is closed by the
two upgrades in §3.

## 2. What the August record decided, and what became of it

- **`fast-uri` overridden to 3.1.7.** The August record decided the raise and stated that it was
  "not applied in this commit". It was applied on 2026-09-06 in `800c523` and shipped in the
  `2baf9c7` rebuild; `package.json` `overrides` and the lockfile both read `3.1.7`, and the advisory
  is gone from the tree. `CHANGELOG.md` still said `3.1.5` until this change corrected it.
- **`ajv`.** Resolved at `8.20.0` and no longer carries an advisory; it leaves this record with
  nothing owed.
- **The 2026-09-03 refresh's owed reachability triage.** That is what §4 of this document is. It was
  owed because a count of advisories says nothing about whether the vulnerable code ships.

## 3. What changed in this pass

- **`vitest` 4.1.8 → 4.1.11** (dev only). Closes `GHSA-82fw-gwwq-j7x9` (`@vitest/mocker` path
  traversal) and, through its own dependency updates, the `nanoid` and `postcss` advisories. No
  effect on any shipped byte.
- **`esbuild` `^0.28.0` → `^0.28.2`, resolved 0.28.2** (dev only as a dependency, but it is the
  bundler, so it *does* move shipped bytes). Closes `GHSA-g7r4-m6w7-qqqr`, an arbitrary file read in
  esbuild's development server on Windows — a server this project never runs, so the advisory was
  unreachable and the upgrade is hygiene rather than a fix. Its effect on the bundle is six lines in
  esbuild's own CommonJS interop helper: a module that throws while initializing no longer leaves a
  half-built cached export behind for the next `require`. Strictly safer, and reviewed line by line
  before it was taken.
- **`@modelcontextprotocol/sdk` 1.29.0 → 1.30.0.** In range (`^1.29.0`), so any clean install
  resolves to it and the shipped bundle should be built from what the range actually gives. Taken
  under the rule that all three had to hold, each measured: the suite stays green (2586 passed, 2
  skipped), `npm run typecheck` exits 0, and the production advisory set is unchanged. The bundle
  diff was read rather than counted, and all of it lands on the transport Helix actually uses: the
  stdio read buffer gains a 10 MB cap that clears itself and raises on overflow, a stdio read error
  now reaches `onerror` and closes the transport instead of escaping as an unhandled throw, and
  validation failures render a dotted path to the offending field. This is hardening on Helix's own
  surface, not churn.

**Not taken, with the reason.** `zod` 4.x and `typescript` 7.x are majors outside their declared
ranges — a first release is the wrong moment. `@types/node` 26.x is likewise a major. `tsx` is
pinned exactly on purpose and carries no advisory.

## 4. Reachability — measured, not assumed

All five remaining advisories are transitive under `@modelcontextprotocol/sdk`, and every one of
them arrives through an HTTP stack the SDK ships for *other* transports:

```
@modelcontextprotocol/sdk@1.30.0
├─┬ @hono/node-server@1.19.14 → hono@4.12.25
├─┬ express-rate-limit@8.5.2  → ip-address@10.2.0
└─┬ express@5.2.1             → body-parser@2.2.2 → qs@6.15.2
```

Helix imports exactly three SDK entry points — `server/mcp.js`, `server/stdio.js` and
`shared/transport.js` — so esbuild's tree shaking never reaches the HTTP transports. Measured against
the shipped bundle:

| package | severity | module-path markers in `bin/helix-mcp.mjs` | reachable from a shipped bundle |
|---|---|---|---|
| `ip-address` | high | 0 | **no** |
| `hono` | moderate | 0 | **no** |
| `@hono/node-server` | moderate | 0 | **no** |
| `qs` | moderate | 0 | **no** |
| `body-parser` | low | 0 | **no** |

What the bundle does carry from the SDK is the stdio server path and nothing else:
`server/index`, `server/mcp`, `server/stdio`, `server/completable`, `server/zod`, `shared/protocol`,
`shared/stdio`, `shared/tool`, `types`, `validation/ajv`, and the experimental tasks helpers.

**Disposition: all five are accepted for `v0.1.0` as unreachable from the shipped artifact.** They
are real advisories in the dependency graph and they are reported here rather than dismissed; what
they are not is code a user of this plugin can execute. The check to repeat when the SDK is next
upgraded is the one in the table — count the module-path markers, do not reason about the import
graph.

## 5. Licences

| package | version | licence |
|---|---|---|
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT |
| `zod` | 3.25.76 | MIT |
| `@types/node` | 24.13.1 | MIT |
| `esbuild` | 0.28.2 | MIT |
| `tsx` | 4.23.5 | MIT |
| `typescript` | 6.0.3 | Apache-2.0 |
| `vitest` | 4.1.11 | MIT |

`tsx` is listed because the July audit's table predates it; it entered the tree on 2026-08-03. The
project itself is MIT. No copyleft licence appears in the tree.

## 6. Packaged-file review

11 tracked files at the repository root (`.gitattributes`, `.gitignore`, `CHANGELOG.md`, `LICENSE`,
`README.md`, `SECURITY.md`, `build.mjs`, `package-lock.json`, `package.json`, `tsconfig.json`,
`vitest.config.ts`), 24 tracked files under `docs/release/` after the 2026-09-09 cleanup, and four
under `data/` — `inventory/claims.json`, `inventory/surface.json`, `inventory/verdicts.json`, and
`semantic-neighbors.json`. The July audit's count of one tracked `data/` file predates the inventory.

Shipped bundle sizes at this snapshot:

| bundle | bytes |
|---|---|
| `bin/helix-mcp.mjs` | 973543 |
| `bin/helix-trust-resolve.mjs` | 138955 |
| `bin/hooks/session-start.mjs` | 52169 |
| `bin/helix-rebaseline.mjs` | 36044 |
| `bin/helix-trigger.mjs` | 16339 |
| `bin/hooks/session-end.mjs` | 2956 |

## 7. Version sites

All read `0.1.0`: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
and `src/server/helix-server.ts` (the `McpServer` identity, which is what a client sees at
`initialize`). The first three are pinned by the candidate receipt and re-checked by
`npm run certify-gate`; the fourth is exercised by `scripts/smoke-runtime-floor.mjs`, which reads the
version back out of a live `initialize` response.

## 8. What is still not automated

The July audit's **filename-class** history scan — searching the whole history for paths matching
`.env`, `.pem`, `.key`, `credentials` — has no automated counterpart. `scripts/scan-history-secrets.ts`
and the CI `history-scan` job scan file *content* against provider patterns, which is the more useful
half but not this one. Recorded here so the gap is a known one rather than an assumed coverage.
