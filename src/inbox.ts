import type { LedgerEntry, RiskLevel } from "./types.js";
import { rankOf } from "./risk.js";

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
  /** What the enforcement engine did: allow (record mode) or ask. */
  action?: string;
}

export interface Inbox {
  items: InboxItem[];
  counts: Record<RiskLevel, number>;
}

export function buildInbox(entries: LedgerEntry[], minLevel: RiskLevel = "low"): Inbox {
  const items: InboxItem[] = [];
  for (const e of entries) {
    if (e.event !== "pre" || !e.risk?.level) continue;
    if (rankOf(e.risk.level) < rankOf(minLevel)) continue;
    items.push({
      seq: e.seq,
      ts: e.ts,
      sessionId: e.sessionId,
      toolName: e.toolName,
      summary: summarize(e),
      level: e.risk.level,
      score: e.risk.score,
      reasons: e.risk.signals.map((s) => s.reason),
      action: e.action,
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

function summarize(e: LedgerEntry): string {
  const input = e.toolInput as Record<string, unknown> | undefined;
  if (input) {
    if (typeof input.command === "string") return truncate(input.command, 120);
    const p = input.file_path ?? input.path ?? input.notebook_path;
    if (typeof p === "string") return truncate(p, 120);
    if (typeof input.url === "string") return truncate(input.url, 120);
  }
  return e.toolName ?? "(action)";
}

function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
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
    lines.push(`${ICON[it.level]} [${it.level} ${it.score}] #${it.seq} ${it.toolName ?? ""}${it.action === "ask" ? " (asked)" : ""}`);
    lines.push(`    ${it.summary}`);
    lines.push(`    ${it.reasons.join("; ")}`);
  }
  return lines.join("\n");
}
