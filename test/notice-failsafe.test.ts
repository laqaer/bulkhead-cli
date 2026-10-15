import { describe, it, expect, vi } from "vitest";

/**
 * The human notice is a courtesy on top of a decision that is already made
 * and recorded. If building it ever throws, the decision must survive: an
 * exception escaping the hook reaches cli.ts's fail-open handler, which would
 * turn a deny into an allow. Here the notice builders are forced to throw.
 */
vi.mock("../src/describe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/describe.js")>();
  const boom = () => {
    throw new Error("notice builder exploded");
  };
  return { ...actual, preToolUseNotice: boom, stopNotice: boom };
});

const { handlePreToolUse, handlePostToolUse, handleStop } = await import("../src/hook.js");
const { runInit } = await import("../src/init.js");
const { tempRepo } = await import("./helpers.js");

describe("a failing notice never costs the decision", () => {
  it("PreToolUse still denies, with a fixed fallback line", () => {
    const repo = tempRepo();
    runInit(repo, { hookCommand: "bulkhead hook" });
    const res = handlePreToolUse({
      session_id: "s",
      cwd: repo,
      tool_name: "Bash",
      tool_input: { command: "git push --force origin main" },
    });
    const out = res.output as { hookSpecificOutput?: { permissionDecision?: string }; systemMessage?: string };
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.systemMessage).toBe("🛡 Bulkhead blocked this action (ledger #0)");
  });

  it("Stop still blocks a contradicted claim, with a fixed fallback line", () => {
    const repo = tempRepo();
    runInit(repo, { hookCommand: "bulkhead hook" });
    handlePostToolUse({
      session_id: "s",
      cwd: repo,
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: { stdout: "1 failed", exit_code: 1 },
    });
    const res = handleStop({ session_id: "s", cwd: repo, last_assistant_message: "All tests pass." });
    const out = res.output as { decision?: string; systemMessage?: string };
    expect(out.decision).toBe("block");
    expect(out.systemMessage).toBe("🛡 Bulkhead: completion check failed — sent back to work (ledger #1)");
  });
});
