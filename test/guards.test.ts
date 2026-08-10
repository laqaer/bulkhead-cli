import { describe, it, expect } from "vitest";
import { defaultPolicy } from "../src/policy.js";
import { protectedPathsGuard } from "../src/guards/protected-paths.js";
import { blockedCommandsGuard } from "../src/guards/blocked-commands.js";
import { budgetGuard } from "../src/guards/budget.js";
import { loopCheck, emptyLoopState, signatureFor } from "../src/guards/loop.js";
import type { ToolCall } from "../src/types.js";

const ROOT = "/repo";
const policy = defaultPolicy(ROOT);

function write(path: string): ToolCall {
  return { toolName: "Write", toolInput: { file_path: path, content: "x" } };
}
function bash(command: string): ToolCall {
  return { toolName: "Bash", toolInput: { command } };
}

describe("protected-paths guard", () => {
  it("denies writing to a protected dir", () => {
    expect(protectedPathsGuard(write("/repo/prod/config.yaml"), policy).action).toBe("deny");
  });
  it("denies writing to .env", () => {
    expect(protectedPathsGuard(write("/repo/.env"), policy).action).toBe("deny");
  });
  it("denies writing to .env.production via glob", () => {
    expect(protectedPathsGuard(write("/repo/.env.production"), policy).action).toBe("deny");
  });
  it("denies writing to migrations", () => {
    expect(protectedPathsGuard(write("/repo/migrations/001_init.sql"), policy).action).toBe("deny");
  });
  it("denies the agent writing to its own evidence ledger", () => {
    expect(protectedPathsGuard(write("/repo/.bulkhead/ledger.jsonl"), policy).action).toBe("deny");
  });
  it("allows writing to an ordinary source file", () => {
    expect(protectedPathsGuard(write("/repo/src/index.ts"), policy).action).toBe("allow");
  });
  it("honors allow exceptions", () => {
    const p = defaultPolicy(ROOT);
    p.protectedPaths.allow = ["prod/README.md"];
    expect(protectedPathsGuard(write("/repo/prod/README.md"), p).action).toBe("allow");
    expect(protectedPathsGuard(write("/repo/prod/secrets.yaml"), p).action).toBe("deny");
  });
  it("denies rm of a protected path via Bash", () => {
    expect(protectedPathsGuard(bash("rm -rf prod"), policy).action).toBe("deny");
  });
  it("relative-path write resolves against the root", () => {
    // Write tools give absolute paths; simulate a relative one resolved to root.
    expect(protectedPathsGuard(write("prod/x"), policy).action).toBe("deny");
  });
});

describe("blocked-commands guard", () => {
  it("denies force-push to main (flag-first)", () => {
    expect(blockedCommandsGuard(bash("git push --force origin main"), policy).action).toBe("deny");
  });
  it("denies force-push to main with TRAILING flag (order-independent)", () => {
    // Regression: the old positional regex missed this common ordering.
    expect(blockedCommandsGuard(bash("git push origin main --force"), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash("git push origin main -f"), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash("git push origin master --force"), policy).action).toBe("deny");
  });
  it("denies unconditional force-push (bare, and remote-only)", () => {
    expect(blockedCommandsGuard(bash("git push --force"), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash("git push origin --force"), policy).action).toBe("deny");
  });
  it("denies HEAD:main force-push", () => {
    expect(blockedCommandsGuard(bash("git push --force origin HEAD:main"), policy).action).toBe("deny");
  });
  it("allows --force-with-lease, even to main (the safe variant)", () => {
    expect(blockedCommandsGuard(bash("git push --force-with-lease origin feature"), policy).action).toBe("allow");
    expect(blockedCommandsGuard(bash("git push --force-with-lease origin main"), policy).action).toBe("allow");
  });
  it("allows force-push to a feature branch whose name contains 'main'/'master'", () => {
    // Regression: the old `\b(main|master)\b` word-match false-positived here.
    expect(blockedCommandsGuard(bash("git push -f origin feature/main-nav"), policy).action).toBe("allow");
    expect(blockedCommandsGuard(bash("git push --force origin release-main"), policy).action).toBe("allow");
    expect(blockedCommandsGuard(bash("git push origin hotfix/master-fix --force"), policy).action).toBe("allow");
  });
  it("allows an ordinary force-push to an explicit feature branch", () => {
    expect(blockedCommandsGuard(bash("git push --force origin develop"), policy).action).toBe("allow");
  });
  it("denies DROP TABLE", () => {
    expect(blockedCommandsGuard(bash('psql -c "DROP TABLE users"'), policy).action).toBe("deny");
  });
  it("denies rm targeting a filesystem root", () => {
    expect(blockedCommandsGuard(bash("rm -rf /"), policy).action).toBe("deny");
  });
  it("denies rm escaping the workspace via ..", () => {
    expect(blockedCommandsGuard(bash("rm -rf ../../etc"), policy).action).toBe("deny");
  });
  it("allows rm inside the workspace", () => {
    expect(blockedCommandsGuard(bash("rm -rf build/"), policy).action).toBe("allow");
  });
  it("allows an ordinary command", () => {
    expect(blockedCommandsGuard(bash("npm test"), policy).action).toBe("allow");
  });
  it("abstains on non-Bash tools", () => {
    expect(blockedCommandsGuard(write("/repo/src/x.ts"), policy).action).toBe("allow");
  });
  it("survives a malformed user regex without throwing", () => {
    const p = defaultPolicy(ROOT);
    p.blockedCommands = [{ pattern: "(" }];
    expect(() => blockedCommandsGuard(bash("echo hi"), p)).not.toThrow();
    expect(blockedCommandsGuard(bash("echo hi"), p).action).toBe("allow");
  });
});

describe("budget guard", () => {
  const base = { byModel: {}, unpricedModels: [] };
  it("denies when session cap is reached", () => {
    const v = budgetGuard({ ...base, sessionUsd: 5.01, dayUsd: 5.01 }, policy);
    expect(v.action).toBe("deny");
    expect(v.rule).toContain("session");
  });
  it("denies when daily cap is reached", () => {
    const v = budgetGuard({ ...base, sessionUsd: 1, dayUsd: 20 }, policy);
    expect(v.action).toBe("deny");
    expect(v.rule).toContain("daily");
  });
  it("allows under both caps", () => {
    expect(budgetGuard({ ...base, sessionUsd: 1, dayUsd: 2 }, policy).action).toBe("allow");
  });
  it("disables a cap set to 0", () => {
    const p = defaultPolicy(ROOT);
    p.budget.sessionUsd = 0;
    expect(budgetGuard({ ...base, sessionUsd: 1000, dayUsd: 1 }, p).action).toBe("allow");
  });
});

describe("loop guard", () => {
  const cfg = { maxRepeats: 3, windowSeconds: 300 };
  const call: ToolCall = { toolName: "Bash", toolInput: { command: "npm test" } };

  it("freezes after maxRepeats identical calls in the window", () => {
    let state = emptyLoopState();
    const sig = signatureFor(call);
    let last;
    for (let i = 0; i < 3; i++) {
      const r = loopCheck(state, sig, 1000 + i * 10, cfg);
      state = r.state;
      last = r.verdict;
    }
    expect(last!.action).toBe("deny");
  });

  it("does not freeze when arguments differ", () => {
    let state = emptyLoopState();
    let last;
    for (let i = 0; i < 5; i++) {
      const c: ToolCall = { toolName: "Bash", toolInput: { command: `echo ${i}` } };
      const r = loopCheck(state, signatureFor(c), 1000 + i * 10, cfg);
      state = r.state;
      last = r.verdict;
    }
    expect(last!.action).toBe("allow");
  });

  it("forgets calls outside the window", () => {
    let state = emptyLoopState();
    const sig = signatureFor(call);
    // Two hits far apart, then two close — should not reach 3 within window.
    state = loopCheck(state, sig, 0, cfg).state;
    state = loopCheck(state, sig, 1_000_000, cfg).state; // >300s later; prunes the first
    const r = loopCheck(state, sig, 1_000_000 + 5000, cfg);
    expect(r.verdict.action).toBe("allow");
  });

  it("produces identical signatures regardless of key order", () => {
    const a: ToolCall = { toolName: "Edit", toolInput: { file_path: "x", old_string: "a", new_string: "b" } };
    const b: ToolCall = { toolName: "Edit", toolInput: { new_string: "b", file_path: "x", old_string: "a" } };
    expect(signatureFor(a)).toBe(signatureFor(b));
  });
});
