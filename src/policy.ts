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
   * block — additionally send the agent back to work (once — a retried stop
   *         is recorded, not blocked) when a claim is CONTRADICTED by evidence
   *         (e.g. "tests pass" but the latest test run failed). Missing
   *         evidence is only noted unless `blockOnMissing` — that keeps the
   *         false-positive surface near zero.
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
 * These paths protect the guardrail itself. They are evaluated before user
 * allow exceptions, so an agent cannot carve them back out through policy.
 *
 * `.claude/settings.json` and `.claude/settings.local.json` are where Claude
 * Code reads the project's hooks — the ones that run Bulkhead. An agent that
 * can edit them can delete its own guardrail (or set `disableAllHooks`), so
 * they sit in the same boundary as the policy file. `.claude` itself is listed
 * so `rm -rf .claude` is caught the way `rm -rf .bulkhead` is. The rest of
 * `.claude/**` (commands, agents, CLAUDE.md) stays writable: agents edit those
 * legitimately, and none of them can switch hooks off.
 *
 * `bulkhead init` writes settings.json with plain file I/O, outside any hook,
 * so installing or upgrading is unaffected.
 */
export const IMMUTABLE_PROTECTED_PATHS = [
  "bulkhead.yaml",
  ".bulkhead",
  ".bulkhead/**",
  ".claude",
  ".claude/settings.json",
  ".claude/settings.local.json",
] as const;

/**
 * Template env files: checked in on purpose, no secrets by convention, and
 * written in ordinary work. Carved out of `.env.*` by default; the policy file
 * lists them under `allow`, so a team can take them back out.
 */
export const DEFAULT_ALLOWED_PATHS = [".env.example", ".env.sample", ".env.template"] as const;

export const BUILTIN_PROTECTED_PATHS = [
  "prod/**",
  "migrations/**",
  ".env",
  ".env.*",
  ...IMMUTABLE_PROTECTED_PATHS,
] as const;

/**
 * A shipped command rule. `prose` marks a rule that describes destructive
 * *content* — a statement or CLI invocation that can appear verbatim in text
 * that merely talks about it (`grep -rn "terraform destroy" docs/`). Only those
 * may be skipped for a provably inert, text-only command; see
 * guards/blocked-commands.ts. The flag never leaves this file: the exported
 * lists are plain BlockedCommandRules, and the skip is keyed on the exact
 * pattern string so it also reaches rules loaded back from a user's
 * bulkhead.yaml.
 */
interface ShippedRule extends BlockedCommandRule {
  message: string;
  prose: boolean;
}

// Regex fragments shared by the rules below, written with String.raw so each
// reads exactly as the regex it becomes. SEG keeps a match inside one simple
// command (and one line), so a flag in the NEXT command of a `&&` chain cannot
// complete it, and a large heredoc costs at most line-length work per match
// attempt. No rule nests quantifiers over overlapping characters, so none of
// them can backtrack catastrophically; test/incident-pack.test.ts pins a
// timing bound on adversarial input.
const SEG = String.raw`[^\n;&|]*`;
/**
 * Up to 8 whitespace-separated tokens on one line (git's global options, or
 * the arguments between `reset` and `--hard`). Bounded so a line that repeats
 * `git` thousands of times stays linear instead of rescanning to the end.
 */
const TOKENS = String.raw`(?:[^\s;&|]+[ \t]+){0,8}?`;
/** One SQL identifier: bare, "double-quoted", `backticked` or [bracketed]. */
const SQL_IDENT = String.raw`(?:\\?"[\w$ ]+\\?"|\x60[\w$ ]+\x60|\[[\w$ ]+\]|[\w$]+)`;
/** A bare Windows drive root as one argument: `d:\`, `D:/`, quoted or not. */
const DRIVE_ROOT = String.raw`["']?[A-Za-z]:[\\/]+["']?(?=[\s;&|)]|$)`;
/** A loopback host: localhost, *.localhost, 127.x.x.x, 0.0.0.0 or [::1]. */
const LOOPBACK = String.raw`(?:(?:[\w-]+\.)*localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?![\w.-])`;

/**
 * Always-on command rules. Conservative on purpose: each names one
 * unambiguously destructive operation, so ordinary dev work never trips it.
 * The incident pack (everything after the fork bomb) covers the shapes behind
 * publicly reported agent disasters — src/corpus.ts pins every one of them.
 */
const SHIPPED_BUILTIN_RULES: ReadonlyArray<ShippedRule> = [
  { pattern: "\\bDROP\\s+TABLE\\b", message: "SQL DROP TABLE", prose: true },
  { pattern: "\\bDROP\\s+DATABASE\\b", message: "SQL DROP DATABASE", prose: true },
  { pattern: "\\bTRUNCATE\\s+TABLE\\b", message: "SQL TRUNCATE TABLE", prose: true },
  { pattern: "\\bmkfs\\.[a-z0-9]+\\b", message: "Filesystem format", prose: true },
  {
    pattern: "\\b(curl|wget)\\b[^\\n]*\\|[^\\n]*\\b(sh|bash|zsh)\\b",
    message: "Piping a downloaded script straight into a shell",
    prose: false,
  },
  { pattern: ":\\(\\)\\s*\\{\\s*:\\|:&\\s*\\};:", message: "Fork bomb", prose: false },

  // ── Incident pack ──────────────────────────────────────────────────────
  // DELETE FROM <table> followed directly by the end of the statement (`;`,
  // a closing quote, end of command) or RETURNING. A WHERE, USING, LIMIT or
  // alias in between means no match.
  {
    pattern: String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${SQL_IDENT}(?:\.${SQL_IDENT})*(?:\s*(?:[;'"\x60]|$)|\s+RETURNING\b)`,
    message: "Unscoped SQL DELETE (no WHERE clause)",
    prose: true,
  },
  {
    pattern: String.raw`\b(?:terraform|tofu)\b(?:\s+-\S+)*\s+(?:destroy|apply\b${SEG}\s-destroy)\b`,
    message: "terraform destroy (tears down managed infrastructure)",
    prose: true,
  },
  {
    pattern: String.raw`\bpulumi\b(?:\s+-\S+)*\s+(?:destroy|down)\b`,
    message: "pulumi destroy (tears down a stack's infrastructure)",
    prose: true,
  },
  // A GraphQL delete/destroy mutation sent by curl, wget, HTTPie or xh,
  // unless it provably stays on this machine: denied when any non-loopback
  // http(s) URL appears, or when no loopback host appears at all (a bare
  // hostname or $API_URL may be production). Agents testing their own API
  // on localhost stay allowed.
  {
    pattern:
      String.raw`^(?=[\s\S]*(?:^|[\s;&|(/])(?:curl|wget|https?|xh)\s)` +
      String.raw`(?=[\s\S]*\bmutation\b[\s\S]*?(?:delete|destroy)\w*\s*\()` +
      String.raw`(?:(?=[\s\S]*\bhttps?://(?!${LOOPBACK}))|(?![\s\S]*(?:^|[^\w.-])${LOOPBACK}))`,
    message: "GraphQL delete mutation sent to a remote API",
    prose: true,
  },
  {
    pattern: String.raw`\brailway\s+volumes?\s+(?:delete|remove|rm)\b`,
    message: "Railway volume delete",
    prose: true,
  },
  {
    pattern: String.raw`\baws[ \t]+${TOKENS}s3[ \t]+rm\b${SEG}\s--recursive\b`,
    message: "Recursive S3 delete",
    prose: true,
  },
  {
    pattern: String.raw`\baws[ \t]+${TOKENS}s3[ \t]+rb\b${SEG}\s--force\b`,
    message: "S3 bucket force-remove (deletes every object)",
    prose: true,
  },
  {
    pattern: String.raw`\baws[ \t]+${TOKENS}rds[ \t]+delete-db-(?:instance|cluster)\b`,
    message: "RDS database delete",
    prose: true,
  },
  {
    pattern: String.raw`\bkubectl[ \t]+${TOKENS}delete[ \t]+(?:namespaces?|ns)\b`,
    message: "Kubernetes namespace delete",
    prose: true,
  },
  {
    pattern: String.raw`^(?=[\s\S]*\b(?:redis|valkey|keydb)-cli\b)[\s\S]*\bflush(?:all|db)\b`,
    message: "Redis FLUSHALL/FLUSHDB (deletes every key)",
    prose: true,
  },
  {
    pattern: String.raw`\bdropDatabase\s*\(`,
    message: "MongoDB dropDatabase()",
    prose: true,
  },
  {
    pattern: String.raw`\bsupabase[ \t]+${TOKENS}db[ \t]+reset\b${SEG}\s--(?:linked|db-url)\b`,
    message: "Supabase reset of a remote database",
    prose: true,
  },
  {
    pattern: String.raw`\bgh\s+repo\s+delete\b`,
    message: "GitHub repository delete",
    prose: true,
  },
  {
    pattern: String.raw`\bheroku\s+pg:reset\b`,
    message: "Heroku Postgres reset",
    prose: true,
  },
  {
    pattern: String.raw`\b(?:fly|flyctl)\s+vol(?:umes?)?\s+(?:destroy|delete|rm)\b`,
    message: "Fly.io volume destroy",
    prose: true,
  },
  {
    pattern: String.raw`\bgcloud\s+(?:(?:alpha|beta)\s+)?sql\s+instances\s+delete\b`,
    message: "Cloud SQL instance delete",
    prose: true,
  },
  // A recursive delete aimed at a bare Windows drive root (`d:\`, `D:/`): the
  // whole volume, past the recycle bin. Only the root matches — a folder on the
  // drive (`d:\cache`) is ordinary cleanup. cmd's switches can sit before or
  // after the target, so /s and the root are each checked anywhere in the
  // command.
  {
    pattern: String.raw`\b(?:rmdir|rd)\b(?=${SEG}/s\b)(?=${SEG}[ \t]${DRIVE_ROOT})`,
    message: "Recursive delete of a Windows drive root (rmdir/rd /s)",
    prose: true,
  },
  {
    pattern: String.raw`\bRemove-Item\b(?=${SEG}[ \t]-r(?:ec\w*)?\b)(?=${SEG}[ \t]${DRIVE_ROOT})`,
    message: "Recursive delete of a Windows drive root (Remove-Item -Recurse)",
    prose: true,
  },
];

/**
 * `bulkhead init --preset strict` rules. Each one is destructive but also
 * routine in ordinary development (usually aimed at a throwaway local
 * database, or a working tree a human is watching), so the default preset
 * allows them. Strict is for unattended runs, where nobody is watching when
 * the agent decides to start over. They are written into the user's
 * bulkhead.yaml rather than built in, so a team can delete any line it
 * disagrees with.
 */
const SHIPPED_STRICT_RULES: ReadonlyArray<ShippedRule> = [
  {
    pattern: String.raw`\bgit[ \t]+${TOKENS}reset[ \t]+${TOKENS}--hard\b`,
    message: "git reset --hard (discards uncommitted work)",
    prose: true,
  },
  // Any forced clean, not only -x: untracked files are uncommitted work too,
  // and -x/-X also deletes ignored files such as .env. Dry runs (-n) pass.
  {
    pattern:
      String.raw`\bgit[ \t]+${TOKENS}clean\b(?=${SEG}\s(?:-[a-z]*f|--force\b))` +
      String.raw`(?!${SEG}\s(?:-[a-z]*n|--dry-run\b))`,
    message: "git clean -f (deletes untracked files)",
    prose: true,
  },
  // Every hard force-push, to any branch: --force, -f (alone or combined, as
  // in -uf) or a +refspec. --force-with-lease and --force-if-includes pass.
  {
    pattern: String.raw`\bgit[ \t]+${TOKENS}push\b${SEG}\s(?:--force(?![-\w])|-[a-z]*f[a-z]*\b|\+[^\s;&|])`,
    message: "Force-push without --force-with-lease",
    prose: true,
  },
  {
    pattern: String.raw`\bdrizzle-kit\s+push(?::\w+)?\b${SEG}\s--force\b`,
    message: "drizzle-kit push --force (skips data-loss prompts)",
    prose: true,
  },
  {
    pattern: String.raw`\bprisma\s+migrate\s+reset\b`,
    message: "prisma migrate reset (drops the database)",
    prose: true,
  },
  {
    pattern: String.raw`\bprisma\s+db\s+push\b${SEG}\s--(?:force-reset|accept-data-loss)\b`,
    message: "prisma db push with data loss accepted",
    prose: true,
  },
  {
    pattern: String.raw`\bdocker\s+(?:volume\s+(?:rm|remove|prune)|system\s+prune\b${SEG}\s--volumes)\b`,
    message: "Docker volume delete",
    prose: true,
  },
  {
    pattern: String.raw`\bdocker(?:-compose|[ \t]+compose)[ \t]+${TOKENS}down\b${SEG}\s(?:-v|--volumes)\b`,
    message: "docker compose down -v (deletes volumes)",
    prose: true,
  },
  {
    pattern: String.raw`\b(?:rails|rake)[ \t]+${TOKENS}db:(?:drop|reset|purge|migrate:reset)\b`,
    message: "Rails database drop/reset",
    prose: true,
  },
  {
    pattern: String.raw`\bartisan\s+(?:migrate:(?:fresh|reset|refresh)|db:wipe)\b`,
    message: "Laravel database wipe",
    prose: true,
  },
  {
    pattern: String.raw`\b(?:manage\.py|django-admin)\s+(?:flush|reset_db)\b`,
    message: "Django database flush",
    prose: true,
  },
];

function plainRule({ pattern, message }: ShippedRule): BlockedCommandRule {
  return { pattern, message };
}

/** Always-on command rules; `normalizePolicy` merges them under any YAML. */
export const BUILTIN_BLOCKED_COMMANDS: ReadonlyArray<BlockedCommandRule> =
  SHIPPED_BUILTIN_RULES.map(plainRule);

/** Extra rules written into bulkhead.yaml by `bulkhead init --preset strict`. */
export const STRICT_PRESET_BLOCKED_COMMANDS: ReadonlyArray<BlockedCommandRule> =
  SHIPPED_STRICT_RULES.map(plainRule);

/**
 * Exact pattern strings of the shipped content rules that may be skipped for
 * a provably inert (text-only) command. See guards/blocked-commands.ts.
 */
export const PROSE_SENSITIVE_PATTERNS: ReadonlySet<string> = new Set(
  [...SHIPPED_BUILTIN_RULES, ...SHIPPED_STRICT_RULES]
    .filter((rule) => rule.prose)
    .map((rule) => rule.pattern),
);

/**
 * Conservative defaults. False positives get a tool ripped out within a week,
 * so the shipped policy blocks only unambiguously destructive things.
 */
export function defaultPolicy(workspaceRoot: string): Policy {
  return {
    version: 1,
    workspaceRoot,
    protectedPaths: {
      deny: [...BUILTIN_PROTECTED_PATHS],
      allow: [...DEFAULT_ALLOWED_PATHS],
    },
    // Note: dangerous force-push is handled by a built-in structured check
    // (order-independent, branch-precise) — not by a regex here.
    blockedCommands: BUILTIN_BLOCKED_COMMANDS.map((rule) => ({ ...rule })),
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

/**
 * Merge parsed YAML onto the defaults without allowing policy to dismantle the
 * guardrail that is loading it. User deny/command rules are additive, the
 * workspace root always comes from the hook's discovered repo root, and the
 * immutable self-protection paths remain enforced even when listed in allow.
 */
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
    // Never trust a repository policy to redefine the boundary that contains
    // it. findRepoRoot() supplies the root; YAML may not move it elsewhere.
    workspaceRoot: base.workspaceRoot,
    protectedPaths: {
      deny: mergeStrings(base.protectedPaths.deny, asStringArray(pp?.deny) ?? []),
      allow: asStringArray(pp?.allow) ?? base.protectedPaths.allow,
    },
    // Custom patterns extend the baseline; they cannot replace it with [].
    blockedCommands: mergeBlockedRules(
      base.blockedCommands,
      normalizeBlocked(blocked) ?? [],
    ),
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

function mergeStrings(base: string[], extra: string[]): string[] {
  return [...new Set([...base, ...extra])];
}

function mergeBlockedRules(
  base: BlockedCommandRule[],
  extra: BlockedCommandRule[],
): BlockedCommandRule[] {
  const seen = new Set<string>();
  const merged: BlockedCommandRule[] = [];
  for (const rule of [...base, ...extra]) {
    if (seen.has(rule.pattern)) continue;
    seen.add(rule.pattern);
    merged.push({ ...rule });
  }
  return merged;
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
