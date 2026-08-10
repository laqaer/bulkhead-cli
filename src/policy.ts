import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ModelPrice, RiskLevel } from "./types.js";
import { policyPath } from "./paths.js";

export interface BlockedCommandRule {
  /** Regex source matched (case-insensitive) against the full Bash command. */
  pattern: string;
  /** Optional override message; a default is derived from the pattern. */
  message?: string;
}

export interface ProtectedPathsConfig {
  /** Glob patterns that may never be written or deleted. */
  deny: string[];
  /** Glob patterns carved back out of `deny` (exceptions). */
  allow: string[];
}

export interface BudgetConfig {
  /** Pause the agent when a single session exceeds this many USD. 0 = off. */
  sessionUsd: number;
  /** Pause the agent when today's total across sessions exceeds this. 0 = off. */
  dailyUsd: number;
  /** Optional per-model price overrides / additions. */
  pricing?: Record<string, ModelPrice>;
}

export interface LoopConfig {
  /** Freeze when an identical tool+args call repeats at least this many times. */
  maxRepeats: number;
  /** ...within this rolling window, in seconds. */
  windowSeconds: number;
}

export interface VerifyRule {
  id: string;
  /** Regex (case-insensitive) matched against the agent's final message. */
  claim: string;
  /** Evidence types that support the claim. */
  evidence: string[];
  /** Evidence types that contradict it (e.g. test_failed for "tests pass"). */
  contradictedBy?: string[];
}

export interface VerifyConfig {
  /**
   * off   — no completion verification.
   * note  — record claim-vs-evidence verdicts in the ledger, never block.
   * block — additionally refuse to let the session stop when a claim is
   *         CONTRADICTED by evidence (e.g. "tests pass" but the latest test run
   *         failed). Missing evidence is only noted, never blocked — that keeps
   *         the false-positive surface near zero.
   */
  mode: "off" | "note" | "block";
  /** Escalate missing-evidence verdicts to blocks too (strict teams only). */
  blockOnMissing: boolean;
  rules: VerifyRule[];
}

/** Built-in claim rules. Deliberately few and precise. */
export function defaultVerifyRules(): VerifyRule[] {
  return [
    {
      id: "tests-pass",
      claim: "\\b(all\\s+)?tests?\\s+(are\\s+|now\\s+)*(pass|passing|passed|green)\\b",
      evidence: ["test_passed"],
      contradictedBy: ["test_failed"],
    },
    {
      id: "pr-created",
      claim:
        "\\b(opened|created|submitted|raised)\\b[^.\\n]{0,60}\\bpull request\\b|\\bpull request\\b[^.\\n]{0,60}\\b(opened|created|submitted|raised)\\b|\\b(opened|created|submitted|raised)\\s+(a\\s+|the\\s+)?pr\\b",
      evidence: ["pr_created"],
    },
    {
      // (?!\s+to\b) keeps "I'm committed to this approach" from reading as a
      // git commit claim.
      id: "committed",
      claim: "\\bcommitted\\b(?!\\s+to\\b)|\\b(created|made)\\s+(a\\s+|the\\s+)?commit\\b",
      evidence: ["commit_created"],
    },
  ];
}

export interface RiskyConfig {
  /**
   * off    — no risk gating (default; the free tool shouldn't nag).
   * record — risky actions still run, but their risk level is scored and
   *          recorded so `bulkhead inbox` can show a ranked review. Best for
   *          overnight autonomous runs: nothing is blocked, you review in the
   *          morning.
   * ask    — risky actions at/above `minLevel` escalate to Claude Code's
   *          approval dialog (interactive local approval). Remote/phone approval
   *          is the hosted tier.
   */
  mode: "off" | "record" | "ask";
  /** Only gate actions at or above this risk level. */
  minLevel: RiskLevel;
}

export interface Policy {
  version: number;
  /** Repo root; enforcement paths are resolved relative to this. */
  workspaceRoot: string;
  protectedPaths: ProtectedPathsConfig;
  blockedCommands: BlockedCommandRule[];
  budget: BudgetConfig;
  loop: LoopConfig;
  verify: VerifyConfig;
  risky: RiskyConfig;
}

/**
 * Conservative defaults. False positives get a tool ripped out within a week,
 * so the shipped policy blocks only unambiguously destructive things.
 */
export function defaultPolicy(workspaceRoot: string): Policy {
  return {
    version: 1,
    workspaceRoot,
    protectedPaths: {
      // ".bulkhead/**": the agent must not edit its own audit trail.
      deny: ["prod/**", "migrations/**", ".env", ".env.*", ".bulkhead/**"],
      allow: [],
    },
    // Note: dangerous force-push is handled by a built-in structured check
    // (order-independent, branch-precise) — not by a regex here.
    blockedCommands: [
      { pattern: "\\bDROP\\s+TABLE\\b", message: "SQL DROP TABLE" },
      { pattern: "\\bDROP\\s+DATABASE\\b", message: "SQL DROP DATABASE" },
      { pattern: "\\bTRUNCATE\\s+TABLE\\b", message: "SQL TRUNCATE TABLE" },
      { pattern: "\\bmkfs\\.[a-z0-9]+\\b", message: "Filesystem format" },
      { pattern: "\\b(curl|wget)\\b[^\\n]*\\|[^\\n]*\\b(sh|bash|zsh)\\b", message: "Piping a downloaded script straight into a shell" },
      { pattern: ":\\(\\)\\s*\\{\\s*:\\|:&\\s*\\};:", message: "Fork bomb" },
    ],
    budget: {
      sessionUsd: 5,
      dailyUsd: 20,
    },
    loop: {
      maxRepeats: 8,
      windowSeconds: 300,
    },
    verify: {
      mode: "block",
      blockOnMissing: false,
      rules: defaultVerifyRules(),
    },
    risky: {
      mode: "off",
      minLevel: "medium",
    },
  };
}

/** Deep-ish merge of a parsed YAML object onto the defaults. */
export function normalizePolicy(raw: unknown, workspaceRoot: string): Policy {
  const base = defaultPolicy(workspaceRoot);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;

  const pp = (r.protected_paths ?? r.protectedPaths) as
    | Record<string, unknown>
    | undefined;
  const budget = r.budget as Record<string, unknown> | undefined;
  const loop = r.loop as Record<string, unknown> | undefined;
  const blocked = (r.blocked_commands ?? r.blockedCommands) as unknown;
  const verify = r.verify as Record<string, unknown> | undefined;
  const risky = r.risky as Record<string, unknown> | undefined;

  return {
    version: typeof r.version === "number" ? r.version : base.version,
    workspaceRoot:
      typeof (r.workspace_root ?? r.workspaceRoot) === "string"
        ? (r.workspace_root ?? r.workspaceRoot) as string
        : base.workspaceRoot,
    protectedPaths: {
      deny: asStringArray(pp?.deny) ?? base.protectedPaths.deny,
      allow: asStringArray(pp?.allow) ?? base.protectedPaths.allow,
    },
    blockedCommands: normalizeBlocked(blocked) ?? base.blockedCommands,
    budget: {
      sessionUsd: asNumber(budget?.session_usd ?? budget?.sessionUsd) ?? base.budget.sessionUsd,
      dailyUsd: asNumber(budget?.daily_usd ?? budget?.dailyUsd) ?? base.budget.dailyUsd,
      pricing: (budget?.pricing as Record<string, ModelPrice> | undefined) ?? base.budget.pricing,
    },
    loop: {
      maxRepeats: asNumber(loop?.max_repeats ?? loop?.maxRepeats) ?? base.loop.maxRepeats,
      windowSeconds: asNumber(loop?.window_seconds ?? loop?.windowSeconds) ?? base.loop.windowSeconds,
    },
    verify: {
      mode: asVerifyMode(verify?.mode) ?? base.verify.mode,
      blockOnMissing:
        typeof (verify?.block_on_missing ?? verify?.blockOnMissing) === "boolean"
          ? ((verify?.block_on_missing ?? verify?.blockOnMissing) as boolean)
          : base.verify.blockOnMissing,
      // Custom rules ADD to the built-ins (replacing them would silently turn
      // off tests-pass verification the moment a user adds one rule).
      rules: [...base.verify.rules, ...(normalizeVerifyRules(verify?.rules) ?? [])],
    },
    risky: {
      mode: asRiskyMode(risky?.mode) ?? base.risky.mode,
      minLevel: asRiskLevel(risky?.min_level ?? risky?.minLevel) ?? base.risky.minLevel,
    },
  };
}

function asRiskyMode(v: unknown): RiskyConfig["mode"] | undefined {
  return v === "off" || v === "record" || v === "ask" ? v : undefined;
}

function asRiskLevel(v: unknown): RiskLevel | undefined {
  return v === "low" || v === "medium" || v === "high" ? v : undefined;
}

function asVerifyMode(v: unknown): VerifyConfig["mode"] | undefined {
  return v === "off" || v === "note" || v === "block" ? v : undefined;
}

function normalizeVerifyRules(v: unknown): VerifyRule[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: VerifyRule[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.claim !== "string") continue;
    out.push({
      id: typeof o.id === "string" ? o.id : `custom-${out.length}`,
      claim: o.claim,
      evidence: asStringArrayLoose(o.evidence) ?? [],
      contradictedBy: asStringArrayLoose(o.contradicted_by ?? o.contradictedBy),
    });
  }
  return out;
}

function asStringArrayLoose(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

export function loadPolicy(repoRoot: string): Policy {
  const p = policyPath(repoRoot);
  if (!existsSync(p)) return defaultPolicy(repoRoot);
  const raw = parseYaml(readFileSync(p, "utf8"));
  return normalizePolicy(raw, repoRoot);
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function normalizeBlocked(v: unknown): BlockedCommandRule[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: BlockedCommandRule[] = [];
  for (const item of v) {
    if (typeof item === "string") {
      out.push({ pattern: item });
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      if (typeof o.pattern === "string") {
        out.push({
          pattern: o.pattern,
          message: typeof o.message === "string" ? o.message : undefined,
        });
      }
    }
  }
  return out;
}
