import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { sessionCostFromTranscript, rollupDailySpend, readDailySpend, localDateString } from "../src/cost.js";
import { tempRepo, writeTranscript } from "./helpers.js";

describe("sessionCostFromTranscript", () => {
  it("sums usage across assistant messages", () => {
    const repo = tempRepo();
    const t = join(repo, "transcript.jsonl");
    writeTranscript(t, [
      { model: "claude-opus-4-8", usage: { input_tokens: 1_000_000, output_tokens: 0 } }, // $5
      { model: "claude-opus-4-8", usage: { input_tokens: 0, output_tokens: 1_000_000 } }, // $25
    ]);
    const r = sessionCostFromTranscript(t);
    expect(r.totalUsd).toBeCloseTo(30, 4);
    expect(r.byModel["claude-opus-4-8"]).toBeCloseTo(30, 4);
  });

  it("flags unpriced models but still counts them at fallback", () => {
    const repo = tempRepo();
    const t = join(repo, "t.jsonl");
    writeTranscript(t, [{ model: "mystery-model", usage: { input_tokens: 1_000_000 } }]);
    const r = sessionCostFromTranscript(t);
    expect(r.unpricedModels).toContain("mystery-model");
    expect(r.totalUsd).toBeGreaterThan(0);
  });

  it("returns zero for a missing transcript", () => {
    expect(sessionCostFromTranscript(undefined).totalUsd).toBe(0);
    expect(sessionCostFromTranscript("/nope/nope.jsonl").totalUsd).toBe(0);
  });

  it("dedupes streaming lines that share a message id, keeping the LAST usage", () => {
    const repo = tempRepo();
    const t = join(repo, "t.jsonl");
    // A streamed request: usage GROWS across flushes. The first line reports a
    // near-zero output count, the last reports the real total. We must price the
    // last, not the first (or the session budget cap under-counts and trips late).
    writeTranscript(t, [
      { id: "msg_A", model: "claude-opus-4-8", usage: { input_tokens: 1_000_000, output_tokens: 1 } },
      { id: "msg_A", model: "claude-opus-4-8", usage: { input_tokens: 1_000_000, output_tokens: 500_000 } },
      { id: "msg_A", model: "claude-opus-4-8", usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
    ]);
    // last line: 1M input @ $5 + 1M output @ $25 = $30 (NOT $5 from the first line)
    expect(sessionCostFromTranscript(t).totalUsd).toBeCloseTo(30, 4);
  });

  it("counts two DISTINCT messages that share nothing (no false dedupe)", () => {
    const repo = tempRepo();
    const t = join(repo, "t.jsonl");
    writeTranscript(t, [
      { id: "msg_A", model: "claude-opus-4-8", usage: { output_tokens: 1_000_000 } }, // $25
      { id: "msg_B", model: "claude-opus-4-8", usage: { output_tokens: 1_000_000 } }, // $25
    ]);
    expect(sessionCostFromTranscript(t).totalUsd).toBeCloseTo(50, 4);
  });

  it("prices 5m and 1h cache writes from the breakdown", () => {
    const repo = tempRepo();
    const t = join(repo, "t.jsonl");
    writeTranscript(t, [
      {
        id: "m1",
        model: "claude-opus-4-8", // input $5/M
        usage: {
          cache_creation_input_tokens: 2_000_000,
          cache_creation: {
            ephemeral_5m_input_tokens: 1_000_000, // 1M * $5 * 1.25 = $6.25
            ephemeral_1h_input_tokens: 1_000_000, // 1M * $5 * 2.00 = $10.00
          },
        },
      },
    ]);
    expect(sessionCostFromTranscript(t).totalUsd).toBeCloseTo(16.25, 4);
  });

  it("tolerates a partially-written final line", () => {
    const repo = tempRepo();
    const t = join(repo, "t.jsonl");
    writeTranscript(t, [{ model: "claude-haiku-4-5", usage: { input_tokens: 1_000_000 } }]);
    // Append a truncated JSON line (as if written mid-flush).
    const { appendFileSync } = require("node:fs");
    appendFileSync(t, '{"type":"assistant","message":{"model":"claude');
    expect(() => sessionCostFromTranscript(t)).not.toThrow();
    expect(sessionCostFromTranscript(t).totalUsd).toBeCloseTo(1, 4);
  });
});

describe("daily rollup", () => {
  it("aggregates across sessions for the day", () => {
    const repo = tempRepo();
    const day = "2026-07-10";
    rollupDailySpend(repo, "session-a", 3, day);
    const total = rollupDailySpend(repo, "session-b", 4, day);
    expect(total).toBeCloseTo(7, 6);
    expect(readDailySpend(repo, day)).toBeCloseTo(7, 6);
  });

  it("overwrites a session's own value rather than double-counting", () => {
    const repo = tempRepo();
    const day = "2026-07-10";
    rollupDailySpend(repo, "session-a", 3, day);
    const total = rollupDailySpend(repo, "session-a", 9, day); // same session, updated total
    expect(total).toBeCloseTo(9, 6);
  });

  it("separates spend by local date", () => {
    const repo = tempRepo();
    rollupDailySpend(repo, "s", 5, "2026-07-10");
    rollupDailySpend(repo, "s", 8, "2026-07-11");
    expect(readDailySpend(repo, "2026-07-10")).toBeCloseTo(5, 6);
    expect(readDailySpend(repo, "2026-07-11")).toBeCloseTo(8, 6);
  });
});

describe("localDateString", () => {
  it("formats YYYY-MM-DD", () => {
    expect(localDateString(new Date(2026, 6, 5))).toBe("2026-07-05");
  });
});
