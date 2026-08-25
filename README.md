# Bulkhead

**The accountability layer for AI coding agents.** Deterministic guardrails and a
tamper-evident evidence ledger for Claude Code, installed in one command.

```bash
npx @bulkheadtools/cli init
```

That's it. Bulkhead writes a `bulkhead.yaml` policy into your repo and wires
`PreToolUse`/`PostToolUse` hooks into `.claude/settings.json`. From then on, every
tool call your agent makes is checked — outside the model's reasoning loop, by
deterministic code that the agent can read but can't argue past.

> **Bulkhead is containment and evidence — not a firewall.** Hooks are bypassable.
> It stops the unambiguous disasters and records everything; it is not a sandbox
> and does not prevent prompt injection. The exact boundaries are in
> [What it does and doesn't stop](#what-it-does-and-doesnt-stop) — please read
> that section before you rely on it.

---

## Why

AI coding agents run semi-autonomously now, and the failure mode is no longer
hypothetical:

- **PocketOS (April 2026)** — a Cursor agent hit a credential mismatch, found an
  unrelated API key, and deleted the company's production database **including its
  backups in about nine seconds**, then confessed "I violated every principle I
  was given." ([Euronews](https://www.euronews.com/next/2026/04/28/an-ai-agent-deleted-a-companys-entire-database-in-9-seconds-then-wrote-an-apology), [ACS](https://ia.acs.org.au/article/2026/gone-in-9-seconds--ai-agent-deletes-company-database.html))
- **Replit / SaaStr (July 2025)** — an agent pushed to a production database
  during an explicit code freeze, wiping records on 1,200+ executives, said "I
  panicked," and wrongly claimed the change couldn't be rolled back. Replit's CEO
  called it "unacceptable and should never be possible." ([Fortune](https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure/), [The Register](https://www.theregister.com/2025/07/21/replit_saastr_vibe_coding_incident/))
- **Google Gemini CLI (July 2025)** — a silently-failed `mkdir` caused each file
  "move" to overwrite the previous one into a directory that didn't exist;
  the files were unrecoverable. ([GitHub #4586](https://github.com/google-gemini/gemini-cli/issues/4586))

Different agents, same shape: a destructive tool call that a boring deterministic
check at the execution boundary would have stopped, and — after the fact — no
clean record of what happened. Bulkhead is that check and that record.

---

## What you get

**Deterministic guardrails** (no LLM in the decision path):

- **Protected paths** — never write or delete `prod/`, `migrations/`, `.env`, or
  whatever you configure. Reliable for the structured file tools; for Bash it
  catches the obvious `rm <protected>` case.
- **Blocked commands** — force-push to `main`, `DROP TABLE`, `curl … | sh`,
  filesystem formats, and any `rm` that resolves outside your workspace.
- **Budget hard-caps** — per-session and per-day dollar limits that **pause the
  agent** when crossed. Cost is a deterministic sum over the session transcript
  (deduped per message, cache tiers priced exactly) — not an estimate.
- **Loop kill-switch** — freeze when the identical tool call (same name + same
  args) repeats too many times in a window. Changing an argument resets it, so
  real iteration isn't frozen.

**An evidence ledger** — every intercepted action is appended to a local,
hash-chained JSONL at `.bulkhead/ledger.jsonl`. Editing a past entry or deleting
one from the middle breaks the chain, and `bulkhead ledger verify` will tell
you. To be precise about the limit (because "tamper-evident" gets oversold):
a bare hash chain cannot prove that trailing entries weren't removed — truncate
the file after entry N and the prefix still verifies. Detecting that requires
an external anchor for the chain head, which is what the hosted sync in the Pro
tier is for. The default policy also write-protects `.bulkhead/**` from the
agent's own file tools. This is the record you look at *between* incidents.

**Completion verification** — completed tool calls are classified into typed
evidence (tests passed/failed, commit created, PR opened, files written), and
when the session tries to finish, checkable claims in the agent's final message
are compared against that evidence. An agent that says **"tests pass" when the
latest test run actually failed is not allowed to stop** — it gets the
contradicting evidence quoted back and must re-run the check or correct itself.
(That's the Replit failure mode: work reported as done that demonstrably isn't.)
Claims with no evidence either way are recorded but never blocked — the
false-positive surface is kept near zero. Modes: `off` / `note` / `block`.

**A risk-ranked approval gate** — risky-but-allowed actions (a push, a deploy, a
dependency install, `sudo`, a cloud-mutating command) are scored deterministically
by what makes them risky. In `record` mode they run but are ranked for review; in
`ask` mode they escalate to Claude Code's approval dialog. `bulkhead inbox` shows
them **highest-risk first** — so when 100 things happened overnight you see the
three that touched production at the top, not 100 undifferentiated approvals:

```
Risky actions — 2 high, 1 medium, 0 low
🔴 [high 80] #4 Bash
    sudo kubectl apply -f prod.yaml
    runs with elevated privileges (sudo/doas); kubectl apply mutates cloud/infra resources
🔴 [high 40] #2 Bash
    git push origin main
    pushes commits to a remote
🟠 [medium 25] #1 Bash
    npm install left-pad
    npm install adds a dependency (supply-chain surface)
```

The gate is **off by default** (the free tool shouldn't nag), and it never flags
ordinary work — `npm test`, `git status`, read-only cloud commands, a bare
`npm install`, or a runner name inside a quoted argument all score zero.
`bulkhead notify` can push this ranked card to a Slack-compatible webhook you
configure (for an overnight summary). Remote/phone approval, a hosted audit
trail, and Telegram are the paid hosted tier.

**Per-task cost attribution + reports** — every ledger entry snapshots session
spend and the prompt it belongs to, so `bulkhead report` shows you where the
money went, what was denied, what was proven, and every completion verdict:

```
Session s-4f2a…c91b  2026-07-14T07:02 → 07:41
  Cost: $3.84 across 2 prompt(s)
    p-88e1…       $  3.12  14 tool call(s)
    p-90a2…       $  0.72   3 tool call(s), 1 denied
  Denied: 1
    ⛔ #38 Bash [blocked-commands] force-push-protected-branch
  Evidence: file_modified×6, test_failed×1, test_passed×2, commit_created×1
  Completion checks:
    ✅ [tests-pass] supported: "all tests pass"
    ✅ [committed] supported: "committed"
```

**Structured refusals** — when Bulkhead blocks something, the agent gets a clear,
deterministic message it can read but can't reason its way around:

```
⛔ Bulkhead blocked this action.
Guard: protected-paths
Rule: prod/**
Why: `prod/config.yaml` is a protected path (write/delete denied by bulkhead.yaml).
This is a deterministic policy check that runs outside the model and cannot be
overridden by reasoning.
To proceed, a human must change bulkhead.yaml or perform this action manually.
```

---

## The policy file

`bulkhead init` writes a conservative default `bulkhead.yaml`. It's yours to edit
and check into the repo:

```yaml
version: 1

protected_paths:
  deny:
    - "prod/**"
    - "migrations/**"
    - ".env"
    - ".env.*"
  allow: []          # exceptions carved back out of deny

blocked_commands:
  - pattern: "\\bDROP\\s+TABLE\\b"
    message: "SQL DROP TABLE"
  - pattern: "\\b(curl|wget)\\b[^\\n]*\\|[^\\n]*\\b(sh|bash|zsh)\\b"
    message: "Piping a downloaded script straight into a shell"
  # ...force-push, DROP DATABASE, TRUNCATE, mkfs, fork bomb by default

budget:
  session_usd: 5     # pause the agent past $5 in one session
  daily_usd: 20      # ...or $20 across all sessions today
                     # (0 disables a cap)

loop:
  max_repeats: 8     # freeze the same tool+args after 8 tries...
  window_seconds: 300  # ...within 5 minutes
```

The defaults are intentionally minimal — they block only unambiguously
destructive actions. **False positives are the thing that gets a guardrail
uninstalled**, so start conservative and tighten to taste.

---

## CLI

```bash
bulkhead init            # install hooks + write bulkhead.yaml (idempotent)
bulkhead status          # spend today, recent denials, ledger integrity
bulkhead report          # per-session: cost by prompt, denials, evidence, verdicts
bulkhead inbox           # risky actions, risk-ranked (highest first)
bulkhead notify --to webhook --url <slack-url>   # push the ranked card on demand
bulkhead ledger tail 20  # the last 20 intercepted actions
bulkhead ledger verify   # check the hash chain
```

`bulkhead hook pre|post|stop` are the hook entrypoints Claude Code calls; you
don't run them by hand.

---

## What it does and doesn't stop

This is the honest contract. Please don't rely on Bulkhead for anything outside
the left column.

**It does:**

- Deny writes/deletes to protected paths for the structured file tools
  (Write/Edit/MultiEdit/NotebookEdit), where the path is a field it can read.
- Deny Bash commands matching your blocked patterns, and any `rm` resolving
  outside the workspace.
- Pause the agent at a hard dollar cap (deterministic transcript sum).
- Freeze a suspected loop.
- Record every interception to a tamper-evident ledger, with typed evidence of
  what completed actions actually proved.
- Refuse to let a session finish on a claim the evidence contradicts ("tests
  pass" when the latest run failed). Claim detection is regex-based: it catches
  the standard phrasings, not every possible rewording — and missing evidence
  is never a block, only a note.

**It does not:**

- **Sandbox the agent.** A shell can reach a protected file in ways a regex can't
  see (obfuscation, env-var indirection, `base64`, writing a script that writes a
  script). Bash protected-path coverage is the obvious `rm` case, not a proof.
- **Prevent prompt injection.** Bulkhead inspects the *tool call*, not *why* the
  agent decided to make it. (It does help against injected-instruction attacks in
  one specific way: a poisoned prompt still has to emit a destructive tool call,
  and a boundary guard can catch that regardless of the prompt — but that's
  containment, not injection prevention.)
- **Guarantee it runs.** Hooks fire because the host runs them. `claude --bare`
  skips hooks; anyone can uninstall them; a future Claude Code version could
  change the contract. Bulkhead targets **Claude Code 2.1.86**'s hook API.
- **Stop a hard link.** Protected-path matching resolves symlinks (a write
  through `ln -s prod gate` is denied), but a hard link is a second directory
  entry for the same inode — there is nothing for `realpath` to resolve, so
  `ln .env hardcopy.conf` then writing `hardcopy.conf` is **allowed**. The
  exposure is bounded: the OS refuses to hard-link a directory, so no new file
  can appear inside a protected directory this way — only an already-existing
  protected file can be modified. The write is still recorded in the ledger.
  Tracked as https://github.com/laqaer/bulkhead-cli/issues/3 — pinned by
  test so a fix cannot land silently.

**Design choices that follow from this:**

- **No LLM in the enforcement path** — every decision is a pure function of the
  tool call, your policy, the transcript, and loop state. Fast and reproducible.
- **`allow` = abstain** — on a permitted call Bulkhead emits nothing, so Claude
  Code's own permission flow runs unchanged. It never auto-approves for you.
- **Fail open, loudly — with one deliberate exception.** If Bulkhead itself
  errors, the tool proceeds (a bug in a guardrail must never brick your agent)
  and the error goes to stderr. The exception is Bulkhead's own state directory
  `.bulkhead/`: it *is* the enforcement substrate, and the guarded agent can
  disable it with one mundane command (`chmod 000 .bulkhead`). A permission-class
  failure there (`EACCES`, `EPERM`, `EROFS`) **fails closed** — the call is denied
  with a message a human can act on. `ENOSPC` is not in that set on purpose: it
  arrives unchosen and its blast radius is machine-wide
  (https://github.com/laqaer/bulkhead-cli/issues/4). A broader
  fail-closed `strict` mode is planned.

---

## Roadmap

Bulkhead's OSS core (this package) is surface 1. Coming next: a completion
verifier (did the tests it claimed actually run?), a paid **approval inbox** that
pushes risk-ranked batches of risky-but-allowed actions to Telegram/Slack for
overnight review, and a free public status page tracking pass-rate/cost per Claude
Code release. More at [bulkhead.tools](https://bulkhead.tools).

---

## License

MIT © 2026 Andy Zhou. See [LICENSE](./LICENSE).
