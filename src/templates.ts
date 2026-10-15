import {
  BUILTIN_BLOCKED_COMMANDS,
  BUILTIN_PROTECTED_PATHS,
  IMMUTABLE_PROTECTED_PATHS,
  DEFAULT_ALLOWED_PATHS,
  STRICT_PRESET_BLOCKED_COMMANDS,
  type BlockedCommandRule,
} from "./policy.js";

/** The policy files `bulkhead init --preset <name>` can write. */
export const POLICY_PRESETS = ["default", "strict"] as const;
export type PolicyPreset = (typeof POLICY_PRESETS)[number];

export function isPolicyPreset(value: unknown): value is PolicyPreset {
  return typeof value === "string" && (POLICY_PRESETS as readonly string[]).includes(value);
}

/**
 * The rule lists below are generated from policy.ts rather than hand-copied,
 * so the file a user reads can never drift from what is enforced. JSON string
 * syntax is valid YAML double-quoted syntax, which keeps every regex escape
 * exact (test/templates.test.ts parses both presets back to prove it).
 */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlRules(rules: ReadonlyArray<BlockedCommandRule>): string {
  return rules
    .map((rule) =>
      rule.message === undefined
        ? `  - pattern: ${yamlString(rule.pattern)}`
        : `  - pattern: ${yamlString(rule.pattern)}\n    message: ${yamlString(rule.message)}`,
    )
    .join("\n");
}

function yamlPaths(paths: ReadonlyArray<string>): string {
  return paths.map((p) => `    - ${yamlString(p)}`).join("\n");
}

const IMMUTABLE = new Set<string>(IMMUTABLE_PROTECTED_PATHS);
const CONFIGURABLE_PROTECTED_PATHS = BUILTIN_PROTECTED_PATHS.filter((p) => !IMMUTABLE.has(p));

const PRESET_HEADER: Record<PolicyPreset, string> = {
  default: `# Preset: default. It blocks only unambiguously destructive actions, because a
# guardrail that fires on legitimate work gets uninstalled within a week.
# For unattended runs, 'bulkhead init --preset strict --force' rewrites this
# file with extra rules for commands that are destructive but also routine in
# day-to-day work (git reset --hard, prisma migrate reset, docker volume rm...).`,
  strict: `# Preset: strict — the default policy plus a strict block at the end of
# blocked_commands. Meant for unattended runs, where nobody is watching when the
# agent decides to start over. Every strict rule is an ordinary entry: delete
# the ones your team does not want.`,
};

const STRICT_BLOCK = `
  # ── Strict preset ───────────────────────────────────────────────────────
  # Written by 'bulkhead init --preset strict'. Each command below is
  # destructive, but also routine in ordinary development — usually aimed at a
  # throwaway local database or a working tree someone is watching — so the
  # default preset allows it. Two choices worth knowing:
  #   git clean — ANY forced clean is denied, not only -x/-X. Untracked files
  #               are uncommitted work; -x/-X also deletes ignored files such
  #               as .env. Dry runs (-n) still pass.
  #   git push  — every hard force-push (--force, -f, a +refspec) to ANY
  #               branch is denied. --force-with-lease stays allowed.
${yamlRules(STRICT_PRESET_BLOCKED_COMMANDS)}`;

/**
 * Build the policy file `bulkhead init` writes. Conservative on purpose, and
 * commented so a user can read the file and understand exactly what it does —
 * and what it does not do.
 */
export function policyTemplate(preset: PolicyPreset): string {
  return `# Bulkhead policy — deterministic guardrails for AI coding agents.
# This is CONTAINMENT + EVIDENCE, not a firewall. Hooks are bypassable; see the
# README for what these checks do and do not stop. Checks run outside the model
# and cannot be argued past by the agent.
${PRESET_HEADER[preset]}
version: 1

# Paths the agent may never write or delete. Globs are matched against the
# repo-relative path (dotfiles included). Reliable for file tools (Write/Edit);
# for Bash, the obvious forms are caught (rm, redirects, tee, sed -i, cp/mv,
# truncate, dd, ln -f) — a script or interpreter that writes files is not.
#
# The baseline rules below are always enforced. Custom deny rules are additive,
# and allow exceptions cannot exempt the self-protection paths — an agent must
# never be able to rewrite its own guardrail, its evidence state, or the Claude
# Code settings files that load its hooks. The rest of .claude/ (commands,
# agents, CLAUDE.md) stays writable.
protected_paths:
  deny:
${yamlPaths(CONFIGURABLE_PROTECTED_PATHS)}
    # Bulkhead's policy and evidence/state, and the settings files that run
    # its hooks, are immutable to the guarded agent.
${yamlPaths(IMMUTABLE_PROTECTED_PATHS)}
  # Exceptions carved back out of configurable deny paths (never the
  # immutable ones above). Template env files hold no secrets by convention.
  allow:
${yamlPaths(DEFAULT_ALLOWED_PATHS)}

# Bash commands blocked by regex (case-insensitive, matched against the whole
# command). Regex is bypassable by design — this catches fat-finger and
# copy-paste disasters, not a determined adversary. Built-in command rules are
# always retained (deleting one here does not switch it off); entries you add
# are stricter project-specific rules.
#
# The built-ins cover destructive SQL (DROP, TRUNCATE, a DELETE with no WHERE),
# curl | sh, filesystem formats, and the production-destruction shapes behind
# publicly reported agent incidents: terraform/pulumi destroy, GraphQL delete
# mutations sent to a remote API, platform volume and database deletes, a
# recursive S3 delete, a namespace delete, FLUSHALL, dropDatabase(), a linked
# Supabase reset and gh repo delete.
#
# Two structured checks also run built-in (not regexes): 'rm' targeting anything
# outside the workspace (~, $HOME and \${HOME} are expanded to your real home
# directory first), and a dangerous force-push (order-independent; blocks
# force-push to main/master — including a '+main' refspec — and unconditional
# force-push, but allows --force-with-lease and force-pushing a feature branch
# merely named '*-main').
blocked_commands:
${yamlRules(BUILTIN_BLOCKED_COMMANDS)}${preset === "strict" ? STRICT_BLOCK : ""}

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
#   block — also send the agent back to work (once) when a claim is
#           CONTRADICTED by evidence (says tests pass, latest test run failed);
#           a repeat stop is recorded, not blocked. Missing evidence is only
#           noted unless block_on_missing: true — near-zero false positives.
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
}

/** The default policy file written by `bulkhead init`. */
export const DEFAULT_POLICY_YAML = policyTemplate("default");

/** The policy file written by `bulkhead init --preset strict`. */
export const STRICT_POLICY_YAML = policyTemplate("strict");

export const GITIGNORE_LINE = ".bulkhead/";
