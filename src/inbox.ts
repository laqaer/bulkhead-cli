import type { LedgerEntry, RiskLevel } from "./types.js";
import { rankOf } from "./risk.js";
import { actionSummary } from "./describe.js";

/**
 * The approval inbox's review surface: the risky actions an agent took (or was
 * asked about), ranked high → low so a human reviewing 100 overnight actions
 * sees the three that touch production first — the anti-rubber-stamp property.
 * Pure over ledger entries.
 */

export interface InboxItem {
  seq: number;
  ts: string;
  sessionId: string;
  toolName?: string;
  /** Short description of the attempted action (command / path). */
  summary: string;
  level: RiskLevel;
  score: number;
  reasons: string[];
  /** What the enforcement engine did: allow (record mode), ask, or deny. */
  action?: string;
  /**
   * True when Bulkhead denied the action: it was scored as risky AND refused,
   * so it never ran. Rendered as "(blocked)" — a blocked force-push must never
   * read like one that happened.
   */
  blocked: boolean;
}

export interface Inbox {
  items: InboxItem[];
  counts: Record<RiskLevel, number>;
}

export function buildInbox(
  entries: LedgerEntry[],
  minLevel: RiskLevel = "low",
  opts: { repoRoot?: string } = {},
): Inbox {
  const items: InboxItem[] = [];
  for (const e of entries) {
    if (e.event !== "pre" || !e.risk?.level) continue;
    if (rankOf(e.risk.level) < rankOf(minLevel)) continue;
    items.push({
      seq: e.seq,
      ts: e.ts,
      sessionId: e.sessionId,
      toolName: e.toolName,
      summary: summarize(e, opts.repoRoot),
      level: e.risk.level,
      score: e.risk.score,
      reasons: e.risk.signals.map((s) => s.reason),
      action: e.action,
      blocked: e.action === "deny",
    });
  }
  // Highest level first, then highest score, then most recent.
  items.sort(
    (a, b) =>
      rankOf(b.level) - rankOf(a.level) ||
      b.score - a.score ||
      b.seq - a.seq,
  );
  const counts: Record<RiskLevel, number> = { high: 0, medium: 0, low: 0 };
  for (const it of items) counts[it.level] += 1;
  return { items, counts };
}

function summarize(e: LedgerEntry, repoRoot: string | undefined): string {
  // Local review surface: the real command, paths shown repo-relative.
  return actionSummary(e.toolInput, { repoRoot, mode: "paths", max: 120 }) || e.toolName || "(action)";
}

const ICON: Record<RiskLevel, string> = { high: "🔴", medium: "🟠", low: "🟡" };

/** Plain-text render for `bulkhead inbox`. */
export function renderInbox(inbox: Inbox): string {
  if (inbox.items.length === 0) return "Inbox empty — no risky actions recorded.";
  const lines: string[] = [
    `Risky actions — ${inbox.counts.high} high, ${inbox.counts.medium} medium, ${inbox.counts.low} low`,
    "",
  ];
  for (const it of inbox.items) {
    const mark = it.blocked ? " (blocked)" : it.action === "ask" ? " (asked)" : "";
    lines.push(`${ICON[it.level]} [${it.level} ${it.score}] #${it.seq} ${it.toolName ?? ""}${mark}`);
    lines.push(`    ${it.summary}`);
    lines.push(`    ${it.reasons.join("; ")}`);
  }
  return lines.join("\n");
}
