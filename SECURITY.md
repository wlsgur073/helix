# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Reporting a vulnerability

Please report security issues **privately** via GitHub's "Report a vulnerability"
(the **Security → Advisories** tab on
[`wlsgur073/helix`](https://github.com/wlsgur073/helix/security/advisories/new)).
Do **not** open a public issue for a vulnerability. Expect an initial
acknowledgement within a few days.

## Trust model (what Helix guarantees)

- **Provenance firewall (fail-closed):** a mechanical reality-check (`helix_memory_recheck`)
  raises a fact only to `Corroborated`; only you (`helix_memory_confirm`) can promote it to
  `Verified`; agreement from an external model never does. These are honest grades, **not
  adversary-proof** — an agent with filesystem/ledger write can forge either, so do **not**
  allow-list `helix_memory_confirm`.
- **Trust states:** `Fresh / Corroborated / Verified / Suspect`, with re-verify-before-use on
  high-blast-radius paths.
- **Secret handling:** memory is secret-scanned and redacted before it is persisted;
  the dual-verify egress guard hard-blocks credential tokens (override-proof — a
  config policy of `allow` cannot release them).
- **Untrusted content** (recalled memory, external-model output) is treated as DATA,
  never instructions: NFKC/control/bidi normalization + per-line datamarking + a
  per-call nonce frame.
- **Local-first:** no telemetry; the only outbound path is the opt-in `helix_dual_verify`
  call, which is off by default and egress-gated.

## Scope / non-goals

The dual-verify echo check is a **verbatim-copy tripwire, not a robust exfiltration
guard** against a host model that transforms content before emitting it. The primary
boundary is the provenance firewall + secret-scan + the DATA-quarantine; the egress
guard and echo tripwire are defense-in-depth.

## Handling of sensitive data at rest

- `~/.helix/audit.jsonl` is content-free (enums / IDs / labels only).
- `~/.helix/codex-log.jsonl` exists only if you opt in (`dualVerify.logContent: true`);
  it stores the exact prompt/response, is created `0o600`, and is capped. A
  firewall-refused payload is never written there.
