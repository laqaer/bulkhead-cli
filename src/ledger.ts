import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LedgerEntry } from "./types.js";
import { ledgerPath } from "./paths.js";
import { withFileLock } from "./fs-lock.js";

const GENESIS = "GENESIS";

/**
 * Append-only, hash-chained evidence ledger.
 *
 * Each entry stores the sha256 of the previous entry's hash in `prevHash`, and
 * its own `hash` is the sha256 of its canonical JSON with `hash` omitted. Any
 * edit to a past entry breaks every subsequent link, and a deleted mid-chain
 * entry shows up as a seq gap — so `verify` detects modification and deletion
 * WITHIN the recorded chain. What a bare hash chain cannot detect is removal of
 * trailing entries (truncate the file after entry N and the prefix still
 * verifies): proving the tail needs an external anchor, e.g. a hosted sync.
 * This is an integrity check for a local audit trail — it proves the recorded
 * chain wasn't quietly altered, not that the machine is secure.
 */

/** Canonical serialization used for hashing (stable key order, no `hash`). */
function canonical(entry: Omit<LedgerEntry, "hash">): string {
  return stableStringify(entry);
}

export function hashEntry(entry: Omit<LedgerEntry, "hash">): string {
  return createHash("sha256").update(canonical(entry)).digest("hex");
}

/**
 * Read all entries. Unparseable lines (a torn write from a killed/crashed hook,
 * an interleaved append) are SKIPPED, not thrown on — a single bad line must
 * never crash the reader, because appendLedger reads on every hook invocation
 * and a throw there would fail the whole session open. A dropped mid-chain line
 * still shows up as a seq gap in `verify`, so tampering remains detectable.
 */
export function readLedger(repoRoot: string): LedgerEntry[] {
  return readLedgerWithStats(repoRoot).entries;
}

export interface LedgerReadStats {
  entries: LedgerEntry[];
  /** Non-empty lines that failed to parse (torn write or corruption). */
  skippedLines: number;
}

/** Like readLedger, but also reports how many unparseable lines were skipped. */
export function readLedgerWithStats(repoRoot: string): LedgerReadStats {
  const path = ledgerPath(repoRoot);
  if (!existsSync(path)) return { entries: [], skippedLines: 0 };
  return parseLedgerText(readFileSync(path, "utf8"));
}

function parseLedgerText(text: string): LedgerReadStats {
  const entries: LedgerEntry[] = [];
  let skippedLines = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as LedgerEntry);
    } catch {
      // torn / interleaved line — skip so the ledger self-heals on next append
      skippedLines++;
    }
  }
  return { entries, skippedLines };
}

/**
 * Append one entry. Reads the tail to find the previous hash and sequence.
 * The read-tail → hash → append is done under a cross-process lock so that two
 * concurrent hook processes (Claude Code runs tool calls in parallel) can't
 * both chain off the same tail and fork the hash chain — which would make
 * `verify` report tampering forever on a perfectly legitimate run.
 */
export function appendLedger(
  repoRoot: string,
  partial: Omit<LedgerEntry, "seq" | "prevHash" | "hash">,
): LedgerEntry {
  const path = ledgerPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });

  return withFileLock(`${path}.lock`, () => {
    const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
    const existing = parseLedgerText(raw).entries;
    const last = existing[existing.length - 1];
    const seq = last ? last.seq + 1 : 0;
    const prevHash = last ? last.hash : GENESIS;

    const withoutHash: Omit<LedgerEntry, "hash"> = { ...partial, seq, prevHash };
    const hash = hashEntry(withoutHash);
    const entry: LedgerEntry = { ...withoutHash, hash };

    // Heal a torn final line: if the file doesn't end in a newline, our append
    // would concatenate onto the partial line and corrupt this entry too. Start
    // on a fresh line so the new entry is always independently parseable.
    const prefix = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
    appendFileSync(path, prefix + JSON.stringify(entry) + "\n");
    return entry;
  });
}

export interface VerifyResult {
  ok: boolean;
  count: number;
  /** 1-based index of the first broken entry, if any. */
  brokenAt?: number;
  reason?: string;
}

/** Recompute the chain and confirm every link and hash. */
export function verifyLedger(entries: LedgerEntry[]): VerifyResult {
  let prevHash = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.seq !== i) {
      return { ok: false, count: entries.length, brokenAt: i + 1, reason: `seq ${e.seq} != expected ${i}` };
    }
    if (e.prevHash !== prevHash) {
      return { ok: false, count: entries.length, brokenAt: i + 1, reason: "prevHash does not match prior entry" };
    }
    const { hash, ...rest } = e;
    const recomputed = hashEntry(rest);
    if (recomputed !== hash) {
      return { ok: false, count: entries.length, brokenAt: i + 1, reason: "hash mismatch (entry was modified)" };
    }
    prevHash = hash;
  }
  return { ok: true, count: entries.length };
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}
