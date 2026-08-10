import { describe, it, expect } from "vitest";
import { assessStop, sessionEvidence } from "../src/verify.js";
import { defaultPolicy } from "../src/policy.js";
import type { Evidence, LedgerEntry } from "../src/types.js";

const config = defaultPolicy("/repo").verify;

const testPassed: Evidence = { type: "test_passed", detail: "pnpm test (exit 0)" };
const testFailed: Evidence = { type: "test_failed", detail: "pnpm test (exit 1)" };
const prCreated: Evidence = { type: "pr_created", detail: "https://github.com/x/y/pull/1" };

describe("assessStop — the Replit case", () => {
  it("blocks when the agent claims tests pass but the latest run FAILED", () => {
    const a = assessStop("All done — the tests pass now!", [testFailed], config);
    expect(a.verdicts[0]!.status).toBe("contradicted");
    expect(a.shouldBlock).toBe(true);
    expect(a.blockReason).toContain("evidence ledger disagrees");
  });

  it("supports the claim when a failing run was followed by a passing re-run", () => {
    const a = assessStop("tests pass", [testFailed, testPassed], config);
    expect(a.verdicts[0]!.status).toBe("supported");
    expect(a.shouldBlock).toBe(false);
  });

  it("contradicts when a pass was followed by a NEW failure", () => {
    const a = assessStop("tests are passing", [testPassed, testFailed], config);
    expect(a.verdicts[0]!.status).toBe("contradicted");
    expect(a.shouldBlock).toBe(true);
  });

  it("notes (but does not block) a claim with no evidence at all", () => {
    const a = assessStop("the tests pass", [], config);
    expect(a.verdicts[0]!.status).toBe("unsupported");
    expect(a.shouldBlock).toBe(false);
  });

  it("blockOnMissing escalates unsupported claims to a block", () => {
    const strict = { ...config, blockOnMissing: true };
    const a = assessStop("tests pass", [], strict);
    expect(a.shouldBlock).toBe(true);
  });

  it("no checkable claim -> no verdicts, no block", () => {
    const a = assessStop("I refactored the parser and updated the docs.", [testFailed], config);
    expect(a.verdicts).toEqual([]);
    expect(a.shouldBlock).toBe(false);
  });

  it("PR claim is supported by pr_created evidence", () => {
    const a = assessStop("I opened a pull request with the fix.", [prCreated], config);
    expect(a.verdicts[0]).toMatchObject({ ruleId: "pr-created", status: "supported" });
  });

  it("PR claim without evidence is noted, not blocked (default)", () => {
    const a = assessStop("Created a PR for review.", [], config);
    expect(a.verdicts[0]!.status).toBe("unsupported");
    expect(a.shouldBlock).toBe(false);
  });

  it("mode=note never blocks even on contradiction", () => {
    const note = { ...config, mode: "note" as const };
    const a = assessStop("tests pass", [testFailed], note);
    expect(a.verdicts[0]!.status).toBe("contradicted");
    expect(a.shouldBlock).toBe(false);
  });

  it("mode=off returns nothing", () => {
    const off = { ...config, mode: "off" as const };
    expect(assessStop("tests pass", [testFailed], off).verdicts).toEqual([]);
  });

  it("a malformed custom claim regex is skipped, not thrown", () => {
    const broken = { ...config, rules: [...config.rules, { id: "bad", claim: "(", evidence: [] }] };
    expect(() => assessStop("tests pass", [testPassed], broken)).not.toThrow();
  });
});

describe("assertion guard — hedged/negated statements are NOT claims", () => {
  // Every one of these is an HONEST final message written after a failed run.
  // Blocking them punishes truthful reporting — the exact opposite of the
  // product's job. All must produce no verdict and no block.
  const honest = [
    "Two failures remain. Once the tests pass, this can be merged.",
    "I could not make the tests pass — the fixture is missing.",
    "Next step is to make the tests pass.",
    "Do the tests pass now?",
    "None of the tests pass yet.",
    "Not all tests pass — 3 still fail.",
    "10 tests passed, 2 failed — I could not fix the last 2.",
    "This will make the tests pass.",
    "We should wait until the tests pass.",
  ];
  for (const message of honest) {
    it(`does not block: "${message.slice(0, 50)}..."`, () => {
      const a = assessStop(message, [testFailed], config);
      expect(a.shouldBlock).toBe(false);
      expect(a.verdicts.filter((v) => v.status === "contradicted")).toEqual([]);
    });
  }

  it("still blocks the assertive Replit-case claim", () => {
    const a = assessStop("Done! I fixed the bug and all tests pass.", [testFailed], config);
    expect(a.verdicts[0]!.status).toBe("contradicted");
    expect(a.shouldBlock).toBe(true);
  });

  it("negated PR/commit statements never block, even under blockOnMissing", () => {
    const strict = { ...config, blockOnMissing: true };
    expect(assessStop("I haven't opened a pull request yet — let me know if you want one.", [], strict).shouldBlock).toBe(false);
    expect(assessStop("Nothing has been committed yet; review the diff first.", [], strict).shouldBlock).toBe(false);
  });

  it("'committed to this approach' is not a git commit claim", () => {
    const strict = { ...config, blockOnMissing: true };
    const a = assessStop("I'm committed to this approach.", [], strict);
    expect(a.verdicts).toEqual([]);
    expect(a.shouldBlock).toBe(false);
  });
});

describe("sessionEvidence", () => {
  it("collects evidence only from the requested session, in order", () => {
    const entries = [
      mk(0, "s1", [testFailed]),
      mk(1, "s2", [prCreated]),
      mk(2, "s1", [testPassed]),
    ];
    const ev = sessionEvidence(entries, "s1");
    expect(ev).toEqual([testFailed, testPassed]);
  });
});

function mk(seq: number, sessionId: string, evidence: Evidence[]): LedgerEntry {
  return {
    seq,
    ts: `t${seq}`,
    sessionId,
    event: "post",
    evidence,
    prevHash: "x",
    hash: "y",
  };
}
