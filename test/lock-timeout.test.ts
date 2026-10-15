import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileLockTimeoutError, withFileLock } from "../src/fs-lock.js";
import {
  StateDirUnavailableError,
  guardStateDir,
} from "../src/state-dir.js";
import { bulkheadDir } from "../src/paths.js";
import { tempRepo } from "./helpers.js";
import { handlePreToolUse, handleStop } from "../src/hook.js";

describe("state lock timeout", () => {
  it("is classified as an explicit fail-closed state-substrate failure", () => {
    const repo = tempRepo();
    const dir = bulkheadDir(repo);
    const lock = join(dir, "ledger.jsonl.lock");
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, "held by another hook");

    let caught: unknown;
    try {
      guardStateDir(dir, () =>
        withFileLock(
          lock,
          () => {
            throw new Error("critical section must not run");
          },
          { timeoutMs: 25, staleMs: 60_000 },
        ),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StateDirUnavailableError);
    expect((caught as StateDirUnavailableError).fsCode).toBe("ELOCKTIMEOUT");
    expect((caught as Error).message).toContain("competing Bulkhead hook");
    expect((caught as Error).cause).toBeInstanceOf(FileLockTimeoutError);
  });
});

describe("fail-closed notices for the human", () => {
  // A fresh lock file held by "another hook" makes the ledger append time out
  // (ELOCKTIMEOUT), a real state-dir failure that works even as root.
  function holdLedgerLock(repo: string): void {
    const dir = bulkheadDir(repo);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ledger.jsonl.lock"), "held by another hook");
  }

  it("a PreToolUse state-dir deny tells the human, without a ledger number", () => {
    const repo = tempRepo();
    holdLedgerLock(repo);
    const res = handlePreToolUse({
      session_id: "s",
      cwd: repo,
      tool_name: "Bash",
      tool_input: { command: "git push --force origin main" },
    });
    const out = res.output as { hookSpecificOutput?: { permissionDecision?: string }; systemMessage?: string };
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.systemMessage).toBe(
      "🛡 Bulkhead blocked: git push --force origin main — Bulkhead state storage unavailable (ELOCKTIMEOUT); a human must restore .bulkhead/ before the agent continues",
    );
  });

  it("a Stop state-dir block tells the human the session cannot finish", () => {
    const repo = tempRepo();
    holdLedgerLock(repo);
    const res = handleStop({ session_id: "s", cwd: repo, last_assistant_message: "Done." });
    const out = res.output as { decision?: string; systemMessage?: string };
    expect(out.decision).toBe("block");
    expect(out.systemMessage).toBe(
      "🛡 Bulkhead: state storage .bulkhead/ unavailable (ELOCKTIMEOUT) — the session cannot finish until a human restores it",
    );
  });
});
