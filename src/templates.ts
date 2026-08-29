/**
 * The default policy file written by `bulkhead init`. Conservative on purpose:
 * it blocks only unambiguously destructive actions, because a guardrail that
 * fires on legitimate work gets uninstalled within a week. Everything here is
 * commented so a user can read the file and understand exactly what it does —
 * and what it does not do.
 */
export const DEFAULT_POLICY_YAML = `# Bulkhead policy — deterministic guardrails for AI coding agents.
# This is CONTAINMENT + EVIDENCE, not a firewall. Hooks are bypassable; see the
# README for what these checks do and do not stop. Checks run outside the model
# and cannot be argued past by the agent.
version: 1

# Paths the agent may never write or delete. Globs are matched against the
# repo-relative path (dotfiles included). Reliable for file tools (Write/Edit);
# for Bash, only the obvious 'rm <protected>' case is caught.
#
# The baseline rules below are always enforced. Custom deny rules are additive,
# and allow exceptions cannot exempt bulkhead.yaml or .bulkhead/** — an agent
# must never be able to rewrite its own guardrail or evidence state.
protected_paths:
  deny:
    - "prod/**"
    - "migrations/**"
    - ".env"
    - ".env.*"
    # Bulkhead's policy and evidence/state are immutable to the guarded agent.
    - "bulkhead.yaml"
    - ".bulkhead"
    - ".bulkhead/**"
  allow: []   # exceptions carved back out of configurable deny paths

# Bash commands blocked by regex (case-insensitive, matched against the whole
# command). Regex is bypassable by design — this catches fat-finger and
# copy-paste disasters, not a determined adversary. Built-in command rules are
# always retained; entries here add stricter project-specific rules.
# Two structured checks also run built-in (not regexes): 'rm' targeting anything
# outside the workspace, and a dangerous force-push (order-independent; blocks
# force-push to main/master and unconditional force-push, but allows
# --force-with-lease and force-pushing a feature branch merely named '*-main').
blocked_commands:
  - pattern: "\\\\bDROP\\\\s+TABLE\\\\b"
    message: "SQL DROP TABLE"
  - pattern: "\\\\bDROP\\\\s+DATABASE\\\\b"
    message: "SQL DROP DATABASE"
  - pattern: "\\\\bTRUNCATE\\\\s+TABLE\\\\b"
    message: "SQL TRUNCATE TABLE"
  - pattern: "\\\\bmkfs\\\\.[a-z0-9]+\\\\b"
    message: "Filesystem format"
  - pattern: "\\\\b(curl|wget)\\\\b[^\\\\n]*\\\\|[^\\\\n]*\\\\b(sh|bash|zsh)\\\\b"
    message: "Piping a downloaded script straight into a shell"

# Hard dollar caps. When crossed, every subsequent tool call is denied — the
# agent is effectively paused until a human raises the cap. Cost is a
# deterministic sum over the session transcript; no estimation model is used.
# Set to 0 to disable a cap.
budget:
  session_usd: 5      # per Claude Code session
  daily_usd: 20       # across all sessions today
  # pricing:          # optional per-model overrides (per 1M tokens)
  #   my-model: { inputPerMTok: 3, outputPerMTok: 15 }

# Loop kill-switch: freeze when the identical tool call (same name + same args)
# repeats too many times inside the window. Changing an argument resets it, so
# legitimate iteration is not frozen.
loop:
  max_repeats: 8
  window_seconds: 300

# Completion verification (runs on session stop): checkable claims in the
# agent's final message ("tests pass", "opened a PR", "committed") are compared
# against the evidence ledger. Modes:
#   off   — disabled
#   note  — record verdicts in the ledger only
#   block — also refuse to finish when a claim is CONTRADICTED by evidence
#           (says tests pass, latest test run failed). Missing evidence is only
#           noted, never blocked — near-zero false-positive surface.
# Custom rules can be added and are appended to the built-ins:
#   rules:
#     - id: deployed
#       claim: "\\bdeployed\\b"
#       evidence: [command_output]
verify:
  mode: block
  block_on_missing: false

# Approval gate for risky-but-ALLOWED actions (a push, a deploy, a dependency
# install, a force... no — destructive things are already denied above). Risk is
# scored deterministically; the inbox ranks it high→low so you review the
# actions that touch production first, not 100 undifferentiated ones. Modes:
#   off    — no gating (default; the free tool shouldn't nag)
#   record — allow, but score + record for review via 'bulkhead inbox'
#            (good for overnight autonomous runs — nothing blocked)
#   ask    — actions at/above min_level escalate to Claude Code's approval
#            dialog (interactive). Remote/phone approval is the hosted tier.
# min_level: low | medium | high
risky:
  mode: off
  min_level: medium
`;

export const GITIGNORE_LINE = ".bulkhead/";
