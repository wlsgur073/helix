# Dependency advisory triage — 2026-08

Snapshot date: 2026-08-21 · Source: `npm audit --json`. Counts **before** the fast-uri fix below:
`{"info":0,"low":2,"moderate":2,"high":4,"critical":0,"total":8}` (production-only,
`npm audit --omit=dev --json`: `{"info":0,"low":1,"moderate":2,"high":2,"critical":0,"total":5}` —
5 packages: `@hono/node-server`, `body-parser`, `fast-uri`, `hono`, `ip-address`). Counts **after**
the fix (this file's current state): `{"info":0,"low":2,"moderate":2,"high":3,"critical":0,"total":7}`
(production-only: `{"info":0,"low":1,"moderate":2,"high":1,"critical":0,"total":4}` — `fast-uri`
cleared).

Previous snapshot 2026-08-03: `{"info":0,"low":2,"moderate":3,"high":2,"critical":0,"total":7}`
across 7 packages (`@hono/node-server`, `@modelcontextprotocol/sdk`, `body-parser`, `esbuild`,
`fast-uri`, `hono`, `postcss`); all triaged `bundled-unreachable` or `dev-toolchain-only`, no action
taken. Two packages are new since then: `ip-address` (production, high) and `nanoid` (dev-only,
high). `@modelcontextprotocol/sdk` no longer appears as its own top-level `npm audit` entry as of
2026-08-21 (see its row below for why) — same Node/npm as the 08-03 run, so this is `npm audit`'s
own attribution bookkeeping, not a version change on our end.

Method: severity and ancestry are read from the `npm audit --json` snapshot. Bundle membership is
read from an esbuild metafile (`build({ bundle, platform: 'node', format: 'esm', target: 'node20',
metafile: true, write: false })`) that reproduces `build.mjs`'s server-entry options
(`entryPoints: { 'helix-mcp': 'src/server/index.ts' }`) one-for-one; `write: false` means the run
touches nothing under `bin/` (verified with `git status --porcelain` immediately after). Reachability
is decided by reading the advisory-specific call path out of the metafile's importer graph and the
shipped `bin/helix-mcp.mjs` — `npm ls <pkg> --all` ancestry alone is **not** treated as reachability
evidence, only as "who depends on whom." Reproduced with Node v24.18.0 / npm 12.0.1 on 2026-08-03
and again on 2026-08-21 (same versions both times).

| package | advisory | severity | ancestry (who pulls it) | in shipped bundle? | verdict | evidence | decision |
|---|---|---|---|---|---|---|---|
| `@hono/node-server` | [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9) | moderate | helix → `@modelcontextprotocol/sdk` (direct) → `@hono/node-server` (sdk's own declared dependency, `^1.19.9`) | no | `bundled-unreachable` | 0 files under `node_modules/@hono/node-server/` in the 2026-08-21 metafile (255 inputs) or in `bin/helix-mcp.mjs` (`grep -c '@hono/node-server' bin/helix-mcp.mjs` → 0). Advisory's vulnerable function is `serve-static`: on Windows an encoded backslash (`%5C`) survives forward-slash-only route splitting and is later resolved as a path separator, letting a request reach files under a middleware-guarded prefix. `@hono/node-server` is imported only by the SDK's HTTP-transport file (`server/streamableHttp.js`) and its `examples/` folder; Helix imports neither — `src/` imports only `@modelcontextprotocol/sdk/server/stdio.js` (`src/server/index.ts:5`) and `@modelcontextprotocol/sdk/server/mcp.js` (`src/server/helix-server.ts:3`). The SDK modules that do ship (16 metafile inputs, 15 contributing bytes — see the sdk row below) are exactly the stdio/task/validation slice; none is an HTTP-transport file. `npm audit fix --dry-run` proposes `1.19.14 => 1.19.17` within the sdk's declared `^1.19.9` range (no `--force`). | accept — bundled-unreachable |
| `@modelcontextprotocol/sdk` | *(no longer a distinct top-level `npm audit` entry as of 2026-08-21 — see note)* | — | helix → `@modelcontextprotocol/sdk` (direct, `package.json` `dependencies`, `^1.29.0`, installed `1.29.0`) | yes — 16 metafile inputs, 15 contributing bytes (`bin/helix-mcp.mjs:6893`–`:23289`) | *n/a — informational* | On 2026-08-03 this row existed because `npm audit` attributed `GHSA-frvp-7c67-39w9` (via `@hono/node-server`) to the sdk package itself as well. On 2026-08-21 `npm audit --json` lists `@hono/node-server` alone (see that row) and no longer emits a separate `@modelcontextprotocol/sdk` key — same Node v24.18.0/npm 12.0.1 as before, so this is npm's own attribution logic changing, not a dependency-tree change (`npm ls @modelcontextprotocol/sdk` still shows the single direct `1.29.0` resolution). Retained as a row purely for its bundle-membership facts, which the `@hono/node-server`, `body-parser`, and `hono` rows' evidence cites: the metafile lists 16 `@modelcontextprotocol/sdk` inputs; 15 contribute bytes and the 16th, `shared/uriTemplate.js`, is fully tree-shaken (`grep -c 'UriTemplate' bin/helix-mcp.mjs` → 0, re-confirmed 2026-08-21). | n/a — no advisory to act on this snapshot |
| `body-parser` | [GHSA-v422-hmwv-36x6](https://github.com/advisories/GHSA-v422-hmwv-36x6) | low | helix → `@modelcontextprotocol/sdk` → `express` (`^5.2.1`) → `body-parser` | no | `bundled-unreachable` | 0 files under `node_modules/body-parser/` or `node_modules/express/` in the metafile or in `bin/helix-mcp.mjs`. Advisory's vulnerable condition: an unparseable or `NaN` `limit` option value makes `bytes.parse()` return `null`, which silently disables body-size enforcement (DoS via oversized payloads). This is reachable only through Express-based HTTP handling (SDK's `server/express.js`), which — like `@hono/node-server` above — is never imported from `src/` and never enters the bundle. `npm audit fix --dry-run` proposes `2.2.2 => 2.3.0` within range (no `--force`). | accept — bundled-unreachable |
| `esbuild` | [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | low | helix → `esbuild` (direct devDependency, `^0.28.0`, installed `0.28.0`); also helix → `tsx` (dev) → `esbuild` and helix → `vitest` (dev) → `vite` → `esbuild` (deduped) | no | `dev-toolchain-only` | 0 files under `node_modules/esbuild/` in the metafile or `bin/helix-mcp.mjs` — esbuild is the bundler, not bundled content. Every ancestry path is rooted in `devDependencies`, never in `dependencies`. Advisory's vulnerable condition is esbuild's own dev server (`serve()`/`servedir`) on Windows misusing a POSIX-only `path.Clean()` against `..\`-style paths; `build.mjs` only calls one-shot `build({...})` (`build.mjs:21,28,38`), never `serve()`, so even local build tooling never exercises the vulnerable feature. `npm audit fix --dry-run` proposes `0.28.0 => 0.28.2` within the declared `^0.28.0` range. | accept — dev-toolchain-only |
| `fast-uri` | [GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx), [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7), [GHSA-4c8g-83qw-93j6](https://github.com/advisories/GHSA-4c8g-83qw-93j6) | high | helix → `@modelcontextprotocol/sdk` → `ajv` → `fast-uri` (ajv's declared range: `^3.0.1`) | yes — 3 files (`bin/helix-mcp.mjs:3102` `lib/utils.js`, `:3415` `lib/schemes.js`, `:3625` `index.js`), re-confirmed identical in the 2026-08-21 metafile both before and after the version bump below | `bundled-unreachable` | Bundle membership confirmed both in the metafile and directly in the shipped artifact. Full static importer chain, read from the metafile's reverse import graph: `src/server/index.ts` → `src/server/helix-server.ts` → sdk `server/mcp.js` → sdk `server/index.js` → sdk `validation/ajv-provider.js` → `ajv/dist/ajv.js` → `ajv/dist/core.js` → `ajv/dist/runtime/uri.js` → `fast-uri/index.js`. All three GHSAs (08-03's two plus a third disclosed since, GHSA-7p8r) are host-confusion bugs in fast-uri's URI **parse** step (backslash treated as an authority delimiter — two variants — and failed IDN canonicalization) — the sink is fast-uri's parser as wrapped by `ajv/dist/runtime/uri.js` for AJV's `uri`/`iri` format keywords. In the shipped bundle the *only* call site that runs a compiled AJV validator against external data is `Server.prototype.elicitInput` (`bin/helix-mcp.mjs:23113`), through `this._jsonSchemaValidator.getValidator(formParams.requestedSchema)` at `bin/helix-mcp.mjs:23131` — the sole `getValidator(`/`.compile(` call anywhere in the file against caller-supplied data (defined at `bin/helix-mcp.mjs:22553-22567`; nothing else in the bundle calls it). The sibling method `elicitInputStream` (`bin/helix-mcp.mjs:22714`) does not reach it — it only calls `this.requestStream(...)`, no `getValidator`/AJV call on its path. Helix's own source never calls `elicitInput`/`elicitInputStream` (zero matches for `elicit` under `src/`), and none of Helix's registered tool schemas declare a URI/IRI format: no `.url()` (or other URI/IRI-format) zod constructor appears anywhere in `src/server/helix-server.ts`. Helix's actual attacker-facing path — tool-call argument validation — runs entirely through zod (`safeParse` against `CallToolRequestSchema` at `bin/helix-mcp.mjs:22904`; per-tool zod shapes at `:23435`), never touching AJV. `new AjvJsonSchemaValidator()` does run eagerly at server construction (`bin/helix-mcp.mjs:22838`, unconditional default), so an AJV instance and its format validators are registered at every server startup — but no reachable code path ever calls the validator function that would exercise fast-uri's vulnerable parse behavior. | **upgrade now (lockfile only)** — see "fast-uri fix" below |
| `hono` | [GHSA-xgm2-5f3f-mvvc](https://github.com/advisories/GHSA-xgm2-5f3f-mvvc), [GHSA-hvrm-45r6-mjfj](https://github.com/advisories/GHSA-hvrm-45r6-mjfj), [GHSA-w62v-xxxg-mg59](https://github.com/advisories/GHSA-w62v-xxxg-mg59), [GHSA-8j4g-w8fx-2239](https://github.com/advisories/GHSA-8j4g-w8fx-2239), [GHSA-f23p-vx2j-j53r](https://github.com/advisories/GHSA-f23p-vx2j-j53r), [GHSA-79qm-7rj5-m7r9](https://github.com/advisories/GHSA-79qm-7rj5-m7r9), [GHSA-54fx-42gc-7vw4](https://github.com/advisories/GHSA-54fx-42gc-7vw4) | moderate | helix → `@modelcontextprotocol/sdk` → `hono` (direct dep of sdk, `^4.11.4`); also helix → `@modelcontextprotocol/sdk` → `@hono/node-server` → `hono` (deduped, same installed copy) | no | `bundled-unreachable` | 0 files under `node_modules/hono/` in the metafile or `bin/helix-mcp.mjs`. Four new GHSAs joined this row since 2026-08-03 (ReDoS in CORS middleware, `memo()` SSR-output retention across requests, Proxy Helper leaking `Connection`-listed headers, Algorithmic-Complexity DoS in language middleware) alongside the original three (AWS API Gateway v1 header-dedup bug, `hono/jsx` cross-request context leakage, `cx()` escaping-bypass XSS) — all seven live in hono's HTTP adapter, JSX, CORS, or language-middleware modules, reachable only via the SDK's HTTP-transport/example files (`server/streamableHttp.js`, `examples/honoWebStandardStreamableHttp.js`) — none imported from `src/`, none present in the bundle. Helix is a stdio-only MCP server: no HTTP adapter, no JSX rendering, no CORS/language middleware. `npm audit fix --dry-run` proposes `4.12.25 => 4.13.3` within the declared `^4.11.4` range. | accept — bundled-unreachable |
| `ip-address` | [GHSA-mwp4-54f8-5fhr](https://github.com/advisories/GHSA-mwp4-54f8-5fhr), [GHSA-4xrf-jv44-h6hh](https://github.com/advisories/GHSA-4xrf-jv44-h6hh), [GHSA-22jq-vg5j-6vgg](https://github.com/advisories/GHSA-22jq-vg5j-6vgg) | high | helix → `@modelcontextprotocol/sdk` → `express-rate-limit@8.5.2` (sdk's declared `^8.2.1`) → `ip-address@10.2.0` (`express-rate-limit`'s declared `^10.2.0`) — **new since 2026-08-03** | no | `bundled-unreachable` | 0 files under `node_modules/ip-address/`, `node_modules/express-rate-limit/`, or `node_modules/express/` in the metafile or `bin/helix-mcp.mjs`. Three GHSAs, all SSRF/trust-boundary bypasses in address parsing/classification: `Address4.prototype.parse` (`node_modules/ip-address/dist/ipv4.js:91`) decodes a leading-zero octet as decimal while DNS resolvers decode the same string as octal (GHSA-mwp4); the special-use-range checks built on `isInSubnet` (`isMulticast`/`isPrivate`/`isLoopback`, `ipv4.js:405-420`) misclassify a CIDR-suffixed address (GHSA-4xrf) or an IPv4-mapped/NAT64 IPv6 address (GHSA-22jq). `express-rate-limit`'s only call into the package is `new Address6(ip)` for its default IPv6 rate-limit key generator (`node_modules/express-rate-limit/dist/index.cjs:35,38`) — reachable only when Express-based HTTP request handling is live, which (as with `body-parser`/`hono`/`@hono/node-server` above) never enters the bundle: `src/` imports neither `express` nor `express-rate-limit`. `npm audit fix --dry-run` proposes `10.2.0 => 10.5.0`, within `express-rate-limit`'s declared `^10.2.0` (no `--force`). | accept — bundled-unreachable |
| `nanoid` | [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv), [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) | high | helix → `vitest` (dev, `4.1.8`) → `vite` (`8.0.16`) → `postcss` (`8.5.15`, declared `^3.3.12`) → `nanoid@3.3.12` — **new since 2026-08-03**, dev-only (absent from `npm audit --omit=dev`) | no | `dev-toolchain-only` | 0 files under `node_modules/nanoid/` in the metafile or `bin/helix-mcp.mjs`; its only ancestry path is rooted in the `vitest`→`vite`→`postcss` devDependency chain, never in `dependencies`. Both GHSAs are the same sink: `customRandom`'s returned closure (`node_modules/nanoid/index.cjs:51-62`) runs `while (true) { … if (id.length === size) return id }` — when `size` is negative (GHSA-28wg) or zero (GHSA-2v37) the loop body can never satisfy `id.length === size` and spins forever (CWE-835, DoS-by-hang). `nanoid` is postcss's own internal ID generator, invoked only by vite's asset/test pipeline during `npm test`/`npm run build`'s tooling, never by anything Helix ships or by any code that processes external input — same non-attacker-facing scope as `postcss` and `esbuild` below. Zero `nanoid` imports under `src/`. `npm audit fix --dry-run` proposes `3.3.12 => 3.3.18`, within postcss's declared `^3.3.12` (no `--force`). | accept — dev-toolchain-only |
| `postcss` | [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp), [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) | high | helix → `vitest` (dev) → `vite` → `postcss` | no | `dev-toolchain-only` | 0 files under `node_modules/postcss/` in the metafile or `bin/helix-mcp.mjs`; its only ancestry path is rooted in the `vitest`→`vite` devDependency chain (vite's internal asset pipeline), never in `dependencies`. Same `loadMap()`/source-map-path-traversal family as the 08-03 snapshot (GHSA-r28c: `join(dirname(opts.from), annotation)` resolves a `sourceMappingURL` CSS comment without sandboxing `../`, disclosing arbitrary `.map` file contents; GHSA-fxqj is the GHSA registry's tracking of an earlier incomplete fix for the same class). Helix ships no CSS and never invokes PostCSS at runtime; the only consumer is vite's test-time asset pipeline, which never processes attacker-supplied CSS. `npm audit fix --dry-run` proposes `8.5.15 => 8.5.26`. | accept — dev-toolchain-only |

## Decisions

Only `fast-uri` required action this cycle: it is the sole advisory-bearing package that ships in
the frozen `bin/helix-mcp.mjs` (3 files, confirmed both before and after the fix). All three current
fast-uri GHSAs are fixed as of `3.1.5`, and `ajv@8.20.0`'s declared dependency range (`^3.0.1`)
admits it — confirmed both by manual semver reasoning (`^3.0.1` = `>=3.0.1 <4.0.0`) and by
`npm audit fix --dry-run --json`, which independently proposed the identical `3.1.2 => 3.1.5` bump
with no `--force`. `package.json` now carries `"overrides": { "fast-uri": "3.1.5" } `; `npm install`
moved `package-lock.json` accordingly (`npm ls fast-uri` → `fast-uri@3.1.5 overridden`, single
resolution). **This changes only `node_modules` and `package-lock.json`** — the shipped
`bin/helix-mcp.mjs` stays frozen at whatever fast-uri version it was last built against (unaffected
by an `overrides` entry, since `write: false` and no `npm run build` ran) and will pick up 3.1.5 the
next time the bundle is rebuilt (the close-day rebuild). The reachability argument above is
unaffected either way — fast-uri was already `bundled-unreachable` before this fix and remains so —
so this is a defense-in-depth fix ahead of the M3 review condition, not a response to a live
finding.

Every other advisory-bearing package — `@hono/node-server`, `body-parser`, `hono`, `ip-address`
(all `bundled-unreachable`, 0 bytes in the shipped bundle) and `esbuild`, `nanoid`, `postcss` (all
`dev-toolchain-only`) — is decided **accept**, with the reason recorded per row. Every one of these
has a `fixAvailable: true`, semver-range-admitted upgrade per `npm audit fix --dry-run` (no
advisory in this snapshot needs a `--force`/breaking bump), but none of them enters the shipped
bundle regardless of version, so bumping their lockfile entries now would widen the freeze-window
diff without closing any reachable finding. They are left for ordinary dependency maintenance (the
next unconstrained `npm install`/lockfile refresh, which will most naturally happen alongside the
close-day rebuild) rather than acted on individually mid-freeze.

**Expected residue after the decided upgrades land:** 7 advisories total (`{"low":2,"moderate":2,
"high":3}`; production-only: `{"low":1,"moderate":2,"high":1}`, from `@hono/node-server`,
`body-parser`, `hono`, `ip-address`) — all accepted with a documented reachability argument, 0
requiring a backlog entry this cycle. This matches the post-fix `npm audit` snapshot recorded above,
confirming no further change is pending.

## actually-reachable outcomes

None, before or after this refresh. The 8 currently advisory-bearing packages carry 20 distinct
GHSA advisories on the 2026-08-21 snapshot (up from 9 across 7 packages on 2026-08-03: the original
9 all recur, plus 11 newly disclosed or newly reached — `GHSA-7p8r` on `fast-uri`; 4 more on `hono`;
3 on the new `ip-address` row; 2 on the new `nanoid` row; 1 more on `postcss`) — all triage to
`dev-toolchain-only` (3 packages: esbuild, nanoid, postcss) or `bundled-unreachable` (5 packages:
`@hono/node-server`, body-parser, fast-uri, hono, ip-address). `@modelcontextprotocol/sdk` is retained as a ninth, non-advisory row
for its bundle-membership facts only (see its row above). No advisory's vulnerable function is
invoked by Helix's shipped stdio-only server on any code path reachable from `src/server/index.ts`.
`fast-uri` is nonetheless upgraded in the lockfile (see Decisions) ahead of the close-day rebuild, as
defense-in-depth for the one package that does ship. No backlog entry is required this cycle for any
row.

## Limitations

- Reachability is source-reading over the bundle graph (metafile importer edges plus manual
  tracing of the shipped `bin/helix-mcp.mjs`), not a dynamic proof (no fuzzing, no runtime
  instrumentation). A future refactor that starts calling `elicitInput`, adds an HTTP transport,
  or introduces a `.url()`/URI-format field to a tool schema would need to re-run this triage.
- Dev-toolchain advisories (esbuild, nanoid, postcss) are scoped to `npm ci` plus local build/test
  tooling; they do not ship in `bin/` and are not part of the runtime attack surface.
- This snapshot is point-in-time (2026-08-21, refreshed from 2026-08-03). `npm audit` output changes
  as the advisory database and installed tree change, and `npm audit`'s own attribution of an
  advisory to an indirect package (see the `@modelcontextprotocol/sdk` row) can shift between runs
  even with an unchanged dependency tree. To re-validate on a later date, re-run `npm audit --json`
  and reproduce the esbuild metafile exactly as described in Method above, then re-check each
  verdict's evidence — including re-diffing the package list against this snapshot's 9 rows, not
  just re-reading counts.
