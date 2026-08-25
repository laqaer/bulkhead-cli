# Changelog

This file starts at 0.1.3. Earlier releases (0.1.0 – 0.1.2) predate it; their
contents are recoverable from the git history, not summarised here.

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

`packages/core` 283 tests, 18 files. The integration suites drive the shipped
binary through the real Claude Code hook protocol rather than calling the guard
functions directly.
