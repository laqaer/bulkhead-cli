import { describe, it, expect } from "vitest";
import { combineVerdicts, evaluate } from "../src/engine.js";
import { defaultPolicy } from "../src/policy.js";
import type { GuardVerdict, ToolCall, CostBreakdown, RiskAssessment } from "../src/types.js";

const noRisk: RiskAssessment = { level: undefined, score: 0, signals: [] };

const allow: GuardVerdict = { action: "allow", guard: "g" };
const deny: GuardVerdict = { action: "deny", guard: "d", reason: "no" };
const ask: GuardVerdict = { action: "ask", guard: "a", reason: "maybe" };

describe("combineVerdicts precedence", () => {
  it("deny beats everything", () => {
    expect(combineVerdicts([allow, ask, deny]).action).toBe("deny");
  });
  it("ask beats allow", () => {
    expect(combineVerdicts([allow, ask, allow]).action).toBe("ask");
  });
  it("all allow => allow", () => {
    expect(combineVerdicts([allow, allow]).action).toBe("allow");
  });
  it("surfaces the deciding verdict's reason", () => {
    expect(combineVerdicts([allow, deny]).reason).toBe("no");
  });
});

describe("evaluate end-to-end", () => {
  const policy = defaultPolicy("/repo");
  const zeroCost: CostBreakdown = { sessionUsd: 0, dayUsd: 0, byModel: {}, unpricedModels: [] };
  const allowLoop: GuardVerdict = { action: "allow", guard: "loop" };

  it("denies a protected write", () => {
    const call: ToolCall = { toolName: "Write", toolInput: { file_path: "/repo/.env" } };
    expect(evaluate(call, policy, zeroCost, allowLoop, noRisk).action).toBe("deny");
  });

  it("denies when over budget even for a harmless tool", () => {
    const call: ToolCall = { toolName: "Read", toolInput: { file_path: "/repo/README.md" } };
    const over: CostBreakdown = { sessionUsd: 99, dayUsd: 99, byModel: {}, unpricedModels: [] };
    const d = evaluate(call, policy, over, allowLoop, noRisk);
    expect(d.action).toBe("deny");
    expect(d.deciding?.guard).toBe("budget");
  });

  it("allows an ordinary write under budget", () => {
    const call: ToolCall = { toolName: "Write", toolInput: { file_path: "/repo/src/x.ts" } };
    expect(evaluate(call, policy, zeroCost, allowLoop, noRisk).action).toBe("allow");
  });
});
