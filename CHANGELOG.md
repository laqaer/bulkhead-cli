# Changelog

by: myrmitis LLC

This file starts at 0.1.3. Earlier releases (0.1.0 – 0.1.2) predate it; their
contents are recoverable from the git history, not summarised here.

## 0.2.0 — 2026-10-15

### Fixed

- **`rm -rf ~/backups` passed the outside-the-workspace check.** Only an exact
  `~` or `~/` was special-cased; `resolve(root, "~/backups")` treated `~` as a
  directory inside the repo, and `$HOME/...` / `${HOME}/...` were never
  expanded. A leading `~`, `$HOME` or `${HOME}` (quoted or not) now expands to
  the real home directory before the workspace test, so a repo at
  `~/code/thisrepo` can still `rm -rf ~/code/thisrepo/dist`. `~otheruser/...`,
  and any home that cannot be determined, are denied.
- **`cp -t .claude f` slipped past the protected-path check.** The destination
  of `cp`, `install`, `mv` and `ln -f` was read only from the last positional
  word, so `-t DIR`, `-tDIR`, `-ft DIR`, `--target-directory DIR`, `=DIR` and
  GNU's abbreviations such as `--target` hid it: an agent could overwrite
  `.claude/settings.json` or the ledger directory while the guard allowed the
  command. Each source is now checked at `DIR/<its name>`. A glob or variable
  source is still not expanded.
- **The agent could edit its hooks out.** `.claude/settings.json` and
  `.claude/settings.local.json` — where Claude Code loads the hooks that run
  Bulkhead — were ordinary writable files. They, and `rm -rf .claude`, are now
  in the immutable self-protection boundary with `bulkhead.yaml` and
  `.bulkhead/`. The rest of `.claude/` stays writable. `bulkhead init` writes
  the file directly, not through a hook, so install and upgrade are unaffected.
- **The agent could reset its own policy through Bulkhead's installer.**
  `npx @bulkheadtools/cli init --force` rewrote `bulkhead.yaml` to the
  default preset, and `init --command true` could rewire the hooks to a
  no-op. Bulkhead's own `init` and `uninstall`, run through Bash in any
  common form (`bulkhead`, `npx`/`bunx`/`pnpm dlx`/`npm exec`, `node …/cli.js`
  from the package or a bulkhead checkout, inside `sh -c`), are now denied as writes to the self-protection boundary.
  A human runs them from their own terminal.
- **The demo and the policy file overstated the completion check.** They
  said the agent "may not finish" / is refused "to finish"; it is sent back
  to work once, and a repeat stop is recorded. Wording fixed in `demo`,
  the `bulkhead.yaml` template and `--help` (which now also states the
  redaction limit). Receipts count "file edits", not "files modified" — one
  file edited twice is two edits.
- **Clearing a cache was "deleting outside the project".** `rm -rf
  ~/.npm/_npx`, `~/.cache/pip` and `/tmp/build-cache` were denied by the
  outside-the-workspace rule. Temp directories, `~/.cache/*`,
  `~/Library/Caches/*` and npm's `_npx`/`_cacache` caches are now clearable;
  the roots themselves, globs, `..` escapes, symlinks that resolve elsewhere,
  the workspace and anything containing it stay denied. Three corpus
  controls pin it.
- **Subagent spend was missing from the caps.** Claude Code writes each
  subagent's turns to `<session>/subagents/*.jsonl`, and only the main
  transcript was summed. Session and daily spend now include them.
- **A fail-open was silent.** An internal error or unreadable payload wrote
  to stderr and exited 0, which Claude Code shows to no one. The hook now
  also emits a `systemMessage` saying the call was not checked; it carries
  no decision, so behaviour is otherwise unchanged.
- **`git push origin +main` was not a force-push to main.** A `+` refspec forces
  that ref with no `--force` flag; the structured check only looked at flags.
  It now denies a `+` refspec whose destination is main/master.

- **Commit messages and PR bodies are prose, not commands.** `git commit -m
  "fix: delete from cart"` matched the unscoped-DELETE rule. A segment that is
  exactly `git commit` or `gh pr|issue create|edit|comment` is now eligible for
  the inert-text exception, under the same whole-command rule.
- **Current model prices.** Added Claude Opus 5.5 ($4/$20, $0.20 cache reads),
  Opus 5, Fable 5.1 ($0.25 cache reads) and Mythos 5.1; corrected Sonnet 5 to
  $2/$10. Date-suffixed ids now resolve to the longest matching prefix, so
  `claude-opus-5-5-…` can never be priced as `claude-opus-5`. Prices may set a
  per-model cache-read rate (`cacheReadPerMTok`).

### Added

- **A recursive delete of a Windows drive root is denied.** `rmdir /s /q d:\`,
  `rd /s`, and PowerShell `Remove-Item -Recurse D:\` are built-in rules; only
  the bare root matches, so `rmdir /s /q build` and `rmdir /s /q d:\cache`
  stay allowed. Other Windows deletes (`del /s`, `format`, `robocopy /mir`)
  are not covered. One corpus incident and one control pin it.
- **Reading a credential file is a high-risk signal.** `cat`, `grep`, `cp`,
  `base64 <` and similar aimed at `~/.pgpass`, `~/.netrc`, `~/.git-credentials`,
  `~/.aws/credentials`, gcloud application-default credentials or a private
  key `~/.ssh/id_*` are scored `credential-read`, so `risky.mode: ask` pauses
  them and `bulkhead inbox` ranks them. It is not a deny, and at the default
  (`risky.mode: off`) nothing changes except the recorded score. A public key,
  `~/.ssh/config`, `~/.aws/config` and a relative `.pgpass` are not flagged.
  Best effort: a script, an interpreter, a symlink or a glob over the directory
  is not seen.
- **`bulkhead uninstall`.** Removes Bulkhead's hooks from
  `.claude/settings.json` and nothing else — your other hooks, permissions
  and settings stay, and an emptied `hooks` block is dropped. `bulkhead.yaml`
  and `.bulkhead/` (the ledger) are kept; the command prints how to delete
  them.
- **Shell writes inside `sh -c '…'`** get the same protected-path check.
- **Template env files are writable by default.** `.env.example`,
  `.env.sample` and `.env.template` are carved out of `.env.*` and listed
  under `protected_paths.allow` in a new policy file, so a team can take them
  back out. `.env` and every other `.env.*` stay protected.
- **Protected paths hold against the obvious shell writes.** `sed -i`,
  `perl -pi`, `>`/`>>`/`&>` redirects, `tee`, `cp`/`install` destinations,
  both sides of `mv`, `truncate`, `dd of=` and `ln -f` are now checked against
  protected paths and the immutable boundary, so `sed -i … bulkhead.yaml` or
  `echo '{}' > .claude/settings.json` is denied like the Edit tool already was.
  Quote-aware, so text that only mentions these is untouched. Three corpus
  cases pin it, with the installer rows.

- **Incident pack in the built-in command rules.** Always on, conservative:
  an unscoped SQL `DELETE` (no `WHERE`), `terraform destroy`/`apply -destroy`,
  `pulumi destroy`, GraphQL delete mutations POSTed to a non-loopback host,
  `railway volume delete`, `aws s3 rm --recursive`, `aws s3 rb --force`,
  `aws rds delete-db-instance|cluster`, `kubectl delete namespace`,
  `redis-cli FLUSHALL|FLUSHDB`, `dropDatabase()`, `supabase db reset --linked`,
  `gh repo delete`, `heroku pg:reset`, `fly volumes destroy`,
  `gcloud sql instances delete`.
- **`bulkhead init --preset default|strict`.** Strict adds a commented block of
  routine-but-destructive commands for unattended runs (`git reset --hard`,
  any forced `git clean`, any force-push without lease, `drizzle-kit push
  --force`, `prisma migrate reset`, `prisma db push --force-reset`, docker
  volume deletes, `docker compose down -v`, Rails/Laravel/Django database
  resets). An unknown preset is refused before anything is written; an existing
  `bulkhead.yaml` is kept unless `--force`, and init says so.
- `bulkhead.yaml`'s rule lists are now generated from the enforced lists, so
  the file a user reads cannot drift from what runs (the fork-bomb rule had
  already drifted out of it).
- **Blocks are visible to the human.** Claude Code shows a PreToolUse deny
  reason and a Stop `reason` to the agent only. Every deny, blocked stop and
  budget pause now also emits a one-line `systemMessage`, which Claude Code
  shows the person running the session. It names what was blocked and why and
  gives the ledger entry, with the command clipped to 80 characters and
  credentials masked. The payloads the agent reads are unchanged.
- **`bulkhead demo`** replays the incident corpus through the real hook
  entrypoints in a throwaway repo. It also plays a false "tests pass" story
  and a budget-cap story, then verifies the resulting ledger. Every result is
  compared with the corpus expectation for the preset, and any mismatch is
  printed and exits non-zero. `--json` is for machines and `--keep` leaves the
  demo repo on disk. The command never touches the user's repo.
- **`bulkhead receipt`** puts one session on one page: markdown for a PR
  description, a 48-column text receipt, or a self-contained HTML page. It
  covers blocks with human reasons, risky actions that were allowed, spend
  against the cap, each completion claim with its deciding evidence, and the
  ledger head and verify status. Redaction is on by default (repo-relative
  paths, masked credentials); `--no-redact` turns it off.
- **`bulkhead badge`** prints a README badge snippet. It writes no files.

### Fixed

- **Hard links bypassed protected-path matching**
  ([#3](https://github.com/laqaer/bulkhead-cli/issues/3)). A hard link is a
  second directory entry for the same inode, so `ln .env hardcopy.conf` then
  writing `hardcopy.conf` wrote `.env` while the guard reported `allow` — and
  the same trick against `bulkhead.yaml` or `.bulkhead/ledger.jsonl` let an
  agent rewrite its own policy or truncate the ledger tail. When a write target
  has more than one link, the guard now enumerates every existing file a deny
  or immutable glob can match and compares device + inode. A protected alias
  denies with the alias's rule; a scan that cannot finish (unreadable protected
  directory, or more than 20,000 entries under unanchored globs) fails closed.
  Single-link files — nearly all of them — cost one extra `stat`. Nothing is
  cached, so a link created after the policy loaded is still caught. `rm` of an
  alias stays allowed: unlinking one name leaves the protected file intact.

### Changed

- Denials are described in words everywhere they are printed. `report`,
  `status`, `receipt` and the notice say `SQL DROP TABLE` or `protected path
  (.env)`, not the rule's regex. `status` prints stop denials as
  `Stop [verify] contradicted: "…"` instead of a blank row.
- `inbox` and `notify` mark denied actions `(blocked)` so a refused force-push
  never reads as one that ran, and they show paths relative to the repo.
- `ledger tail` adds a one-line command, path, evidence or verdict summary to
  each entry.
- `init` ends with two next steps: `demo` and `badge`.
- **`ENOSPC` now fails closed for Bulkhead state writes.** Capacity exhaustion
  makes `.bulkhead/` unavailable just like a permission or read-only-filesystem
  failure: enforcement cannot finish evaluating the call and the evidence
  ledger cannot record it. PreToolUse now denies and Stop blocks until a human
  frees blocks or inodes, while unrelated errnos keep the historical fail-open
  behaviour. The refusal names the capacity fix instead of suggesting `chmod`.

### Tests

- The `hard links are NOT covered` pins are inverted: Write, Edit, MultiEdit
  and NotebookEdit through a hard link to a protected file now deny, including
  through a chain of links, links created after the policy loaded, and aliases
  of `bulkhead.yaml` and the ledger. Controls pin that unprotected multi-link
  files, allow-exempted protected names, and `rm` of an alias stay allowed.
- A hard link to a host file outside the workspace is pinned as a known
  limitation, alongside the absolute deny glob that closes it for named paths.
- The named fail-closed errno table now pins `ENOSPC`, with `EIO`, `EMFILE`, and
  `ENOENT` retained as explicit fail-open controls and a focused assertion for
  the capacity-specific remediation.
- `test/corpus.test.ts` drives every incident-corpus case through the real
  PreToolUse entrypoint under both presets and pins the expected verdict,
  including the known misses and the benign controls.
- `test/incident-pack.test.ts` gives every new rule a positive (asserting the
  rule's own message) and a benign control, and bounds evaluation time on
  adversarial input; `test/templates.test.ts` parses both policy files back and
  holds them to the enforced lists.

## 0.1.3 — 2026-08-25

Security release. Three ways to walk a write past the protected-path guard, and
one way to walk past completion verification. All four were found by reviewing
our own shipped artifact, not reported by a user.

### Fixed

- **Protected-path matching was case-sensitive.** On a case-insensitive volume
  (the macOS default), `.ENV`, `.Env`, `.ENV.local`, `PROD/`, `Prod/`,
  `Migrations/` and `.Bulkhead/` all reached the real protected file while the
  guard reported `allow`. `.bulkhead/**` is the ledger, and the hash chain
  detects edits and mid-chain deletes but not tail truncation — so this bypass
  granted exactly the change the ledger cannot see. Matching is now
  case-insensitive.

- **Symlinked ancestors defeated the guard (F1).** The guard matched path
  strings. `ln -s prod gate` is not an `rm` shape, so it passed the Bash checks,
  and a subsequent `Write gate/evil.txt` matched nothing. Matching now runs on
  both the lexical path and its realpath-resolved form, resolving from the
  deepest ancestor that exists so a not-yet-created leaf still resolves.
  Resolution is deny-widening only — it can never remove a deny.

- **`chmod 000 .bulkhead` was a silent off switch (F2).** Bulkhead's state
  directory *is* the enforcement substrate: ledger, spend rollup, loop state.
  Any error touching it was caught by the general fail-open handler, so a
  guarded agent could disable every guard *and* the audit trail with one
  ordinary command while `ledger verify` kept reporting the frozen prefix
  healthy. Permission-class failures there (`EACCES`, `EPERM`, `EROFS`) now fail
  closed, with a message naming the fix.

- **The same trick worked against the Stop hook (F2b).** `handleStop`'s
  state-dir writes were outside the new guard, so the off switch also let a
  false "all tests pass" completion through. It now returns the Stop hook's own
  blocking shape, and deliberately ignores `stop_hook_active` — suppressing the
  block on retry would restore the bypass.

- **The state-dir denial pointed the human at the wrong remedy.** The generic
  refusal footer says "a human must change bulkhead.yaml", which is right for a
  policy guard and wrong for this one — no policy edit restores an unwritable
  `.bulkhead/`. The state-dir refusal now names restoring filesystem access and
  says explicitly that editing `bulkhead.yaml` will not help, so the footer
  cannot contradict the `Why` line directly above it.

### Deliberately not changed

- **`ENOSPC` still fails open.** It has the same silent-off-switch outcome, but
  it arrives without anyone choosing it and its blast radius is machine-wide;
  failing closed there would brick every agent on the machine during a disk
  incident. Tracked in https://github.com/laqaer/bulkhead-cli/issues/4.

- **Everything else still fails open, loudly.** A bug in a guardrail must not
  brick the agent it guards. The state directory is the one exception, because
  the guarded process can cause its failure on purpose.

### Known limitation, newly disclosed

- **Hard links are not covered.** A hard link is a second directory entry for
  the same inode, so there is no link for `realpath` to resolve:
  `ln .env hardcopy.conf` then writing `hardcopy.conf` is allowed. The exposure
  is bounded — the OS refuses to hard-link a directory, so no new file can
  appear inside a protected directory this way, only an already-existing
  protected file can be modified, and the write is still recorded in the ledger.
  Now stated in the README and pinned by tests that go red when a fix lands.
  Tracked in https://github.com/laqaer/bulkhead-cli/issues/3.

### Tests

`packages/core` 284 tests, 18 files. The integration suites drive the shipped
binary through the real Claude Code hook protocol rather than calling the guard
functions directly.
