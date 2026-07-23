# Deploy runbook — making installed bytes match intended bytes

Status: standing operational doc (C4.8 of `readiness-criteria-2026-07.md`). Every rule here
was learned from a live deploy failure; this file exists so the procedure no longer lives in
any assistant's session memory.

## The two failure classes

1. **Version-keyed cache trap.** The plugin cache is keyed by version string
   (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`). `claude plugin update` with
   an UNCHANGED version finds the cache dir already present and skips reinstalling — the old
   bytes keep serving while the marketplace clone advances. Any same-version redeploy
   (tracking a development branch; a hotfix without a version bump) hits this.
   Live-confirmed during the 2026-07 release drills (drill-1 finding C).
2. **Launch barrier.** New bytes serve NEW Claude Code processes only. A long-lived session's
   MCP server keeps the pre-install bytes pinned for its whole life, and `/clear` does NOT
   restart the MCP server. Observed live: a session pinned pre-install bytes across a day
   boundary (2026-07-10→11); the first fully barrier-compliant deploy was 2026-07-16 (server
   spawned seconds after install, zero mixed window).

Also observed once (2026-07-11): an **auto-update race** — reinstalling immediately after a
push captured pre-push bytes from a not-yet-refreshed clone. The verification step below is
what catches it; the fix is simply to redo the install.

## Staleness is `gitCommitSha`, never `version`

The version string cannot tell you whether the served bytes are current (that is the trap
above). The authoritative check is:

- `~/.claude/plugins/installed_plugins.json` → the plugin entry's `gitCommitSha`, vs
- the marketplace clone's HEAD: `git -C ~/.claude/plugins/marketplaces/<mp> rev-parse HEAD`, vs
- the commit you intended to deploy.

All three must be equal. For changes with a greppable marker (a new symbol or string),
additionally grep BOTH load paths — the marketplace clone AND the version-keyed cache dir —
for the marker; the two paths have disagreed in practice.

## The procedure (same-version redeploy — the common maintainer case)

```bash
# 0. Push the commit you intend to serve; note its sha.
claude plugin uninstall helix
claude plugin marketplace update helix
claude plugin install helix@helix

# Verify (all three shas equal, marker in both load paths). node, not jq — helix already
# requires node on PATH, while jq is absent on at least one real deploy box:
node -p "require(process.env.HOME+'/.claude/plugins/installed_plugins.json').plugins['helix@helix'][0].gitCommitSha"
git -C ~/.claude/plugins/marketplaces/helix rev-parse HEAD
grep -rl "<marker>" ~/.claude/plugins/marketplaces/helix ~/.claude/plugins/cache/helix
```

If the sha is stale (auto-update race): repeat uninstall → marketplace update → install.

Then honor the **launch barrier**: start a NEW Claude Code process (do not rely on `/clear`)
and live-verify one helix tool call from the new session. Long-lived sessions elsewhere keep
serving old bytes until they restart — that is expected, not a failed deploy.

## Ledger-format changes (mixed-window rule)

A change that affects what the ledger readers/writers accept must not straddle a window where
old bytes write records the new bytes cannot support (or vice versa). Deploy the plugin in the
SAME change window as the format change lands, and prefer the barrier-compliant order:
install first, then let only new processes write.

## Registry-safety mixed-version window (ownership hardening)

The ownership-registry hardening is a mixed-window case in its own right, distinct from a
ledger-format change. Pre-hardening bytes write `~/.helix/projects.json` WITHOUT a lock and rotate a
project's MAC nonce on every re-adopt. So while ANY pre-hardening session is still running (the launch
barrier not yet honored everywhere), a concurrent adopt or first-commit from an old-byte session can
still lose a registry entry or rotate a nonce — the exact corruption the new bytes prevent — after
which a later compaction can delete genuine verifies. Treat it like a format change: after installing
the hardened bytes, restart EVERY live session so no old-byte writer remains, and avoid concurrent
adopts across the window until all sessions run the hardened bytes. The launch barrier alone
guarantees a session serves new bytes; registry SAFETY additionally requires that no old-byte writer
survives anywhere.

## Version-bumped releases (the end-user case)

A normal version bump does not hit the cache trap — `claude plugin update helix` installs into
a fresh version-keyed dir. The launch barrier still applies: users must restart Claude Code to
get the new server. README's install section carries the user-facing caveat; this runbook is
the maintainer-facing procedure.
