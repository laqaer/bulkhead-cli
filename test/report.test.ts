import { describe, it, expect } from "vitest";
import { buildSessionReport, renderSessionReport, sessionIds } from "../src/report.js";
import { appendLedger, readLedger } from "../src/ledger.js";
import { tempRepo } from "./helpers.js";

describe("per-prompt cost attribution", () => {
  it("attributes cost deltas to the prompt active at each hook firing", () => {
    const repo = tempRepo();
    // Prompt A: two tool calls taking the session from $0 -> $1 -> $3.
    appendLedger(repo, { ts: "t0", sessionId: "s", promptId: "A", event: "pre", toolName: "Bash", action: "allow", cost: { sessionUsd: 1, dayUsd: 1 } });
    appendLedger(repo, { ts: "t1", sessionId: "s", promptId: "A", event: "pre", toolName: "Write", action: "allow", cost: { sessionUsd: 3, dayUsd: 3 } });
    // Prompt B: one denied call, session reaches $4.
    appendLedger(repo, { ts: "t2", sessionId: "s", promptId: "B", event: "pre", toolName: "Bash", action: "deny", guard: "blocked-commands", cost: { sessionUsd: 4, dayUsd: 4 } });

    const r = buildSessionReport(readLedger(repo), "s");
    expect(r.totalUsd).toBeCloseTo(4, 6);
    const a = r.prompts.find((p) => p.promptId === "A")!;
    const b = r.prompts.find((p) => p.promptId === "B")!;
    expect(a.usd).toBeCloseTo(3, 6);
    expect(b.usd).toBeCloseTo(1, 6);
    expect(a.toolCalls).toBe(2);
    expect(b.denials).toBe(1);
  });

  it("ignores other sessions and never attributes negative deltas", () => {
    const repo = tempRepo();
    appendLedger(repo, { ts: "t0", sessionId: "s1", promptId: "A", event: "pre", action: "allow", cost: { sessionUsd: 2, dayUsd: 2 } });
    appendLedger(repo, { ts: "t1", sessionId: "s2", promptId: "Z", event: "pre", action: "allow", cost: { sessionUsd: 9, dayUsd: 11 } });
    // A transcript re-read jitter (should clamp to 0, not go negative).
    appendLedger(repo, { ts: "t2", sessionId: "s1", promptId: "A", event: "pre", action: "allow", cost: { sessionUsd: 1.5, dayUsd: 11 } });
    const r = buildSessionReport(readLedger(repo), "s1");
    expect(r.prompts[0]!.usd).toBeCloseTo(2, 6);
  });
});

describe("report content", () => {
  it("tallies evidence, denials, and stop verdicts", () => {
    const repo = tempRepo();
    appendLedger(repo, { ts: "t0", sessionId: "s", event: "post", toolName: "Bash", evidence: [{ type: "test_failed", detail: "pnpm test (exit 1)" }], cost: { sessionUsd: 1, dayUsd: 1 } });
    appendLedger(repo, { ts: "t1", sessionId: "s", event: "pre", toolName: "Write", action: "deny", guard: "protected-paths", rule: ".env", cost: { sessionUsd: 1, dayUsd: 1 } });
    appendLedger(repo, {
      ts: "t2", sessionId: "s", event: "stop", action: "deny", guard: "verify",
      meta: { verdicts: [{ ruleId: "tests-pass", status: "contradicted", claimExcerpt: "tests pass" }] },
    });

    const r = buildSessionReport(readLedger(repo), "s");
    expect(r.evidence.test_failed).toBe(1);
    expect(r.denials).toHaveLength(1);
    expect(r.stopsBlocked).toBe(1);
    expect(r.stopVerdicts[0]!.status).toBe("contradicted");

    const text = renderSessionReport(r);
    expect(text).toContain("Denied: 1");
    expect(text).toContain("test_failed×1");
    expect(text).toContain("contradicted");
  });

  it("sessionIds preserves first-seen order", () => {
    const repo = tempRepo();
    appendLedger(repo, { ts: "t0", sessionId: "b", event: "pre", action: "allow" });
    appendLedger(repo, { ts: "t1", sessionId: "a", event: "pre", action: "allow" });
    appendLedger(repo, { ts: "t2", sessionId: "b", event: "pre", action: "allow" });
    expect(sessionIds(readLedger(repo))).toEqual(["b", "a"]);
  });
});
