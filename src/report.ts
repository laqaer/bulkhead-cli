import type { Evidence, EvidenceType, LedgerEntry } from "./types.js";
import type { Verdict } from "./verify.js";

/**
 * Turn the raw ledger into the thing a human actually reads between incidents:
 * per-session summaries with per-prompt cost attribution, denials, evidence,
 * and completion verdicts. Pure functions over ledger entries — same
 * determinism rule as enforcement.
 */

export interface PromptCost {
  promptId: string;
  usd: number;
  toolCalls: number;
  denials: number;
}

export interface SessionReport {
  sessionId: string;
  firstTs?: string;
  lastTs?: string;
  totalUsd: number;
  prompts: PromptCost[];
  denials: Array<{ seq: number; toolName?: string; guard?: string; rule?: string }>;
  evidence: Partial<Record<EvidenceType, number>>;
  evidenceSamples: Evidence[];
  stopVerdicts: Verdict[];
  stopsBlocked: number;
}

export function buildSessionReport(entries: LedgerEntry[], sessionId: string): SessionReport {
  const mine = entries.filter((e) => e.sessionId === sessionId);

  // Per-prompt cost: the session cost snapshot is monotonic (a deterministic
  // re-sum of the transcript), so the delta between consecutive snapshots is
  // the spend that happened between those two hook firings. Attribute each
  // delta to the prompt active at the LATER entry — the model call that spent
  // it is the one that produced that entry's tool call.
  const promptMap = new Map<string, PromptCost>();
  let prevUsd = 0;
  for (const e of mine) {
    const pid = e.promptId ?? "(unattributed)";
    let p = promptMap.get(pid);
    if (!p) {
      p = { promptId: pid, usd: 0, toolCalls: 0, denials: 0 };
      promptMap.set(pid, p);
    }
    if (e.event === "pre") {
      p.toolCalls += 1;
      if (e.action === "deny") p.denials += 1;
    }
    if (e.cost) {
      p.usd += Math.max(0, e.cost.sessionUsd - prevUsd);
      prevUsd = Math.max(prevUsd, e.cost.sessionUsd);
    }
  }

  const evidenceCounts: Partial<Record<EvidenceType, number>> = {};
  const evidenceSamples: Evidence[] = [];
  for (const e of mine) {
    for (const ev of e.evidence ?? []) {
      evidenceCounts[ev.type] = (evidenceCounts[ev.type] ?? 0) + 1;
      if (evidenceSamples.length < 10) evidenceSamples.push(ev);
    }
  }

  const stopVerdicts: Verdict[] = [];
  let stopsBlocked = 0;
  for (const e of mine) {
    if (e.event !== "stop") continue;
    if (e.action === "deny") stopsBlocked += 1;
    const v = e.meta?.verdicts;
    if (Array.isArray(v)) stopVerdicts.push(...(v as Verdict[]));
  }

  return {
    sessionId,
    firstTs: mine[0]?.ts,
    lastTs: mine[mine.length - 1]?.ts,
    totalUsd: prevUsd,
    prompts: [...promptMap.values()].sort((a, b) => b.usd - a.usd),
    denials: mine
      .filter((e) => e.event === "pre" && e.action === "deny")
      .map((e) => ({ seq: e.seq, toolName: e.toolName, guard: e.guard, rule: e.rule })),
    evidence: evidenceCounts,
    evidenceSamples,
    stopVerdicts,
    stopsBlocked,
  };
}

/** Session ids in first-seen order (oldest first). */
export function sessionIds(entries: LedgerEntry[]): string[] {
  const seen = new Set<string>();
  for (const e of entries) seen.add(e.sessionId);
  return [...seen];
}

export function renderSessionReport(r: SessionReport): string {
  const lines: string[] = [];
  const span =
    r.firstTs && r.lastTs ? `${r.firstTs.slice(0, 16)} → ${r.lastTs.slice(11, 16)}` : "";
  lines.push(`Session ${shorten(r.sessionId)}  ${span}`);
  lines.push(`  Cost: $${r.totalUsd.toFixed(2)} across ${r.prompts.length} prompt(s)`);
  for (const p of r.prompts) {
    lines.push(
      `    ${shorten(p.promptId).padEnd(14)} $${p.usd.toFixed(2).padStart(6)}  ${p.toolCalls} tool call(s)${p.denials ? `, ${p.denials} denied` : ""}`,
    );
  }
  if (r.denials.length > 0) {
    lines.push(`  Denied: ${r.denials.length}`);
    for (const d of r.denials.slice(-5)) {
      lines.push(`    ⛔ #${d.seq} ${d.toolName ?? ""} [${d.guard}] ${d.rule ?? ""}`);
    }
  }
  const evParts = Object.entries(r.evidence).map(([t, n]) => `${t}×${n}`);
  if (evParts.length > 0) lines.push(`  Evidence: ${evParts.join(", ")}`);
  if (r.stopVerdicts.length > 0) {
    lines.push(`  Completion checks:${r.stopsBlocked > 0 ? ` (${r.stopsBlocked} stop(s) blocked)` : ""}`);
    for (const v of r.stopVerdicts.slice(-6)) {
      const icon = v.status === "supported" ? "✅" : v.status === "contradicted" ? "⛔" : "⚠️ ";
      lines.push(`    ${icon} [${v.ruleId}] ${v.status}: "${v.claimExcerpt}"`);
    }
  }
  return lines.join("\n");
}

function shorten(id: string): string {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-5)}` : id;
}
