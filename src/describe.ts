import type { Evidence, EvidenceType, LedgerEntry } from "./types.js";
import type { Verdict } from "./verify.js";
import { redact, relativizePaths } from "./redact.js";
import { IMMUTABLE_PROTECTED_PATHS } from "./policy.js";
import { resolveRealCandidate } from "./guards/protected-paths.js";
import { isAbsolute, relative, sep } from "node:path";

/**
 * Human-readable one-liners for what Bulkhead saw and did. Every surface a
 * person reads (the notice in Claude Code, report, status, inbox, ledger
 * tail, receipts) describes a block the same way, from the same fields the
 * ledger already stores: `guard`, `rule`, `reason`. Nothing here decides
 * anything; it only names decisions already made.
 */

export type SummaryMode = "full" | "paths" | "none";

export interface SummaryOptions {
  /** Repo root, for repo-relative paths. */
  repoRoot?: string;
  /** Max characters, ellipsis included. Default 80. */
  max?: number;
  /**
   * full  — repo-relative paths + secrets masked (default; anything shared)
   * paths — repo-relative paths only (local views that show the raw command)
   * none  — verbatim
   */
  mode?: SummaryMode;
}

/** Collapse whitespace and cut to `max` characters, ellipsis included. */
export function clip(s: string, max = 80): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
}

/**
 * Every view is clipped, so only a bounded prefix of agent-controlled text is
 * ever worth redacting. Bounding it keeps the notice cheap inside the
 * PreToolUse hook, where a slow hook times out and lets the call through.
 * The window ends on a space, so no credential is cut into a fragment the
 * patterns no longer recognise.
 */
export function redactionWindow(s: string, max = 80): string {
  const limit = Math.max(1024, max * 4);
  if (s.length <= limit) return s;
  const cut = s.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return space > max ? cut.slice(0, space) : cut;
}

function view(s: string, opts: SummaryOptions): string {
  const mode = opts.mode ?? "full";
  const text = redactionWindow(s, opts.max ?? 80);
  if (mode === "none") return text;
  if (mode === "paths") return relativizePaths(text, { repoRoot: opts.repoRoot });
  return redact(text, { repoRoot: opts.repoRoot });
}

/**
 * What a tool call tried to do: the Bash command, or the target path, or a
 * URL/pattern for other tools. Empty when there is nothing to show.
 */
export function actionSummary(toolInput: unknown, opts: SummaryOptions = {}): string {
  const input =
    toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : {};
  let raw: string | undefined;
  if (typeof input.command === "string") raw = input.command;
  else {
    const p = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path;
    if (typeof p === "string") {
      raw = p;
      if (opts.mode !== "none" && opts.repoRoot && isAbsolute(p)) {
        const canonical = resolveRealCandidate(p);
        const within = relative(resolveRealCandidate(opts.repoRoot), canonical);
        // Display aliases inside this workspace relative to its canonical root.
        // Outside targets and raw evidence retain their original spelling.
        if (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`)) {
          raw = canonical;
        }
      }
    } else if (typeof input.url === "string") raw = input.url;
    else if (typeof input.pattern === "string") raw = input.pattern;
  }
  if (raw === undefined || raw.trim() === "") return "";
  // Redact before clipping so a secret is never half-cut past the masker.
  return clip(view(raw.replace(/\s+/g, " ").trim(), opts), opts.max ?? 80);
}

/** `git push --force origin main` for Bash, `Write .env` for file tools. */
export function toolActionSummary(
  toolName: string | undefined,
  toolInput: unknown,
  opts: SummaryOptions = {},
): string {
  const summary = actionSummary(toolInput, opts);
  const tool = toolName ?? "";
  if (tool === "Bash" || tool === "BashOutput") return summary || tool;
  if (!summary) return tool || "(action)";
  return tool ? `${tool} ${summary}` : summary;
}

/**
 * The human reason for a deny, derived from guard + rule + reason: "SQL DROP
 * TABLE", "force-push to a protected branch", "protected path (.env)". Never
 * the raw regex.
 */
export function denialLabel(v: { guard?: string; rule?: string; reason?: string }): string {
  const guard = v.guard ?? "";
  const rule = v.rule ?? "";
  const reason = (v.reason ?? "").trim();

  if (guard === "blocked-commands") {
    if (rule === "force-push-protected-branch") return "force-push to a protected branch";
    if (rule === "force-push-unconditional") return "unconditional force-push";
    if (rule === "rm-outside-workspace") {
      const target = reason.match(/target `([^`]+)`/)?.[1] ?? "";
      if (target.startsWith("~") || /^\$\{?HOME\b/.test(target)) return "rm of the home directory";
      return /filesystem root/.test(reason) ? "rm of a filesystem root" : "rm outside the workspace";
    }
    const msg = reason.match(/^(.+?)\s+—\s+matched blocked command pattern\.?$/s);
    if (msg) return msg[1]!.trim();
    if (/^Command matches blocked pattern/.test(reason)) return "custom blocked-command rule";
  }
  if (guard === "protected-paths") {
    if (rule === "structured-write-outside-workspace") return "write outside the workspace";
    // Matched on the rule, not the reason's wording: the boundary's paths are
    // the contract, its sentence is free to change.
    if ((IMMUTABLE_PROTECTED_PATHS as readonly string[]).includes(rule) || /\bimmutable\b.*\bboundary\b/.test(reason)) {
      return rule.startsWith(".claude")
        ? `Bulkhead's own hooks (${rule})`
        : `Bulkhead's own policy/state (${rule || "bulkhead.yaml"})`;
    }
    if (/^`rm` targets protected path/.test(reason)) return `rm of a protected path (${rule})`;
    return rule ? `protected path (${rule})` : "protected path";
  }
  if (guard === "budget") return budgetLabel(rule, reason);
  if (guard === "loop") {
    const m = reason.match(/repeated (\d+) times within (\d+)s/);
    return m ? `same call repeated ${m[1]}× in ${m[2]}s (suspected loop)` : "suspected loop";
  }
  if (guard === "state-dir") {
    return `Bulkhead state storage unavailable${rule ? ` (${rule})` : ""}`;
  }
  if (guard === "verify") return "completion claim contradicted by evidence";
  return fallbackLabel(reason) || rule || guard || "blocked";
}

function budgetLabel(rule: string, reason: string): string {
  const amounts = [...reason.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => m[1]!);
  const daily = rule.startsWith("daily");
  const [spent, cap] = amounts;
  if (spent && cap) {
    return daily
      ? `today's spend $${spent} hit the $${cap} daily cap`
      : `session spend $${spent} hit the $${cap} session cap`;
  }
  return daily ? "daily budget cap reached" : "session budget cap reached";
}

/**
 * A reason from a rule this module has no mapping for (a guard added later):
 * its first clause, without markdown ticks or the "refusing" boilerplate.
 */
function fallbackLabel(reason: string): string {
  if (!reason) return "";
  const first = reason.split(/(?<=\.)\s|\s—\s|;\s/)[0] ?? reason;
  return clip(
    first
      .replace(/`/g, "")
      .replace(/\s*[—-]\s*refusing\.?$/i, "")
      .replace(/\.$/, ""),
    60,
  );
}

/** `contradicted: "all tests pass"`, from a stop entry's recorded verdicts. */
export function stopLabel(e: LedgerEntry): string {
  const verdicts = Array.isArray(e.meta?.verdicts) ? (e.meta!.verdicts as Verdict[]) : [];
  const deciding =
    verdicts.find((v) => v.status === "contradicted") ??
    verdicts.find((v) => v.status === "unsupported") ??
    verdicts[0];
  if (!deciding) return e.reason ? fallbackLabel(e.reason) : "";
  const more = verdicts.length > 1 ? ` (+${verdicts.length - 1} more)` : "";
  return `${deciding.status}: "${clip(deciding.claimExcerpt, 60)}"${more}`;
}

/**
 * One line per denial, the same everywhere:
 *   ⛔ #2 Bash · SQL DROP TABLE (blocked-commands)
 *   ⛔ #19 Stop [verify] contradicted: "all tests pass"
 */
export function denialLine(e: LedgerEntry): string {
  if (e.event === "stop") {
    return `⛔ #${e.seq} Stop [${e.guard ?? "verify"}] ${stopLabel(e)}`.trimEnd();
  }
  const tool = e.toolName ? `${e.toolName} · ` : "";
  return `⛔ #${e.seq} ${tool}${denialLabel(e)} (${e.guard ?? "bulkhead"})`;
}

const EVIDENCE_NOUN: Record<EvidenceType, [string, string]> = {
  file_created: ["file created", "files created"],
  file_modified: ["file edit", "file edits"],
  test_passed: ["test run passed", "test runs passed"],
  test_failed: ["test run failed", "test runs failed"],
  test_run: ["test run, outcome unknown", "test runs, outcome unknown"],
  commit_created: ["commit", "commits"],
  pr_created: ["PR opened", "PRs opened"],
};

/** "6 file edits", "1 test run failed". (Edits, not files: one file edited twice is 2.) */
export function evidenceCount(type: string, n: number): string {
  const noun = EVIDENCE_NOUN[type as EvidenceType];
  if (!noun) return `${n} ${type}`;
  return `${n} ${n === 1 ? noun[0] : noun[1]}`;
}

/** Split a test evidence detail (`pnpm test (exit 1) <tail>`) into parts. */
export function parseTestDetail(detail: string): { command?: string; exit?: number; tally?: string } {
  const m = detail.match(/^(.*?) \(exit (\d+)\)/);
  const tally = testTally(detail);
  if (m) return { command: m[1]!.trim(), exit: Number(m[2]), tally };
  return { tally };
}

/** "Tests 1 failed | 6 passed (7)" from vitest/jest-style output, if present. */
export function testTally(text: string): string | undefined {
  // Summaries live at the end; a bounded tail keeps this linear on any input.
  const tail = text.length > 4000 ? text.slice(-4000) : text;
  const m = tail.match(
    /\bTests:?\s+(\d+\s+(?:failed|passed|skipped|todo)(?:,?\s*\|?\s*\d+\s+(?:failed|passed|skipped|todo|total))*(?:\s*\(\d+\))?)/,
  );
  if (m) return `Tests ${m[1]!.replace(/\s+/g, " ").trim()}`;
  const py = tail.match(/(?<!=)={2,80}[ \t]*(\d+\s+(?:failed|passed)(?:,\s*\d+\s+\w+)*)\s+in\s+[\d.]+s[ \t]*=/);
  if (py) return py[1];
  return undefined;
}

/**
 * The deciding evidence as a sentence: "`pnpm test` exited 1 · Tests 1 failed
 * | 6 passed (7)". Markdown-ish backticks are the caller's to keep or strip.
 */
export function evidenceSentence(ev: Evidence, opts: SummaryOptions = {}): string {
  const detail = view(ev.detail, opts);
  if (ev.type === "test_failed" || ev.type === "test_passed" || ev.type === "test_run") {
    const { command, exit, tally } = parseTestDetail(detail);
    if (command !== undefined && exit !== undefined) {
      return clip(`\`${command}\` exited ${exit}${tally ? ` · ${tally}` : ""}`, opts.max ?? 120);
    }
    const verb = ev.type === "test_failed" ? "failed" : ev.type === "test_passed" ? "passed" : "ran";
    return clip(`test run ${verb}${tally ? ` · ${tally}` : ""}: ${detail}`, opts.max ?? 120);
  }
  if (ev.type === "commit_created") return clip(`commit “${detail}”`, opts.max ?? 120);
  if (ev.type === "pr_created") return clip(`PR ${detail}`, opts.max ?? 120);
  return clip(`${ev.type.replace(/_/g, " ")}: ${detail}`, opts.max ?? 120);
}

/** One-line summary of any ledger entry, for `bulkhead ledger tail`. */
export function entrySummary(e: LedgerEntry, opts: SummaryOptions = {}): string {
  const max = opts.max ?? 80;
  if (e.event === "pre") return actionSummary(e.toolInput, { ...opts, max });
  if (e.event === "post") {
    const ev = e.evidence?.[0];
    if (!ev) return "";
    const more = (e.evidence?.length ?? 0) > 1 ? ` (+${e.evidence!.length - 1})` : "";
    return clip(`${ev.type}: ${view(ev.detail, opts)}`, max - more.length) + more;
  }
  if (e.event === "stop") return stopLabel(e);
  return e.reason ? clip(view(e.reason, opts), max) : "";
}

/**
 * The one-line notice Claude Code shows the HUMAN (hook `systemMessage`).
 * The agent gets the full refusal; the person watching gets what happened,
 * in one line, with the ledger entry to look up. Redacted: this line lands
 * in the UI, in screenshots, in SDK streams.
 */
export function preToolUseNotice(args: {
  guard?: string;
  rule?: string;
  reason?: string;
  toolName?: string;
  toolInput?: unknown;
  repoRoot?: string;
  seq?: number;
}): string {
  const ref = args.seq !== undefined ? ` (ledger #${args.seq})` : "";
  const label = denialLabel(args);
  if (args.guard === "budget") {
    const knob = (args.rule ?? "").startsWith("daily") ? "budget.daily_usd" : "budget.session_usd";
    return `🛡 Bulkhead paused the agent: ${label} — raise ${knob} in bulkhead.yaml to continue${ref}`;
  }
  const what = toolActionSummary(args.toolName, args.toolInput, { repoRoot: args.repoRoot, max: 80 });
  if (args.guard === "loop") {
    return `🛡 Bulkhead froze a loop: ${what} — ${label}${ref}`;
  }
  if (args.guard === "state-dir") {
    return `🛡 Bulkhead blocked: ${what} — ${label}; a human must restore .bulkhead/ before the agent continues`;
  }
  return `🛡 Bulkhead blocked: ${what} — ${label}${ref}`;
}

/** The human notice for a blocked Stop (a contradicted completion claim). */
export function stopNotice(verdicts: Verdict[], seq?: number): string {
  const ref = seq !== undefined ? ` (ledger #${seq})` : "";
  const contradicted = verdicts.filter((v) => v.status === "contradicted");
  const unsupported = verdicts.filter((v) => v.status === "unsupported");
  const deciding = contradicted[0] ?? unsupported[0];
  if (!deciding) return `🛡 Bulkhead: completion check failed — sent back to work${ref}`;
  const blocking = contradicted.length > 0 ? contradicted : unsupported;
  const more = blocking.length > 1 ? ` (+${blocking.length - 1} more claim${blocking.length > 2 ? "s" : ""})` : "";
  const claim = redact(clip(deciding.claimExcerpt, 60));
  let but: string;
  if (deciding.status === "unsupported" || !deciding.evidence) {
    but = "no supporting evidence was recorded this session";
  } else if (deciding.evidence.type === "test_failed" || deciding.evidence.type === "test_passed") {
    const { command, exit } = parseTestDetail(deciding.evidence.detail);
    but =
      command !== undefined && exit !== undefined
        ? `the latest \`${redact(clip(command, 60))}\` exited ${exit}`
        : "the latest test run failed";
  } else {
    but = `the ledger shows ${deciding.evidence.type}: ${redact(clip(deciding.evidence.detail, 60))}`;
  }
  return `🛡 Bulkhead: agent said "${claim}" but ${but} — sent back to work${more}${ref}`;
}

/** The human notice when the Stop gate fails closed on unavailable state. */
export function stopStateDirNotice(code: string): string {
  return `🛡 Bulkhead: state storage .bulkhead/ unavailable (${code}) — the session cannot finish until a human restores it`;
}
