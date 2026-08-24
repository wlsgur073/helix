# Recovery playbook — undoing an erase or a wrong supersede

Status: standing operational doc (accepted limitation **L2** of `readiness-criteria-2026-07.md`
§9: *"No one-step undo for permanent lifecycle operations… a short recovery playbook is owed in
docs"*). Every recipe below was executed against the shipped bundle on 2026-07-27 — no step is
inferred from source alone.

**There is no undo command.** Helix has no `unerase`, no `restore`, no inverse of a supersede at
the tool surface or in its API. Recovery means: *retrieve the old content, then re-commit it*.
What you get back is the text — not the identity, not the grade, not the history. Read §4 before
you decide the recovery is complete.

## 1. Which operation are you undoing?

| What happened | What it did | Content still on disk? |
|---|---|---|
| `helix_memory_erase` (the tool) | **Soft erase only.** Appends a content-free tombstone; the fact leaves the live view. The tool has no `permanent` option and cannot physically destroy anything. | **Yes** — until a compaction |
| Permanent erase (operator-only: `store.erase(id, { permanent: true })` from a script/REPL, never from a conversation) | Rewrites the ledger without the record | **No** — restore from backup is the only route |
| Wrong `supersedes` on a commit | Appends the replacement; the old row leaves the live view | **Yes** — until a compaction |

If an agent erased something on your behalf, it used the tool, so it was a **soft** erase.

**The flip side: a soft erase does not destroy anything.** If you erased a fact *because it was
sensitive*, the text is still sitting in the ledger file in plaintext — that is the same property
this playbook exploits for recovery, and with stock config (auto-compaction off) nothing ever
removes it. To actually destroy it you must either enable compaction deliberately (README,
"Automatic compaction") or run the operator-only permanent path. And even then, erasure is
namespace removal, not media sanitization: copies, snapshots and backups you already took still
hold the text.

A caveat worth knowing before you panic or relax: `helix_memory_erase` answers `erased <id>`
even for an id that does not exist or is already dead. A success message is not proof that
anything was erased.

## 2. Is the undo window still open?

The window closes only when a **compaction** physically rewrites the ledger. Check, in order:

1. **Is auto-compaction even on?** It is **off by default**. Look for a `compaction` block with
   `"auto": true` in `~/.helix/config.json` — and nowhere else: a project `.helix/config.json`
   cannot enable it. With stock config the window never closes on its own.
2. **Ask the ledger for the truncation signal.** Run `helix_memory_inspect` with `history: true`.
   If the output carries
   `(history may be truncated by a past compaction — older closed entries are not retained)`,
   a compaction has already run — treat that as "the window may have closed" and go to backups.
3. **Check the rewrite log.** `~/.helix/witness-log.jsonl` gets one line per ledger rewrite,
   e.g. `{"v":1,"scope":"@global","epoch":2,"kind":"compaction","tx":"…"}`. This file is written
   whether or not metrics are enabled, so it is the most reliable answer to "did something
   rewrite my ledger, and when?". If no line for your scope is dated after the erase, the window
   is still open.
4. **Look at the file.** The ledger is plain JSONL: `~/.helix/memory.jsonl` (global) or
   `<project-root>/.helix/memory.jsonl` (project). If you can still `grep` your text there, the
   content exists and §3 will work.

## 3. Retrieve the content

**The trap: `history` will not give you erased text back — `asOf` will.** An erase-closed row is
rendered with its content blanked; a supersede-closed row keeps its content. Verified side by
side on 2026-07-27:

```
DATA[erase:global:…T14:21:20.670Z..…T14:21:21.966Z]| m_94c548dc-…
DATA[supersede:global:…T14:21:52.511Z..…T14:21:52.639Z]| m_2547c959-… l2 supersede probe: original wording kept for history
```

So:

- **After a soft erase** — use the point-in-time snapshot, not history. Two steps:

  1. `helix_memory_inspect` with `history: true`, and read the interval off the erased id's row:
     `DATA[erase:global:2026-07-27T14:21:20.670Z..2026-07-27T14:21:21.966Z]| m_94c548dc-…`
     The **first** timestamp is when the fact was written; the second is when it was erased.
  2. `helix_memory_inspect` with `asOf` set to that **first** timestamp, copied verbatim. The
     content comes back in full.

  Any instant in `[tx, txTo)` works; the closing timestamp does not (at that instant the erase
  is already in the snapshot and the fact is gone). The instant must be canonical to the
  millisecond with a trailing `Z` — anything else is refused. Note that the snapshot shows the
  grade **as of that instant**: if you pass the fact's own `tx`, a confirmation that happened
  later has not occurred yet, so it renders `Fresh` even for an item that was `Verified` when
  you erased it. That is the snapshot being honest about time, not a lost grade — and it makes
  no difference to recovery, since a re-commit starts at `Fresh` regardless (§4). To see the
  grade the fact actually held when you erased it (so you know whether to re-confirm in §5),
  pass an instant just *before* the closing timestamp instead.
- **After a wrong supersede** — either mode works: `history: true` shows the old row with its
  content intact, and `asOf` before the replacement's tx shows it live.
- **Either case, fastest route** — `grep` the ledger file directly. The old row is the
  `"type":"assert"` (or `"supersede"`) line whose `id` is quoted in the tombstone's
  `supersedes` field.
- **After a permanent erase** — none of the above exist. Restore from backup (§6), knowing that
  restoring an older ledger trips the rollback witness by design.

`history` and `asOf` are mutually exclusive; passing both is refused.

**Which ledger was it in?** The rendered rows tell you: `DATA[erase:global:…]` versus
`DATA[erase:project:…]`. Both scopes are searched together, so run these calls from the same
project directory you were working in when the fact was written — otherwise the project layer
is not active and a project-scope fact will not appear at all. When you re-commit (§4), a
commit made from that directory lands in the project ledger by default; pass
`scope: "global"` or `scope: "project"` to be explicit.

## 4. Re-commit — and know what you are NOT getting back

Re-commit the retrieved text with `helix_memory_commit`. For a wrong supersede, pass
`supersedes: <the wrong replacement's id>` so the chain stays coherent (superseding the wrong row
is better than erasing it — an erase leaves a content-blank history row, a supersede leaves a
readable one).

Pass `source: "user"` if you are authoring the correction — it is also the only source that can
be re-confirmed later (§5).

Pass `scope` matching the ledger the old row lived in — the `global`/`project` tag you read in
§3. This is not cosmetic when you are superseding: a supersede whose target lives in the *other*
ledger is refused with
`commit: cannot supersede across scopes (target lives in a different ledger)`. Working inside any
project directory that has a `.helix/` folder, a commit defaults to the **project** ledger, so
repairing a *global* fact from there needs `scope: "global"` explicitly.

| Property | Comes back? |
|---|---|
| The text | Yes (the secret scanner runs again on it) |
| Item id | **No — a new `m_<uuid>`.** Anything referencing the old id now dangles |
| Trust grade | **No — the new item is `Fresh`**, whatever the old one was |
| Signed verifications | **No.** A verify is bound to the old id *and* the old content digest; it cannot be replayed onto the new item |
| Transaction time / bitemporal interval | **No.** The new row starts today; the old interval stays in history under the old id |
| Provenance source / session | Only what you pass now |
| `blastRadius`, `classification` | Only if you re-pass them |

## 5. Re-establish trust

- Was it **`Verified`**? Call `helix_memory_confirm` on the NEW id. This requires that you
  re-committed with `source: "user"` — otherwise it is refused with
  `confirm: only a source=user item is eligible (re-commit as source=user to take authorship first)`.
- Was it **`Corroborated`**? Re-run `helix_memory_recheck` with the same file check. Both the
  path and the pattern must literally appear in the new content, or the call is rejected.
- Anything else that pointed at the old id — your notes, another fact's text — needs updating by
  hand. Nothing rewrites references for you.

## 6. Prevention (cheaper than every recipe above)

**Back up both units, quiesced.** Close Claude Code sessions first (an external copy is not
covered by Helix's own file lock, so a copy taken mid-rewrite can catch an inconsistent instant),
and make sure no scheduled run is due. Then, with the project under `$HOME`:

```bash
mkdir -p ~/backups
tar -czf ~/backups/helix-$(date +%F).tar.gz -C ~ .helix dev/<project>/.helix
```

For a project **outside** `$HOME`, either take one archive per unit:

```bash
tar -czf ~/backups/helix-global-$(date +%F).tar.gz -C ~ .helix
tar -czf ~/backups/helix-app-$(date +%F).tar.gz -C /srv/code/app .helix
```

or keep one archive by anchoring the second unit at `/` (note the leading slash is dropped from
the member path, which is what keeps it distinct):

```bash
tar -czf ~/backups/helix-$(date +%F).tar.gz -C ~ .helix -C / srv/code/app/.helix
```

⚠️ **Do not** write it as `tar -czf out.tgz -C ~ .helix -C /srv/code/app .helix`. Both units then
archive under the same `.helix/` member path, and on extraction the project ledger **overwrites
your global one** — verified by hash on 2026-07-27, GNU tar 1.35. Verify any archive before trusting
it — `tar -tvzf <archive>` for a plain one, and the two-step form below for an encrypted one. File
modes, including the key's `0600`, survive both.

Back up: `~/.helix/` entirely (ledger, `ledger-mac-master.key`, `projects.json`, `witness.json`,
`witness-log.jsonl`, config, audit, metrics) **and** each project's `<root>/.helix/` (ledger +
`.owner`). Enumerate adopted projects from the keys of `~/.helix/projects.json` — every key
except the reserved `@global` entry. Copy — never `ln`: a hard-linked ledger is refused by every
write path.

**Encrypt it — the archive carries the key that makes grades unforgeable.** `~/.helix/` holds
`ledger-mac-master.key` at `0600`, and that key is what stands between someone holding a copy of the
archive and a forged `Verified` or `Corroborated` grade. A plain `tar.gz` hands it over intact, so an
unencrypted backup trades one exposure for another. Pipe `tar` into `gpg` so the plaintext archive
never reaches the disk at all:

```bash
mkdir -p ~/backups
tar -czf - -C ~ .helix dev/<project>/.helix \
  | gpg --symmetric --cipher-algo AES256 -o ~/backups/helix-$(date +%F).tar.gz.gpg
```

`gpg` prompts for the passphrase, and on a machine that has never run it the command also creates
`~/.gnupg` (observed 2026-08-24). Symmetric is deliberate: there is no private key to lose, and the
file describes its own format, so it opens years later on any machine with GnuPG. (Without a TTY, add
`--batch --pinentry-mode loopback --passphrase-file <file>` — never `--passphrase` on the command
line, which puts the secret in the process table.)

**The passphrase has to be reachable without the machine you are backing up.** If it lives only in
that machine's password store, the archive is unopenable in the exact situation it exists for. That
is the same property Q1 asks of the GitHub recovery codes — different secret, same requirement.

**Verify without extracting**, and confirm the key's mode survived:

```bash
gpg -d ~/backups/helix-<date>.tar.gz.gpg | tar -tvzf -   # expect -rw------- on ledger-mac-master.key
```

**To restore, decrypt to a file FIRST and check the exit status — never pipe decryption straight
into `tar -x`:**

```bash
gpg -d -o /tmp/helix-restore.tar.gz ~/backups/helix-<date>.tar.gz.gpg \
  && tar -xzf /tmp/helix-restore.tar.gz -C <destination>
```

⚠️ **Why two steps, measured 2026-08-24 (GnuPG 2.4.4) rather than assumed.** GnuPG checks the
archive's integrity at the END of the stream, so it emits plaintext first and only then discovers a
modification. Against a one-bit-flipped archive it printed
`WARNING: encrypted message has been manipulated!` and exited 2 — correct — but **the entire
plaintext archive had already reached stdout by then** (all 410 bytes of a deliberately tiny probe
fixture; what matters is that it was *all* of it, and the mechanism does not change with size), and
`gpg -d … | tar -xzf -` left `.helix/witness.json` on disk in the destination. **Without
`set -o pipefail` that pipeline reported exit `0`** while a partial, unverified tree sat there. The
detection is not early enough to protect a consumer downstream of the pipe; only the `&&` form
above is, because nothing is extracted until `gpg` has finished and succeeded.

**What this does not undo.** It protects archives written from here on. Any plain `tar.gz` an
earlier command already wrote still carries the key in the clear — delete those, and if one ever
left the machine, treat the key as exposed and re-key rather than re-encrypt.

Cadence that fits a personal-scale install: before any upgrade or destructive operation, plus one
fixed quiet slot per week.

**Other cheap protections**

- Leave `compaction.auto` **off** unless you need it. If you turn it on, keep `graceMs`
  generous — once the size and dirtiness gates are met it is the last barrier between a soft
  erase and physical destruction, and a forward clock jump of at least `graceMs` can fire
  compaction early.
- Keep `metrics.enabled` on (the default) if compaction is on: it is what records *how much* a
  compaction reclaimed and whether it failed. (That a rewrite happened at all is recorded in
  `~/.helix/witness-log.jsonl` regardless of the metrics setting — §2.)
- Restoring an older ledger clamps that scope's elevated grades to `Fresh` on the live views,
  with a disclosure note — by design. (A point-in-time `asOf` snapshot is not clamped; it reports
  what was true then, and says so in its own note.) **While that alarm stands you also cannot
  promote anything in that scope:** `helix_memory_confirm` and a passing `helix_memory_recheck` are
  refused, because a grade minted during an alarm is indistinguishable afterwards from an honest
  one and the re-baseline below would adopt it wholesale. Ordinary commits, soft erases and
  *demotions* still work — a scope under suspicion must stay able to record that something failed.
  Establish that the current bytes are the ones you want before re-baselining; the refusal is there
  to stop the recovery from blessing whatever is in the file. The sanctioned way to adopt an old backup deliberately is the re-baseline
  ceremony: `node bin/helix-rebaseline.mjs --scope global` (or `--scope <absoluteProjectRoot>`),
  which is interactive and TTY-only — it prints the scope, byte count and hash, and waits for you
  to type `bless`. It cannot be scripted away with a flag.
- **A restored project ledger arrives unadopted.** Ownership lives in `~/.helix/projects.json`
  plus the in-repo `.owner` stamp, so a project ledger restored into a fresh clone (or at a new
  path) is treated as foreign: its rows are excluded from results and you get
  `(an unadopted project memory file is present and excluded from results; adoption requires
  explicit user approval)`. Call `helix_memory_adopt` from that directory to bring it back —
  and expect its elevated grades to read `Fresh` afterwards (trust is machine- and scope-local).
- **What still works in a mismatch state:** reads keep serving with the disclosure note and
  clamped grades, and ordinary appends still land — so recovery by re-commit is available. What
  is refused is a *rewrite*: a permanent erase or a compaction on an alarmed scope, precisely so
  the alarm cannot be laundered away. Clear it with the re-baseline ceremony above.

## Related documents

- README — "Automatic compaction" (what closes the window, and the `graceMs` semantics),
  "Backup, restore & recovery" (key loss, corruption, migration honesty),
  "Uninstall & data removal".
- `SECURITY.md` — why permanent erase is deliberately off the tool surface; the supersede
  guard's honest scope (a `Corroborated` item from a non-authoritative source is not protected);
  erasure is namespace removal, **not** media sanitization (external copies, snapshots and freed
  blocks are outside any userspace design's reach — a backup you took still holds the text).
- `deploy-runbook.md` — install/upgrade procedure and the launch barrier.

---

Validated 2026-07-27 against the installed 0.1.0 bundle @ `afc29c4` on an isolated `HELIX_HOME`:
the history-vs-`asOf` asymmetry, the success answer for an unknown erase id, the confirm
eligibility refusal, plaintext survival after a tool erase, and both `tar` forms.
