# Dependency advisory triage — 2026-08

Snapshot date: 2026-08-21 · Source: `npm audit --json`. **Counts re-measured 2026-09-03 and they
have moved, and the `fast-uri` row's stated mechanism is wrong — see "Refresh 2026-09-03" and
"Reachability triage 2026-09-03" at the end before relying on anything in this section.** Counts **before** the fast-uri fix below:
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
| `@modelcontextprotocol/sdk` | *(no longer a distinct top-level `npm audit` entry as of 2026-08-21 — see note)* | — | helix → `@modelcontextprotocol/sdk` (direct, `package.json` `dependencies`, `^1.29.0`, installed `1.29.0`) | yes — 16 metafile inputs, 15 contributing bytes (`bin/helix-mcp.mjs:6893`–`:23289`) | *n/a — informational* | On 2026-08-03 this row existed because `npm audit` attributed `GHSA-frvp-7c67-39w9` (via `@hono/node-server`) to the sdk package itself as well. On 2026-08-21 `npm audit --json` lists `@hono/node-server` alone (see that row) and no longer emits a separate `@modelcontextprotocol/sdk` key — same Node v24.18.0/npm 12.0.1 as before, so this is npm's own attribution logic changing, not a dependency-tree change (`npm ls @modelcontextprotocol/sdk` still shows the single direct `1.29.0` resolution). Retained as a row purely for its bundle-membership facts, which the `@hono/node-server`, `body-parser`, and `hono` rows' evidence cites: the metafile lists 16 `@modelcontextprotocol/sdk` inputs; 15 contribute bytes and the 16th, `shared/uriTemplate.js`, is fully tree-shaken (`grep -c 'UriTemplate' bin/helix-mcp.mjs` → 0, re-confirmed 2026-08-21). | accept — no advisory attributed to this package at this snapshot; retained for the metafile facts other rows cite |
| `body-parser` | [GHSA-v422-hmwv-36x6](https://github.com/advisories/GHSA-v422-hmwv-36x6) | low | helix → `@modelcontextprotocol/sdk` → `express` (`^5.2.1`) → `body-parser` | no | `bundled-unreachable` | 0 files under `node_modules/body-parser/` or `node_modules/express/` in the metafile or in `bin/helix-mcp.mjs`. Advisory's vulnerable condition: an unparseable or `NaN` `limit` option value makes `bytes.parse()` return `null`, which silently disables body-size enforcement (DoS via oversized payloads). This is reachable only through Express-based HTTP handling (SDK's `server/express.js`), which — like `@hono/node-server` above — is never imported from `src/` and never enters the bundle. `npm audit fix --dry-run` proposes `2.2.2 => 2.3.0` within range (no `--force`). | accept — bundled-unreachable |
| `esbuild` | [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | low | helix → `esbuild` (direct devDependency, `^0.28.0`, installed `0.28.0`); also helix → `tsx` (dev) → `esbuild` and helix → `vitest` (dev) → `vite` → `esbuild` (deduped) | no | `dev-toolchain-only` | 0 files under `node_modules/esbuild/` in the metafile or `bin/helix-mcp.mjs` — esbuild is the bundler, not bundled content. Every ancestry path is rooted in `devDependencies`, never in `dependencies`. Advisory's vulnerable condition is esbuild's own dev server (`serve()`/`servedir`) on Windows misusing a POSIX-only `path.Clean()` against `..\`-style paths; `build.mjs` only calls one-shot `build({...})` (`build.mjs:21,28,38`), never `serve()`, so even local build tooling never exercises the vulnerable feature. `npm audit fix --dry-run` proposes `0.28.0 => 0.28.2` within the declared `^0.28.0` range. | accept — dev-toolchain-only |
| `fast-uri` | [GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx), [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7), [GHSA-4c8g-83qw-93j6](https://github.com/advisories/GHSA-4c8g-83qw-93j6) | high | helix → `@modelcontextprotocol/sdk` → `ajv` → `fast-uri` (ajv's declared range: `^3.0.1`) | yes — 3 files (`bin/helix-mcp.mjs:3102` `lib/utils.js`, `:3415` `lib/schemes.js`, `:3625` `index.js`), re-confirmed identical in the 2026-08-21 metafile both before and after the version bump below | `bundled-unreachable` | Bundle membership confirmed both in the metafile and directly in the shipped artifact. Full static importer chain, read from the metafile's reverse import graph: `src/server/index.ts` → `src/server/helix-server.ts` → sdk `server/mcp.js` → sdk `server/index.js` → sdk `validation/ajv-provider.js` → `ajv/dist/ajv.js` → `ajv/dist/core.js` → `ajv/dist/runtime/uri.js` → `fast-uri/index.js`. All three GHSAs (08-03's two plus a third disclosed since, GHSA-7p8r) are host-confusion bugs in fast-uri's URI **parse** step (backslash treated as an authority delimiter — two variants — and failed IDN canonicalization) — the sink is fast-uri's parser as wrapped by `ajv/dist/runtime/uri.js` for AJV's `uri`/`iri` format keywords. In the shipped bundle the *only* call site that runs a compiled AJV validator against external data is `Server.prototype.elicitInput` (`bin/helix-mcp.mjs:23113`), through `this._jsonSchemaValidator.getValidator(formParams.requestedSchema)` at `bin/helix-mcp.mjs:23131` — the sole `getValidator(`/`.compile(` call anywhere in the file against caller-supplied data (defined at `bin/helix-mcp.mjs:22553-22567`; nothing else in the bundle calls it). The sibling method `elicitInputStream` (`bin/helix-mcp.mjs:22714`) does not reach it — it only calls `this.requestStream(...)`, no `getValidator`/AJV call on its path. Helix's own source never calls `elicitInput`/`elicitInputStream` (zero matches for `elicit` under `src/`), and none of Helix's registered tool schemas declare a URI/IRI format: no `.url()` (or other URI/IRI-format) zod constructor appears anywhere in `src/server/helix-server.ts`. Helix's actual attacker-facing path — tool-call argument validation — runs entirely through zod (`safeParse` against `CallToolRequestSchema` at `bin/helix-mcp.mjs:22904`; per-tool zod shapes at `:23435`), never touching AJV. `new AjvJsonSchemaValidator()` does run eagerly at server construction (`bin/helix-mcp.mjs:22838`, unconditional default), so an AJV instance and its format validators are registered at every server startup — but no reachable code path ever calls the validator function that would exercise fast-uri's vulnerable parse behavior. **CORRECTION 2026-09-03, measured:** the sentences above naming AJV's `uri`/`iri` format keywords as the sink are WRONG, and so is the reasoning that hangs off them ("none of Helix's registered tool schemas declare a URI/IRI format"). `ajv-formats` does not import `fast-uri` at all — its `uri` format is a regex — and no `iri` format is registered at any point. Instrumented: validating a hostile instance against `{type:'string',format:'uri'}` makes **zero** fast-uri calls. The real sink is schema **`$id`/`$ref` resolution at compile time** (`ajv/dist/core.js:71` `uriResolver` → `runtime/uri.js`, which is a bare `require("fast-uri")`), and there are two doors into it, not one: `getValidator` tries `_ajv.getSchema(schema.$id)` BEFORE `_ajv.compile(schema)`, and `getSchema` alone reaches `parse` with the `$id` string, while a `$ref` reaches `resolve()`. The last sentence is also backwards: fast-uri DOES execute on every server start (AJV construction parses the constant `"http://json-schema.org/draft-07/schema"`), and it is the compiled validator function that never touches it. Every bundle line number cited in this cell is stale against the shipped bytes; the current ones are in "Reachability triage 2026-09-03" at the end. The row's VERDICT is unchanged and was re-derived from scratch — see that section. | **upgrade now (lockfile only)** — see "fast-uri fix" below; superseded 2026-09-03, the pin is now the blocker |
| `hono` | [GHSA-xgm2-5f3f-mvvc](https://github.com/advisories/GHSA-xgm2-5f3f-mvvc), [GHSA-hvrm-45r6-mjfj](https://github.com/advisories/GHSA-hvrm-45r6-mjfj), [GHSA-w62v-xxxg-mg59](https://github.com/advisories/GHSA-w62v-xxxg-mg59), [GHSA-8j4g-w8fx-2239](https://github.com/advisories/GHSA-8j4g-w8fx-2239), [GHSA-f23p-vx2j-j53r](https://github.com/advisories/GHSA-f23p-vx2j-j53r), [GHSA-79qm-7rj5-m7r9](https://github.com/advisories/GHSA-79qm-7rj5-m7r9), [GHSA-54fx-42gc-7vw4](https://github.com/advisories/GHSA-54fx-42gc-7vw4) | moderate | helix → `@modelcontextprotocol/sdk` → `hono` (direct dep of sdk, `^4.11.4`); also helix → `@modelcontextprotocol/sdk` → `@hono/node-server` → `hono` (deduped, same installed copy) | no | `bundled-unreachable` | 0 files under `node_modules/hono/` in the metafile or `bin/helix-mcp.mjs`. Four new GHSAs joined this row since 2026-08-03 (ReDoS in CORS middleware, `memo()` SSR-output retention across requests, Proxy Helper leaking `Connection`-listed headers, Algorithmic-Complexity DoS in language middleware) alongside the original three (AWS API Gateway v1 header-dedup bug, `hono/jsx` cross-request context leakage, `cx()` escaping-bypass XSS) — all seven live in hono's HTTP adapter, JSX, CORS, or language-middleware modules, reachable only via the SDK's HTTP-transport/example files (`server/streamableHttp.js`, `examples/honoWebStandardStreamableHttp.js`) — none imported from `src/`, none present in the bundle. Helix is a stdio-only MCP server: no HTTP adapter, no JSX rendering, no CORS/language middleware. `npm audit fix --dry-run` proposes `4.12.25 => 4.13.3` within the declared `^4.11.4` range. | accept — bundled-unreachable |
| `ip-address` | [GHSA-mwp4-54f8-5fhr](https://github.com/advisories/GHSA-mwp4-54f8-5fhr), [GHSA-4xrf-jv44-h6hh](https://github.com/advisories/GHSA-4xrf-jv44-h6hh), [GHSA-22jq-vg5j-6vgg](https://github.com/advisories/GHSA-22jq-vg5j-6vgg) | high | helix → `@modelcontextprotocol/sdk` → `express-rate-limit@8.5.2` (sdk's declared `^8.2.1`) → `ip-address@10.2.0` (`express-rate-limit`'s declared `^10.2.0`) — **new since 2026-08-03** | no | `bundled-unreachable` | 0 files under `node_modules/ip-address/`, `node_modules/express-rate-limit/`, or `node_modules/express/` in the metafile or `bin/helix-mcp.mjs`. Three GHSAs, all SSRF/trust-boundary bypasses in address parsing/classification: `Address4.prototype.parse` (`node_modules/ip-address/dist/ipv4.js:91`) decodes a leading-zero octet as decimal while DNS resolvers decode the same string as octal (GHSA-mwp4); the special-use-range checks built on `isInSubnet` (`isMulticast`/`isPrivate`/`isLoopback`, `ipv4.js:405-420`) misclassify a CIDR-suffixed address (GHSA-4xrf) or an IPv4-mapped/NAT64 IPv6 address (GHSA-22jq). `express-rate-limit`'s only call into the package is `new Address6(ip)` for its default IPv6 rate-limit key generator (`node_modules/express-rate-limit/dist/index.cjs:35,38`). `express-rate-limit` itself is imported only by the SDK's OAuth handlers — `import { rateLimit } from 'express-rate-limit'` appears in exactly 4 files: `server/auth/handlers/token.js`, `server/auth/handlers/authorize.js`, `server/auth/handlers/register.js`, `server/auth/handlers/revoke.js` (verified: `grep -rl "express-rate-limit" node_modules/@modelcontextprotocol/sdk/dist/esm/` returns these 4 `.js` files plus their `.d.ts` type-declaration siblings, which carry no runtime import). None of the 4 handler files appears in the metafile or in `bin/helix-mcp.mjs` — confirmed both structurally (0 metafile inputs under `server/auth/handlers/`) and by their actual exported function names — `tokenHandler`, `authorizationHandler`, `clientRegistrationHandler`, `revocationHandler` — each individually absent (`grep -c "<name>" bin/helix-mcp.mjs` → 0 for all four). This is reachable only when Express-based OAuth/HTTP request handling is live, which (as with `body-parser`/`hono`/`@hono/node-server` above) never enters the bundle: `src/` imports neither `express`, `express-rate-limit`, nor any `server/auth/*` SDK module — only `server/stdio.js` and `server/mcp.js` (see the `@hono/node-server` row). `npm audit fix --dry-run` proposes `10.2.0 => 10.5.0`, within `express-rate-limit`'s declared `^10.2.0` (no `--force`). | accept — bundled-unreachable |
| `nanoid` | [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv), [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) | high | helix → `vitest` (dev, `4.1.8`) → `vite` (`8.0.16`) → `postcss` (`8.5.15`, declared `^3.3.12`) → `nanoid@3.3.12` — **new since 2026-08-03**, dev-only (absent from `npm audit --omit=dev`) | no | `dev-toolchain-only` | 0 files under `node_modules/nanoid/` in the metafile or `bin/helix-mcp.mjs`; its only ancestry path is rooted in the `vitest`→`vite`→`postcss` devDependency chain, never in `dependencies`. Both GHSAs are the same sink: `customRandom`'s returned closure (`node_modules/nanoid/index.cjs:52-64`) runs `while (true) { … if (id.length === size) return id }` — when `size` is negative (GHSA-28wg) or zero (GHSA-2v37) the loop body can never satisfy `id.length === size` and spins forever (CWE-835, DoS-by-hang). `nanoid` is postcss's own internal ID generator, invoked only by vite's asset/test pipeline during `npm test`/`npm run build`'s tooling, never by anything Helix ships or by any code that processes external input — same non-attacker-facing scope as `postcss` and `esbuild` below. Zero `nanoid` imports under `src/`. `npm audit fix --dry-run` proposes `3.3.12 => 3.3.18`, within postcss's declared `^3.3.12` (no `--force`). | accept — dev-toolchain-only |
| `postcss` | [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp), [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) | high | helix → `vitest` (dev) → `vite` → `postcss` | no | `dev-toolchain-only` | 0 files under `node_modules/postcss/` in the metafile or `bin/helix-mcp.mjs`; its only ancestry path is rooted in the `vitest`→`vite` devDependency chain (vite's internal asset pipeline), never in `dependencies`. Same `loadMap()`/source-map-path-traversal family as the 08-03 snapshot (GHSA-r28c: `join(dirname(opts.from), annotation)` resolves a `sourceMappingURL` CSS comment without sandboxing `../`, disclosing arbitrary `.map` file contents; GHSA-fxqj is the GHSA registry's tracking of an earlier incomplete fix for the same class). Helix ships no CSS and never invokes PostCSS at runtime; the only consumer is vite's test-time asset pipeline, which never processes attacker-supplied CSS. `npm audit fix --dry-run` proposes `8.5.15 => 8.5.26`. | accept — dev-toolchain-only |

## Decisions

Only `fast-uri` required action this cycle: it is the sole advisory-bearing package that ships in
the frozen `bin/helix-mcp.mjs` (3 files, confirmed both before and after the fix). All three current
fast-uri GHSAs are fixed as of `3.1.5` *(2026-09-03: "current" meant the three GHSAs known on
2026-08-21. Four more, all high, now cover `3.0.0 - 3.1.5` inclusive, so `3.1.5` no longer clears
this package — see "Refresh 2026-09-03")*, and `ajv@8.20.0`'s declared dependency range (`^3.0.1`)
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
close-day rebuild) rather than acted on individually mid-freeze. The `bundled-unreachable` verdict
for `@hono/node-server`, `hono`, `body-parser`, and `ip-address` specifically holds only as long as
Helix ships stdio-only: the moment an HTTP transport (or any other code path importing the SDK's
Express/hono adapter or OAuth-handler modules) is wired into `src/`, every one of these four rows
reopens and must be re-triaged against its advisory set before that change ships.

**Expected residue after the decided upgrades land:** 7 advisories total (`{"low":2,"moderate":2,
"high":3}`; production-only: `{"low":1,"moderate":2,"high":1}`, from `@hono/node-server`,
`body-parser`, `hono`, `ip-address`) — all accepted with a documented reachability argument, 0
requiring a backlog entry this cycle. This matches the post-fix `npm audit` snapshot recorded above,
confirming no further change is pending.

## actually-reachable outcomes

*(2026-09-03: this `None` was written for the 2026-08-21 advisory set. The six advisories disclosed
since — four on `fast-uri`, two on `qs` — were triaged the same day and are `bundled-unreachable`
too, so the `None` still holds, but on evidence recorded in "Reachability triage 2026-09-03" at the
end rather than on anything in this section. That section also corrects the mechanism this one's
`fast-uri` sentence relies on.)*

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

## Refresh 2026-09-03 — counts re-measured, reachability triage OWED

This is a counts-and-membership refresh, not a new triage. The Limitations section above requires
re-diffing the package list against the 9 rows of the 2026-08-21 snapshot rather than re-reading
totals, and that diff is what this section reports. **No verdict below is re-derived: the esbuild
metafile was not rebuilt and no reachability path was re-traced, so every row's disposition above
remains the 2026-08-21 one and the new advisories carry no disposition at all.**

Measured 2026-09-03 with the same command the Method section names, on an unchanged dependency
tree (`@modelcontextprotocol/sdk@1.29.0`, `fast-uri@3.1.5`, `qs@6.15.2`):

- `npm audit --json`: `{"info":0,"low":2,"moderate":3,"high":5,"critical":0,"total":10}` across 10
  packages — the 8 advisory packages of the 08-21 snapshot plus `qs` and `ajv`. (An earlier reading
  of this same command during drafting returned 9 keys without `ajv`; three consecutive re-runs
  return 10, so the 9 was a bad read and the 10 is the measurement. It is recorded rather than
  silently corrected, because the 9 is the number this section would otherwise have shipped.)
- `npm audit --omit=dev --json`: `{"info":0,"low":1,"moderate":3,"high":3,"critical":0,"total":7}`
  across `@hono/node-server`, `ajv`, `body-parser`, `fast-uri`, `hono`, `ip-address`, `qs`.

Three changes since 2026-08-21, and the first is the one that matters:

1. **`fast-uri` is back, on four advisories none of which existed at the last snapshot** —
   GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf and GHSA-jqff-g426-hqxp, all
   high, all host-confusion or SSRF in the same URI **parse** step as the three the row above
   triaged. The vulnerable range is `3.0.0 - 3.1.5` and the installed version is `3.1.5`, so the
   08-21 lockfile upgrade — which did clear the then-known advisories — no longer clears this
   package. `fast-uri` is the one package carrying an advisory **of its own** that ships inside
   `bin/helix-mcp.mjs` (3 files, confirmed in that snapshot's metafile), which is why it is listed
   first here. That qualifier is load-bearing as of this refresh: `ajv`, which carries no GHSA of
   its own and enters the audit only by inheritance from `fast-uri`, ships too and at 63 files, so
   "the one advisory package in the bundle" would no longer be true read against the production list
   above. The 08-21 reachability argument was that the sole AJV call site against
   caller-supplied data is `elicitInput`, which Helix never calls and whose schemas declare no
   URI/IRI format; that argument is about the call path rather than about any particular GHSA, so
   it plausibly carries over — **and it was re-verified the same day, though not in that form: the
   08-21 argument names the wrong sink. See "Reachability triage 2026-09-03" below for the
   disposition and the corrected mechanism.**
2. **`qs` is new** (moderate; GHSA-x5fp-wj9c-mxmx array-limit bypass, GHSA-4mjr-xmp4-gh2g
   attacker-controlled `isBuffer` DoS), reached as sdk → `express@5.2.1` → `qs`, the same Express
   subtree the `body-parser` row above triages as `bundled-unreachable`. Triaged below.
3. **`ajv` now appears as its own production entry**, via `fast-uri`. This is `npm audit`
   attribution bookkeeping of the kind the `@modelcontextprotocol/sdk` row already documents, not
   a tree change: `npm ls` still resolves the single sdk → `ajv@8.20.0` → `fast-uri@3.1.5` chain.

**Owed, and named here so it is not lost:** re-run the Method section's metafile reproduction and
re-trace the four new `fast-uri` GHSAs and the two `qs` ones to a verdict. That work moves nothing
in `bin/` by itself (`write: false`), so it does not disturb the release candidate.
*(DISCHARGED the same day — see the next section.)*

## Reachability triage 2026-09-03 — six advisories, all `bundled-unreachable`

This section discharges the item above. It does not re-state the 2026-08-21 reasoning; that
reasoning names the wrong sink, and the correction is recorded in the `fast-uri` row itself. What
follows was derived from scratch and by measurement.

### The scope this triage covers, and how it differs from 2026-08-21

The Method section reproduces `build.mjs`'s **first** `build()` call, covering **one** of the six
bundles `build.mjs` emits. This triage opened all six. Membership, measured against the shipped
bytes:

| bundle | bytes | fast-uri | ajv | qs / express |
|---|---|---|---|---|
| `bin/helix-mcp.mjs` | 955,649 | present (3 files) | present (63 files) | absent |
| `bin/helix-trigger.mjs` | 16,339 | absent | absent | absent |
| `bin/helix-rebaseline.mjs` | 35,455 | absent | absent | absent |
| `bin/helix-trust-resolve.mjs` | 136,458 | absent | absent | absent |
| `bin/hooks/session-start.mjs` | 52,135 | absent | absent | absent |
| `bin/hooks/session-end.mjs` | 2,956 | absent | absent | absent |

The server metafile reproduces at **255 inputs**, the same figure as 2026-08-21: `fast-uri` 3,
`ajv` 63, **`ajv-formats` 3** (a member the 08-21 table never listed), `@modelcontextprotocol/sdk`
16, `zod` 84; `qs`, `express`, `body-parser`, `hono`, `@hono/node-server`, `ip-address`,
`express-rate-limit`, `nanoid` and `postcss` are all zero. All six bundles are byte-identical to a
rebuild into a temporary directory, so these figures describe what ships rather than a hypothetical
build. Every one of the six imports only `node:`-prefixed specifiers — **zero bare specifiers in any
bundle** — so nothing resolves through `node_modules` at run time, and there is no dynamic loading
to defeat that (no `createRequire`, no non-literal `require(`/`import(`; the one `new Function` is
AJV's validator codegen, whose generated source carries neither).

Environment: Node **v24.17.0**, npm **12.0.2**. The Method section records v24.18.0 / npm 12.0.1 for
the two earlier snapshots; the metafile input count is unchanged across the difference.

### Where fast-uri actually runs (instrumented, not reasoned)

`fast-uri`'s exported functions were wrapped with counters and the SDK's own
`createDefaultAjvInstance()` reproduced verbatim (`strict:false, validateFormats:true,
validateSchema:false, allErrors:true`, then `addFormats`):

| operation | fast-uri calls | argument |
|---|---|---|
| `new Ajv(…)` + `addFormats` | 2 | `parse("http://json-schema.org/draft-07/schema")` — a constant |
| `compile({…format:'uri'…})` | 4 | `parse("")` |
| validating a hostile INSTANCE against that schema | **0** | — |
| `compile({$id:"http://attacker%2561…\@evil.test/s.json"})` | 4 | the attacker string reaches `parse` |
| `getSchema("http://attacker%2561…\@x.test/s.json")` | 4 | the attacker string reaches `parse` |
| `compile({…$ref:"http://attacker%2561…\@r.test/x.json#/d"…})` | 5 | the attacker string reaches `resolve` |

So the sink is schema identity resolution at compile time — `$id` through `parse`, `$ref` through
`resolve` — and instance data never reaches `fast-uri` at all. Two consequences worth stating
plainly: an audit that greps only for `.compile(` misses half the sink surface, because
`getValidator` tries `_ajv.getSchema(schema.$id)` first; and `fast-uri` DOES execute on every server
start, on a hardcoded literal.

### Why no attacker string arrives there

- `getValidator` is defined once in the shipped bundle (`bin/helix-mcp.mjs:23019`) and called from
  exactly one site (`:23596`), inside the SDK server's `elicitInput` (`:23578`).
- `elicitInput` has **no call site in the shipped artifact**: the only three occurrences of the token
  are a doc-comment example (`:23146`), the unrelated `elicitInputStream` definition (`:23179`), and
  its own definition. `/usr/bin/grep -rn "elicit" src/` returns nothing.
- Its `requestedSchema` is authored by the server that calls it, not supplied by the caller; the
  client contributes only the instance, which measures zero fast-uri calls.
- Helix's tool surface never reaches AJV. Driving the shipped bundle over stdio, the server answers
  exactly four methods — `initialize`, `ping`, `tools/list`, `tools/call` — and advertises only
  `{tools:{listChanged:true}}`; `resources/*`, `prompts/*`, `completion/complete`, `tasks/*`,
  `sampling/createMessage` and `elicitation/create` all return `-32601`. Tool arguments and outputs
  are validated by zod, never by AJV.
- Driving that same bundle with `fast-uri` instrumented, against payloads shaped like all four
  advisories across every registered tool and every reachable method, produced **2** fast-uri calls
  for the whole process lifetime — both from the eager `new AjvJsonSchemaValidator()` in the `Server`
  constructor (`:23303`), both on the constant above. No adversarial byte reached `fast-uri`.
- `shared/uriTemplate.js` is one of the 16 SDK metafile inputs but is entirely tree-shaken out of the
  emitted bundle, so it is not a URI-parsing surface here. A metafile input is not shipped code.

### Verdicts

| package | advisories | verdict | decision |
|---|---|---|---|
| `fast-uri` | GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp (4 × high) | `bundled-unreachable` — ships, and the vulnerable code is present in `bin/helix-mcp.mjs`, but the only sink is `$id`/`$ref` resolution and nothing reachable supplies one | **raise the pin** (see below), then accept |
| `qs` | GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g (2 × moderate) | `bundled-unreachable` — absent from all six bundles and unloadable at run time. Sinks named for the record: the array-limit bypass is in `qs.parse` under `comma:true` with a `[]` key; the `isBuffer` DoS is in `qs.stringify`, not `parse` | accept |
| `ajv` | none of its own (`via: ["fast-uri"]`, `range: ""`) | inherited attribution, not a finding | resolves with `fast-uri` |

Reachability here means "no attacker-controlled string reaches the vulnerable function". It does not
mean the vulnerable code is absent: it ships, and running the three `fast-uri` modules extracted from
`bin/helix-mcp.mjs` reproduces GHSA-5jgf and GHSA-jqff behaviourally, so the advisory match is
established by behaviour rather than by a version string.

### The 2026-08-21 pin is now the blocker

`package.json` carries `"overrides": { "fast-uri": "3.1.5" }`, added on 2026-08-21 as
defense-in-depth for the three advisories known then. The four new advisories cover `3.0.0 - 3.1.5`
inclusive, so that exact pin now holds the install — and, since the 2026-09-02 rebuild, the shipped
bundle — at a vulnerable version. It is also why `npm audit fix --dry-run` proposes bumps for nine
packages and **none for `fast-uri`**: the override forbids the move it would otherwise make.

`ajv` declares `^3.0.1` and `3.1.7` is the newest 3.x, outside the vulnerable range. **Decision:
raise `overrides.fast-uri` to `3.1.7`.** It is not applied in this commit: changing it moves
`node_modules`, which moves `bin/helix-mcp.mjs` at the next build, which the bundle-freshness check
would then report as stale. It therefore rides with the next rebuild, at the head of that batch,
and this paragraph is the record that the decision preceded the opportunity rather than following
it.
