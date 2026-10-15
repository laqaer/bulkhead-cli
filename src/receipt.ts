import { basename } from "node:path";
import type { LedgerEntry, RiskLevel } from "./types.js";
import type { Verdict, VerdictStatus } from "./verify.js";
import { buildSessionReport, sessionIds } from "./report.js";
import { buildInbox } from "./inbox.js";
import { verifyLedger } from "./ledger.js";
import { redact } from "./redact.js";
import {
  actionSummary,
  clip,
  denialLabel,
  evidenceCount,
  evidenceSentence,
  type SummaryMode,
} from "./describe.js";

/**
 * `bulkhead receipt`: one session, on one page, in a form you can paste into
 * a pull request. What the agent tried, what was blocked and why, what it
 * claimed at the end and whether the evidence agreed, what it cost, and the
 * ledger head so anyone holding the ledger can check the record.
 *
 * Pure over ledger entries. Redaction is on by default: paths are printed
 * repo-relative and credentials are masked (see redact.ts).
 */

export const VERIFY_COMMAND = "npx @bulkheadtools/cli ledger verify";
export const SCOPE_LINE =
  "Local, hash-chained record. Not a sandbox; the tail is not anchored off-machine.";

export type ReceiptFormat = "md" | "txt" | "html";
export const RECEIPT_FORMATS: readonly ReceiptFormat[] = ["md", "txt", "html"];

export interface ReceiptBlock {
  seq: number;
  tool: string;
  /** The command or path, clipped (and redacted unless --no-redact). */
  action: string;
  /** Human reason: the rule's message, never its regex. */
  why: string;
  guard: string;
}

export interface ReceiptRisk {
  seq: number;
  tool: string;
  action: string;
  level: RiskLevel;
  score: number;
  why: string;
  asked: boolean;
}

export interface ReceiptClaim {
  /** Ledger seq of the stop entry that judged it. */
  seq: number;
  ruleId: string;
  claim: string;
  status: VerdictStatus;
  /** The deciding evidence, as a sentence (absent when none was recorded). */
  evidence?: string;
  /** The stop was refused and the agent had to keep working. */
  sentBack: boolean;
}

export interface Receipt {
  repo: string;
  sessionId: string;
  firstTs?: string;
  lastTs?: string;
  toolCalls: number;
  blocked: ReceiptBlock[];
  risky: ReceiptRisk[];
  spend: { usd: number; capUsd: number; paused: boolean };
  claims: ReceiptClaim[];
  evidence: Array<{ type: string; count: number; label: string }>;
  ledger: { entries: number; head?: string; ok: boolean; brokenAt?: number; reason?: string };
  redacted: boolean;
}

export interface ReceiptOptions {
  repoRoot: string;
  sessionId: string;
  /** Default true. */
  redact?: boolean;
  /** policy.budget.session_usd; 0 or absent = no cap. */
  sessionCapUsd?: number;
}

/** Most recent session by default; an exact id, or a unique prefix of one. */
export function resolveSession(
  entries: LedgerEntry[],
  requested?: string,
): { sessionId: string } | { error: string } {
  if (entries.length === 0) return { error: "The ledger is empty." };
  if (!requested) return { sessionId: entries[entries.length - 1]!.sessionId };
  const ids = sessionIds(entries);
  if (ids.includes(requested)) return { sessionId: requested };
  const hits = ids.filter((id) => id.startsWith(requested));
  if (hits.length === 1) return { sessionId: hits[0]! };
  const recent = ids.slice(-5).reverse().join(", ");
  return {
    error:
      hits.length > 1
        ? `Session prefix "${requested}" matches ${hits.length} sessions: ${hits.slice(0, 5).join(", ")}`
        : `No session "${requested}" in the ledger. Recent sessions: ${recent}`,
  };
}

const EVIDENCE_ORDER = [
  "test_failed",
  "test_passed",
  "test_run",
  "commit_created",
  "pr_created",
  "file_modified",
  "file_created",
];

export function buildReceipt(entries: LedgerEntry[], opts: ReceiptOptions): Receipt {
  const redacted = opts.redact !== false;
  const mode: SummaryMode = redacted ? "full" : "none";
  const repoRoot = opts.repoRoot;
  const text = (s: string) => (redacted ? redact(s, { repoRoot }) : s);

  const mine = entries.filter((e) => e.sessionId === opts.sessionId);
  const report = buildSessionReport(entries, opts.sessionId, { repoRoot });

  const blocked: ReceiptBlock[] = mine
    .filter((e) => e.event === "pre" && e.action === "deny")
    .map((e) => ({
      seq: e.seq,
      tool: e.toolName ?? "",
      action: actionSummary(e.toolInput, { repoRoot, mode, max: 96 }),
      why: text(denialLabel(e)),
      guard: e.guard ?? "bulkhead",
    }));

  const bySeq = new Map(mine.map((e) => [e.seq, e]));
  const risky: ReceiptRisk[] = buildInbox(mine, "low", { repoRoot })
    .items.filter((it) => !it.blocked)
    .map((it) => ({
      seq: it.seq,
      tool: it.toolName ?? "",
      action: actionSummary(bySeq.get(it.seq)?.toolInput, { repoRoot, mode, max: 96 }),
      level: it.level,
      score: it.score,
      why: it.reasons.join("; "),
      asked: it.action === "ask",
    }));

  const claims: ReceiptClaim[] = [];
  for (const e of mine) {
    if (e.event !== "stop" || !Array.isArray(e.meta?.verdicts)) continue;
    for (const v of e.meta!.verdicts as Verdict[]) {
      claims.push({
        seq: e.seq,
        ruleId: v.ruleId,
        claim: text(clip(v.claimExcerpt, 80)),
        status: v.status,
        evidence: v.evidence ? evidenceSentence(v.evidence, { repoRoot, mode, max: 110 }) : undefined,
        sentBack: e.action === "deny" && v.status !== "supported",
      });
    }
  }

  const evidence = Object.entries(report.evidence)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([type, n]) => ({ type, count: n ?? 0, label: evidenceCount(type, n ?? 0) }));

  const integrity = verifyLedger(entries);
  const last = entries[entries.length - 1];

  return {
    repo: basename(repoRoot) || repoRoot,
    sessionId: opts.sessionId,
    firstTs: report.firstTs,
    lastTs: report.lastTs,
    toolCalls: mine.filter((e) => e.event === "pre").length,
    blocked,
    risky,
    spend: {
      usd: report.totalUsd,
      capUsd: opts.sessionCapUsd ?? 0,
      paused: mine.some((e) => e.event === "pre" && e.action === "deny" && e.guard === "budget"),
    },
    claims,
    evidence,
    ledger: {
      entries: entries.length,
      head: last?.hash,
      ok: integrity.ok,
      brokenAt: integrity.brokenAt,
      reason: integrity.reason,
    },
    redacted,
  };
}

function rank(type: string): number {
  const i = EVIDENCE_ORDER.indexOf(type);
  return i === -1 ? EVIDENCE_ORDER.length : i;
}

export function renderReceipt(r: Receipt, format: ReceiptFormat): string {
  if (format === "txt") return renderReceiptText(r);
  if (format === "html") return renderReceiptHtml(r);
  return renderReceiptMarkdown(r);
}

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

const MAX_BLOCKED = 10;
const MAX_RISKY = 5;
const MAX_CLAIMS = 8;

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function shortHash(h: string | undefined): string {
  return h ? h.slice(0, 12) : "—";
}

function tsParts(ts: string | undefined): { date: string; time: string } | undefined {
  if (!ts) return undefined;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return undefined;
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** "2026-09-25 06:01 → 06:43 UTC (42 min)". */
export function spanText(first?: string, last?: string): string {
  const a = tsParts(first);
  const b = tsParts(last);
  if (!a || !b) return first ?? "";
  const end = a.date === b.date ? b.time : `${b.date} ${b.time}`;
  return `${a.date} ${a.time} → ${end} UTC (${durationText(first!, last!)})`;
}

export function durationText(first: string, last: string): string {
  const ms = new Date(last).getTime() - new Date(first).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "<1 min";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}


function claimTally(r: Receipt): string {
  if (r.claims.length === 0) return "none made";
  const contradicted = r.claims.filter((c) => c.status === "contradicted").length;
  const supported = r.claims.filter((c) => c.status === "supported").length;
  const unsupported = r.claims.filter((c) => c.status === "unsupported").length;
  const parts = [`${contradicted} contradicted`, `${supported} supported`];
  if (unsupported) parts.push(`${unsupported} without evidence`);
  return parts.join(", ");
}

const RISK_ICON: Record<RiskLevel, string> = { high: "🔴", medium: "🟠", low: "🟡" };

// ---------------------------------------------------------------------------
// Markdown: compact, pasteable into a PR description. No HTML.
// ---------------------------------------------------------------------------

function mdCell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function mdCode(s: string): string {
  if (!s) return "";
  const fence = s.includes("`") ? "``" : "`";
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`.replace(/\|/g, "\\|");
}

/** Evidence sentences carry `cmd` ticks already; only escape table pipes. */
function mdInline(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function renderReceiptMarkdown(r: Receipt): string {
  const out: string[] = [];
  out.push(`### 🛡 Bulkhead receipt · \`${r.repo}\``);
  out.push("");
  const span = spanText(r.firstTs, r.lastTs);
  out.push(
    [
      `Session ${mdCode(clip(r.sessionId, 40))}`,
      span,
      `**${r.toolCalls}** tool call${r.toolCalls === 1 ? "" : "s"} checked`,
      `**${usd(r.spend.usd)}** spent${r.spend.capUsd > 0 ? ` of ${usd(r.spend.capUsd)} cap` : ""}${r.spend.paused ? " (paused at cap)" : ""}`,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  out.push("");
  out.push("| Blocked | Risky, allowed | Completion claims | Ledger |");
  out.push("|:--|:--|:--|:--|");
  out.push(
    `| **${r.blocked.length}** | ${r.risky.length} | ${claimTally(r)} | ${r.ledger.entries} entries · head \`${shortHash(r.ledger.head)}\` · ${
      r.ledger.ok ? "✅ chain verified" : `❌ chain broken at entry ${r.ledger.brokenAt}`
    } |`,
  );

  if (r.blocked.length > 0) {
    out.push("");
    out.push(`**⛔ Blocked (${r.blocked.length})**`);
    out.push("");
    out.push("| # | Tool | Attempted | Why |");
    out.push("|--:|:--|:--|:--|");
    for (const b of r.blocked.slice(0, MAX_BLOCKED)) {
      out.push(`| ${b.seq} | ${mdCell(b.tool)} | ${mdCode(b.action)} | ${mdCell(b.why)} |`);
    }
    if (r.blocked.length > MAX_BLOCKED) {
      out.push("");
      out.push(`…and ${r.blocked.length - MAX_BLOCKED} more blocked (\`bulkhead report\` lists them all).`);
    }
  }

  if (r.claims.length > 0) {
    out.push("");
    out.push("**Completion claims**");
    out.push("");
    out.push("| # | Claim | Verdict | Deciding evidence |");
    out.push("|--:|:--|:--|:--|");
    for (const c of r.claims.slice(-MAX_CLAIMS)) {
      const verdict =
        c.status === "contradicted"
          ? `⛔ **Claim ≠ evidence**${c.sentBack ? " — sent back to work" : ""}`
          : c.status === "supported"
            ? "✅ Supported"
            : `⚠️ No evidence${c.sentBack ? ", sent back to work" : ""}`;
      out.push(
        `| ${c.seq} | “${mdCell(c.claim)}” | ${verdict} | ${c.evidence ? mdInline(c.evidence) : "none recorded this session"} |`,
      );
    }
  }

  if (r.risky.length > 0) {
    out.push("");
    out.push("**Risky, allowed** · highest risk first");
    out.push("");
    out.push("| # | Risk | Attempted | Why it's risky |");
    out.push("|--:|:--|:--|:--|");
    for (const k of r.risky.slice(0, MAX_RISKY)) {
      out.push(
        `| ${k.seq} | ${RISK_ICON[k.level]} ${k.level} ${k.score}${k.asked ? " (asked)" : ""} | ${mdCode(k.action)} | ${mdCell(k.why)} |`,
      );
    }
    if (r.risky.length > MAX_RISKY) {
      out.push("");
      out.push(`…and ${r.risky.length - MAX_RISKY} more (\`bulkhead inbox\`).`);
    }
  }

  if (r.evidence.length > 0) {
    out.push("");
    out.push(`**Evidence** · ${r.evidence.map((e) => e.label).join(" · ")}`);
  }

  out.push("");
  out.push("---");
  out.push("");
  out.push(`Verify: \`${VERIFY_COMMAND}\``);
  out.push("");
  out.push(`${SCOPE_LINE}${r.redacted ? "" : " Unredacted: commands appear verbatim."}`);
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Text: 48 columns, monospace, thermal-receipt style.
// ---------------------------------------------------------------------------

export const TXT_WIDTH = 48;

/** Terminal display width: astral emoji and CJK take two columns, marks none. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x300 && cp <= 0x36f)) continue;
    if (
      cp > 0xffff ||
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xff60)
    ) {
      w += 2;
    } else w += 1;
  }
  return w;
}

/** Hard-wrap to `width` columns, preferring spaces, breaking long tokens. */
export function wrapText(s: string, width: number): string[] {
  const words = s.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  const push = () => {
    if (cur) lines.push(cur);
    cur = "";
  };
  for (let word of words) {
    while (displayWidth(word) > width) {
      if (cur) push();
      let head = "";
      for (const ch of word) {
        if (displayWidth(head + ch) > width) break;
        head += ch;
      }
      lines.push(head);
      word = word.slice(head.length);
    }
    if (!word) continue;
    if (!cur) cur = word;
    else if (displayWidth(cur) + 1 + displayWidth(word) <= width) cur += " " + word;
    else {
      push();
      cur = word;
    }
  }
  push();
  return lines.length ? lines : [""];
}

function padEndW(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}

function kv(key: string, value: string, width = TXT_WIDTH): string[] {
  const gap = width - displayWidth(key) - displayWidth(value);
  if (gap >= 1) return [key + " ".repeat(gap) + value];
  return [key, ...wrapText(value, width - 2).map((l) => " ".repeat(Math.max(2, width - displayWidth(l))) + l)];
}

function center(s: string, width = TXT_WIDTH): string {
  const w = displayWidth(s);
  if (w >= width) return s;
  return " ".repeat(Math.floor((width - w) / 2)) + s;
}

function indented(s: string, indent = 4, width = TXT_WIDTH): string[] {
  return wrapText(s, width - indent).map((l) => " ".repeat(indent) + l);
}

/** `> reason` with continuation lines aligned under the text, not the marker. */
function hanging(marker: string, s: string, indent = 4, width = TXT_WIDTH): string[] {
  const lead = indent + displayWidth(marker);
  return wrapText(s, width - lead).map(
    (l, i) => " ".repeat(indent) + (i === 0 ? marker : " ".repeat(displayWidth(marker))) + l,
  );
}

export function renderReceiptText(r: Receipt): string {
  const W = TXT_WIDTH;
  const heavy = "=".repeat(W);
  const light = "-".repeat(W);
  const out: string[] = [];
  const a = tsParts(r.firstTs);
  const b = tsParts(r.lastTs);

  out.push(heavy);
  out.push(center("B U L K H E A D"));
  out.push(center("agent session receipt"));
  out.push(heavy);
  out.push(...kv("REPO", clip(r.repo, 40)));
  out.push(...kv("SESSION", clip(r.sessionId, 38)));
  if (a) out.push(...kv("START", `${a.date} ${a.time} UTC`));
  if (b) out.push(...kv("END", `${b.date} ${b.time} UTC`));
  if (r.firstTs && r.lastTs && a && b) out.push(...kv("DURATION", durationText(r.firstTs, r.lastTs)));
  out.push(light);
  out.push(...kv("TOOL CALLS CHECKED", String(r.toolCalls)));
  out.push(...kv("BLOCKED", String(r.blocked.length)));
  out.push(...kv("RISKY, ALLOWED", String(r.risky.length)));
  out.push(...kv("CLAIMS", claimTally(r)));
  out.push(
    ...kv(
      "SPEND",
      `${usd(r.spend.usd)}${r.spend.capUsd > 0 ? ` / ${usd(r.spend.capUsd)} cap` : ""}`,
    ),
  );
  if (r.spend.paused) out.push(...kv("", "** PAUSED AT CAP **"));

  if (r.blocked.length > 0) {
    out.push(light);
    out.push("BLOCKED");
    for (const x of r.blocked.slice(0, MAX_BLOCKED)) {
      out.push(padEndW(`#${x.seq}`, 5) + x.tool);
      out.push(...indented(x.action || "(no command)"));
      out.push(...hanging("> ", x.why));
    }
    if (r.blocked.length > MAX_BLOCKED) {
      out.push(...indented(`...and ${r.blocked.length - MAX_BLOCKED} more`, 0));
    }
  }

  if (r.claims.length > 0) {
    out.push(light);
    out.push("COMPLETION CLAIMS");
    for (const c of r.claims.slice(-MAX_CLAIMS)) {
      out.push(...wrapText(`#${c.seq} "${c.claim}"`, W));
      const verdict =
        c.status === "contradicted"
          ? "*** CLAIM ≠ EVIDENCE ***"
          : c.status === "supported"
            ? "SUPPORTED"
            : "NO EVIDENCE";
      out.push(...indented(verdict));
      if (c.evidence) out.push(...indented(c.evidence.replace(/`/g, "")));
      if (c.sentBack) out.push(...hanging("-> ", "sent back to work"));
    }
  }

  if (r.risky.length > 0) {
    out.push(light);
    out.push("RISKY, ALLOWED (highest first)");
    for (const k of r.risky.slice(0, MAX_RISKY)) {
      out.push(`${padEndW(`#${k.seq}`, 5)}${k.level.toUpperCase()} ${k.score}  ${k.tool}${k.asked ? " (asked)" : ""}`);
      out.push(...indented(k.action || "(no command)"));
      out.push(...indented(k.why));
    }
    if (r.risky.length > MAX_RISKY) out.push(`...and ${r.risky.length - MAX_RISKY} more`);
  }

  if (r.evidence.length > 0) {
    out.push(light);
    out.push("EVIDENCE");
    for (const e of r.evidence) {
      const noun = e.label.slice(String(e.count).length + 1);
      out.push(...kv(`  ${noun}`, String(e.count)));
    }
  }

  out.push(light);
  out.push(...kv("LEDGER ENTRIES", String(r.ledger.entries)));
  out.push(...kv("HEAD", shortHash(r.ledger.head)));
  out.push(...kv("CHAIN", r.ledger.ok ? "VERIFIED" : `BROKEN AT #${r.ledger.brokenAt}`));
  out.push(heavy);
  out.push(...wrapText(`Verify: ${VERIFY_COMMAND}`, W));
  out.push(...wrapText(SCOPE_LINE, W));
  if (!r.redacted) out.push(...wrapText("UNREDACTED: commands appear verbatim.", W));
  out.push(heavy);
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// HTML: one self-contained file. No scripts, fonts, or external requests.
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape, then render `cmd` spans from evidence sentences as <code>. */
function escTicks(s: string): string {
  return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** A decorative barcode drawn from the ledger head hash: deterministic, inline. */
function barcode(hash: string | undefined): string {
  const hex = (hash ?? "0".repeat(64)).slice(0, 48);
  const bars = [...hex]
    .map((c) => {
      const v = parseInt(c, 16) || 0;
      return `<i style="width:${1 + (v % 3)}px;margin-right:${1 + ((v >> 2) % 2)}px"></i>`;
    })
    .join("");
  return `<div class="barcode" aria-hidden="true">${bars}</div>`;
}

function row(label: string, value: string, cls = ""): string {
  return `<div class="row${cls ? " " + cls : ""}"><span>${esc(label)}</span><span>${value}</span></div>`;
}

export function renderReceiptHtml(r: Receipt): string {
  const a = tsParts(r.firstTs);
  const b = tsParts(r.lastTs);
  const parts: string[] = [];

  parts.push(`<header>
      <div class="brand">BULKHEAD</div>
      <div class="sub">agent session receipt</div>
    </header>`);

  parts.push(`<section class="meta">
      ${row("Repo", esc(r.repo))}
      ${row("Session", esc(clip(r.sessionId, 40)))}
      ${a ? row("Start", esc(`${a.date} ${a.time} UTC`)) : ""}
      ${b ? row("End", esc(`${b.date} ${b.time} UTC`)) : ""}
      ${r.firstTs && r.lastTs && a && b ? row("Duration", esc(durationText(r.firstTs, r.lastTs))) : ""}
    </section>`);

  parts.push(`<section class="totals">
      ${row("Tool calls checked", String(r.toolCalls))}
      ${row("Blocked", String(r.blocked.length), r.blocked.length > 0 ? "red" : "")}
      ${row("Risky, allowed", String(r.risky.length))}
      ${row("Completion claims", esc(claimTally(r)))}
      ${row(
        "Spend",
        esc(`${usd(r.spend.usd)}${r.spend.capUsd > 0 ? ` / ${usd(r.spend.capUsd)} cap` : ""}`) +
          (r.spend.paused ? ` <b class="flag">PAUSED</b>` : ""),
      )}
    </section>`);

  if (r.blocked.length > 0) {
    const items = r.blocked
      .slice(0, MAX_BLOCKED)
      .map(
        (x) => `<li>
          <div class="line"><span class="seq">#${x.seq}</span><span class="tool">${esc(x.tool)}</span></div>
          <code class="cmd">${esc(x.action || "(no command)")}</code>
          <div class="why red"><span class="ic">⛔</span><span>${esc(x.why)}</span></div>
        </li>`,
      )
      .join("");
    const more =
      r.blocked.length > MAX_BLOCKED
        ? `<p class="more">…and ${r.blocked.length - MAX_BLOCKED} more</p>`
        : "";
    parts.push(`<section><h2>Blocked</h2><ol class="items">${items}</ol>${more}</section>`);
  }

  if (r.claims.length > 0) {
    const items = r.claims
      .slice(-MAX_CLAIMS)
      .map((c) => {
        const verdict =
          c.status === "contradicted"
            ? `<span class="stamp">CLAIM ≠ EVIDENCE</span>`
            : c.status === "supported"
              ? `<span class="ok">✓ supported</span>`
              : `<span class="muted">no evidence</span>`;
        return `<li class="${c.status}">
          <div class="line"><span class="seq">#${c.seq}</span><q>${esc(c.claim)}</q>${verdict}</div>
          ${c.evidence ? `<div class="evidence">${escTicks(c.evidence)}</div>` : ""}
          ${c.sentBack ? `<div class="why red">sent back to work</div>` : ""}
        </li>`;
      })
      .join("");
    parts.push(`<section><h2>Completion claims</h2><ol class="items claims">${items}</ol></section>`);
  }

  if (r.risky.length > 0) {
    const items = r.risky
      .slice(0, MAX_RISKY)
      .map(
        (k) => `<li>
          <div class="line"><span class="seq">#${k.seq}</span><span class="tool">${esc(k.tool)}</span><span class="lvl">${esc(k.level)} ${k.score}${k.asked ? " · asked" : ""}</span></div>
          <code class="cmd">${esc(k.action || "(no command)")}</code>
          <div class="why">${esc(k.why)}</div>
        </li>`,
      )
      .join("");
    parts.push(`<section><h2>Risky, allowed</h2><ol class="items">${items}</ol></section>`);
  }

  if (r.evidence.length > 0) {
    const rows = r.evidence
      .map((e) => row(e.label.slice(String(e.count).length + 1), String(e.count)))
      .join("");
    parts.push(`<section><h2>Evidence</h2>${rows}</section>`);
  }

  parts.push(`<section class="ledger">
      ${row("Ledger entries", String(r.ledger.entries))}
      ${row("Head", `<code>${esc(shortHash(r.ledger.head))}</code>`)}
      ${row("Chain", r.ledger.ok ? "VERIFIED ✓" : `<b class="red">BROKEN AT #${r.ledger.brokenAt}</b>`)}
      ${barcode(r.ledger.head)}
    </section>`);

  parts.push(`<footer>
      <p>Verify: <code>${esc(VERIFY_COMMAND)}</code></p>
      <p>${esc(SCOPE_LINE)}</p>
      ${r.redacted ? "" : `<p class="red">Unredacted: commands appear verbatim.</p>`}
    </footer>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Bulkhead receipt · ${esc(r.repo)}</title>
<style>
:root{--bg:#101214;--paper:#f5f1e6;--ink:#1f1d19;--muted:#77705f;--rule:#cdc5b1;--red:#c1272d}
*{box-sizing:border-box}
html,body{margin:0}
body{min-height:100vh;display:flex;justify-content:center;align-items:flex-start;padding:56px 16px;
  background:radial-gradient(120% 80% at 50% 0%,#23282d 0%,var(--bg) 65%);
  font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;color:var(--ink)}
.receipt{position:relative;width:100%;max-width:400px;background:var(--paper);padding:30px 26px 26px;
  box-shadow:0 30px 70px rgba(0,0,0,.55),0 4px 14px rgba(0,0,0,.35)}
.receipt::before,.receipt::after{content:"";position:absolute;left:0;right:0;height:8px}
.receipt::before{top:-8px;background:radial-gradient(circle at 6px 8px,var(--paper) 5.5px,transparent 6px) 0 0/12px 8px repeat-x}
.receipt::after{bottom:-8px;background:radial-gradient(circle at 6px 0,var(--paper) 5.5px,transparent 6px) 0 0/12px 8px repeat-x}
header{text-align:center;padding-bottom:14px;border-bottom:2px solid var(--ink)}
.brand{font-weight:800;font-size:20px;letter-spacing:.42em;margin-right:-.42em}
.sub{color:var(--muted);font-size:11px;letter-spacing:.2em;text-transform:uppercase;margin-top:2px}
section{padding:12px 0;border-bottom:1px dashed var(--rule)}
h2{margin:0 0 8px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);font-weight:700}
.row{display:flex;justify-content:space-between;gap:12px}
.row>span:first-child{color:var(--muted)}
.row>span:last-child{text-align:right;font-weight:600}
.row.red>span:last-child{color:var(--red)}
.items{list-style:none;margin:0;padding:0}
.items li{padding:6px 0}
.items li+li{border-top:1px dotted var(--rule)}
.line{display:flex;align-items:baseline;gap:8px}
.seq{color:var(--muted);min-width:3.2em}
.tool{font-weight:700}
.lvl{margin-left:auto;color:var(--muted)}
code{font:inherit}
.cmd{display:block;margin:2px 0 2px 3.2em;padding-left:8px;overflow-wrap:anywhere;white-space:pre-wrap;border-left:2px solid var(--rule)}
.why{display:flex;gap:6px;margin-left:3.2em;font-size:12px;color:var(--muted)}
.why .ic{flex:none}
.red{color:var(--red)}
.flag{color:var(--red);letter-spacing:.12em;margin-left:6px}
.claims q{flex:1;font-weight:600}
.claims li.contradicted .line{align-items:center}
.claims li.contradicted .evidence{padding-right:6px}
.evidence{margin-left:3.2em;font-size:12px;color:var(--muted)}
.evidence code{color:var(--ink)}
.ok{color:var(--muted);white-space:nowrap}
.muted{color:var(--muted);white-space:nowrap}
.stamp{flex:none;display:inline-block;margin:10px 2px 12px 8px;color:var(--red);border:2.5px solid var(--red);border-radius:4px;padding:2px 9px 1px;
  font-weight:900;font-size:15px;letter-spacing:.2em;transform:rotate(-9deg);opacity:.9;
  box-shadow:inset 0 0 0 1.5px rgba(193,39,45,.25);mix-blend-mode:multiply}
.more{margin:6px 0 0;color:var(--muted)}
.ledger{border-bottom:2px solid var(--ink)}
.barcode{display:flex;justify-content:center;align-items:stretch;height:34px;margin-top:12px}
.barcode i{display:block;background:var(--ink)}
footer{padding-top:12px;font-size:11px;color:var(--muted);text-align:center}
footer p{margin:2px 0}
footer code{color:var(--ink)}
@media print{
  body{background:#fff;padding:0;display:block}
  .receipt{box-shadow:none;max-width:none;margin:0}
  .receipt::before,.receipt::after{display:none}
  .red,.stamp,.flag{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
</style>
</head>
<body>
<main class="receipt">
    ${parts.join("\n    ")}
</main>
</body>
</html>
`;
}
