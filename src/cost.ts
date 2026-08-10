import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CostBreakdown, ModelPrice, Usage } from "./types.js";
import { priceFor, usageCost } from "./pricing.js";
import { spendDir } from "./paths.js";
import { withFileLock, atomicWrite } from "./fs-lock.js";

/**
 * Sum the cost of every assistant message in a Claude Code transcript.
 *
 * The transcript is JSONL; assistant lines carry `message.usage` and
 * `message.model`. We tolerate unknown shapes and partial lines — a transcript
 * being written concurrently must never crash the hook.
 */
export function sessionCostFromTranscript(
  transcriptPath: string | undefined,
  pricing?: Record<string, ModelPrice>,
): { totalUsd: number; byModel: Record<string, number>; unpricedModels: string[] } {
  const byModel: Record<string, number> = {};
  const unpriced = new Set<string>();
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { totalUsd: 0, byModel, unpricedModels: [] };
  }

  let text: string;
  try {
    text = readFileSync(transcriptPath, "utf8");
  } catch {
    return { totalUsd: 0, byModel, unpricedModels: [] };
  }

  // Claude Code streams a request as several assistant lines that share a
  // message.id, and the usage GROWS across flushes — the first line reports a
  // near-zero output count, the last reports the real total. So we keep the
  // LAST line per id (overwrite), and price lines that carry no id individually.
  const lastByKey = new Map<string, { model?: string; usage: Usage }>();
  const unkeyed: Array<{ model?: string; usage: Usage }> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // partially-written final line, etc.
    }
    const msg = extractAssistantMessage(obj);
    if (!msg) continue;
    if (msg.dedupeKey) lastByKey.set(msg.dedupeKey, { model: msg.model, usage: msg.usage });
    else unkeyed.push({ model: msg.model, usage: msg.usage });
  }

  for (const msg of [...lastByKey.values(), ...unkeyed]) {
    const { price, known } = priceFor(msg.model, pricing);
    if (!known && msg.model) unpriced.add(msg.model);
    const key = msg.model ?? "unknown";
    byModel[key] = (byModel[key] ?? 0) + usageCost(msg.usage, price);
  }

  const totalUsd = Object.values(byModel).reduce((a, b) => a + b, 0);
  return { totalUsd, byModel, unpricedModels: [...unpriced] };
}

function extractAssistantMessage(
  obj: unknown,
): { model?: string; usage: Usage; dedupeKey?: string } | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.type !== "assistant") return null;
  const message = o.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Usage | undefined;
  if (!usage || typeof usage !== "object") return null;
  const model = typeof message?.model === "string" ? message.model : undefined;
  // Prefer the API message id, then the request id, then the line uuid. If none
  // exist we don't dedupe (better to slightly over-count than to silently drop
  // distinct messages that happen to share nothing).
  const dedupeKey =
    firstString(message?.id) ?? firstString(o.requestId) ?? firstString(o.uuid);
  return { model, usage, dedupeKey };
}

function firstString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Persist this session's running total and return today's aggregate across all
 * sessions. Written atomically (tmp + rename) so a crashed hook can't corrupt
 * the file another hook reads. `today` is injected for testability.
 */
export function rollupDailySpend(
  repoRoot: string,
  sessionId: string,
  sessionUsd: number,
  today: string,
): number {
  const dir = spendDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${today}.json`);

  // Lock the read-modify-write so a concurrent session's update to a different
  // key isn't lost (last-writer-wins would otherwise clobber it).
  return withFileLock(`${file}.lock`, () => {
    let map: Record<string, number> = {};
    if (existsSync(file)) {
      try {
        map = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
      } catch {
        map = {};
      }
    }
    map[sessionId] = sessionUsd;
    atomicWrite(file, JSON.stringify(map, null, 2));
    return Object.values(map).reduce((a, b) => a + b, 0);
  });
}

/** Read today's aggregate without writing (used by the budget guard's read path). */
export function readDailySpend(repoRoot: string, today: string): number {
  const file = join(spendDir(repoRoot), `${today}.json`);
  if (!existsSync(file)) return 0;
  try {
    const map = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
    return Object.values(map).reduce((a, b) => a + b, 0);
  } catch {
    return 0;
  }
}

/** Local calendar date as YYYY-MM-DD. */
export function localDateString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function buildCostBreakdown(
  session: { totalUsd: number; byModel: Record<string, number>; unpricedModels: string[] },
  dayUsd: number,
): CostBreakdown {
  return {
    sessionUsd: session.totalUsd,
    dayUsd,
    byModel: session.byModel,
    unpricedModels: session.unpricedModels,
  };
}

/** List spend rollup files (for `bulkhead status`). */
export function listSpendDates(repoRoot: string): string[] {
  const dir = spendDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}
