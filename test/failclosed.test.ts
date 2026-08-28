import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handlePostToolUse, handlePreToolUse, handleStop } from "../src/hook.js";
import {
  StateDirUnavailableError,
  guardStateDir,
  isStateDirError,
} from "../src/state-dir.js";
import { tempRepo } from "./helpers.js";
import { runInit } from "../src/init.js";

// F2: any error inside the pre-hook failed OPEN — silently allowing the call.
// When the failing thing is Bulkhead's own state directory, named availability
// failures are not ordinary guard bugs: they remove the enforcement substrate.
// The guarded agent can cause them by removing access or exhausting capacity.
// Those failures must fail CLOSED with a human-actionable reason. Everything
// outside the enumerated policy keeps today's fail-open behaviour.
//
// F2b: the Stop hook is a gate too. It verifies the agent's completion claims
// against ledger evidence, and its own state-dir appends used to escape to
// cli.ts's fail-open catch — `chmod 000 .bulkhead` let a false "all tests
// pass" through with empty stdout. The Stop hook fails closed the same way,
// using its own blocking shape ({decision:"block"}) rather than PreToolUse's
// permissionDecision deny.

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const skipOnRoot = process.getuid?.() === 0; // chmod 000 does not bind root

type PreResult = ReturnType<typeof handlePreToolUse>;
function denyDecision(result: PreResult): string | undefined {
  const out = result.output as { hookSpecificOutput?: { permissionDecision?: string } };
  return out?.hookSpecificOutput?.permissionDecision;
}

function denialReason(result: PreResult): string {
  const out = result.output as { hookSpecificOutput?: { permissionDecisionReason?: string } };
  return out?.hookSpecificOutput?.permissionDecisionReason ?? "";
}

function initRepo(): string {
  const repo = tempRepo();
  runInit(repo, {});
  return repo;
}

function protectedWriteCall(repo: string): Parameters<typeof handlePreToolUse>[0] {
  return {
    cwd: repo,
    session_id: "s1",
    tool_name: "Write",
    tool_input: { file_path: join(repo, ".env"), content: "S=1" },
  };
}

describe("state-dir error classification (F2 internals)", () => {
  it("wraps EACCES from state IO in a typed, recognisable error", () => {
    const boom = Object.assign(new Error(" Permission denied"), { code: "EACCES" });
    let caught: unknown;
    try {
      guardStateDir("/some/repo/.bulkhead", () => {
        throw boom;
      });
    } catch (e) {
      caught = e;
    }
    expect(isStateDirError(caught)).toBe(true);
    expect((caught as StateDirUnavailableError).path).toBe("/some/repo/.bulkhead");
    expect((caught as StateDirUnavailableError).fsCode).toBe("EACCES");
  });

  it("wraps EPERM the same way", () => {
    const boom = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    expect(() =>
      guardStateDir("/repo/.bulkhead", () => {
        throw boom;
      }),
    ).toThrow(StateDirUnavailableError);
  });

  // Each fail-closed errno gets its own assertion so the policy is enumerated,
  // not implied. These all make the enforcement substrate unavailable until a
  // human restores access or capacity.
  it.each(["EACCES", "EPERM", "EROFS", "ENOSPC"])(
    "wraps %s into StateDirUnavailableError",
    (code) => {
      const boom = Object.assign(new Error(`boom ${code}`), { code });
      let caught: unknown;
      try {
        guardStateDir("/repo/.bulkhead", () => {
          throw boom;
        });
      } catch (e) {
        caught = e;
      }
      expect(isStateDirError(caught)).toBe(true);
      expect((caught as StateDirUnavailableError).fsCode).toBe(code);
    },
  );

  it("gives ENOSPC a capacity-specific remedy", () => {
    const boom = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    let caught: unknown;
    try {
      guardStateDir("/repo/.bulkhead", () => {
        throw boom;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StateDirUnavailableError);
    expect((caught as StateDirUnavailableError).fsCode).toBe("ENOSPC");
    expect((caught as Error).message).toContain("Free blocks or inodes");
    expect((caught as Error).message).not.toContain("chmod");
  });

  it("keeps errnos outside the named policy failing open", () => {
    for (const code of ["EIO", "EMFILE", "ENOENT"]) {
      const boom = Object.assign(new Error(`boom ${code}`), { code });
      let caught: unknown;
      try {
        guardStateDir("/repo/.bulkhead", () => {
          throw boom;
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBe(boom); // cli.ts keeps its historical fail-open
    }
  });

  it("passes errors outside the named policy through untouched", () => {
    const boom = Object.assign(new Error("no such file"), { code: "ENOENT" });
    let caught: unknown;
    try {
      guardStateDir("/repo/.bulkhead", () => {
        throw boom;
      });
    } catch (e) {
      caught = e;
    }
    expect(isStateDirError(caught)).toBe(false); // cli.ts will fail open
    expect(caught).toBe(boom);
  });

  it("returns the op's value untouched when nothing throws", () => {
    expect(guardStateDir("/repo/.bulkhead", () => 42)).toBe(42);
  });
});

describe("state-dir fail-closed (F2, in-process hook)", () => {
  it("positive control: protected write denies while enforcement is intact", () => {
    if (skipOnRoot) return;
    const repo = initRepo();
    try {
      expect(denyDecision(handlePreToolUse(protectedWriteCall(repo)))).toBe("deny");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("denies a protected write when .bulkhead/ is unwritable (was silent ALLOW)", () => {
    if (skipOnRoot) return;
    const repo = initRepo();
    try {
      chmodSync(join(repo, ".bulkhead"), 0o000);
      // Pre-fix this threw raw EACCES out of handlePreToolUse and cli.ts
      // failed open. Post-fix the handler returns a deny verdict itself.
      expect(denyDecision(handlePreToolUse(protectedWriteCall(repo)))).toBe("deny");
    } finally {
      chmodSync(join(repo, ".bulkhead"), 0o755);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("state-dir denial points at restoring access, NOT at editing bulkhead.yaml", () => {
    if (skipOnRoot) return;
    const repo = initRepo();
    try {
      chmodSync(join(repo, ".bulkhead"), 0o000);
      const result = handlePreToolUse(protectedWriteCall(repo));
      expect(denyDecision(result)).toBe("deny");
      const reason = denialReason(result);
      // The generic footer ("a human must change bulkhead.yaml or perform this
      // action manually") is wrong for this guard: no policy edit restores an
      // unwritable .bulkhead/, so the footer would send the human to a remedy
      // that cannot work. The Why line already names the real fix; the refusal
      // must direct the human at restoring filesystem access instead. Every
      // OTHER guard keeps the generic footer — policy edits ARE their remedy.
      expect(reason).not.toContain("change bulkhead.yaml");
      expect(reason).toContain("restore access");
      expect(reason).toContain(".bulkhead");
    } finally {
      chmodSync(join(repo, ".bulkhead"), 0o755);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("enforcement returns after .bulkhead/ becomes writable again", () => {
    if (skipOnRoot) return;
    const repo = initRepo();
    const call = () => denyDecision(handlePreToolUse(protectedWriteCall(repo)));
    try {
      chmodSync(join(repo, ".bulkhead"), 0o000);
      expect(call()).toBe("deny");
      chmodSync(join(repo, ".bulkhead"), 0o755);
      expect(call()).toBe("deny");
    } finally {
      chmodSync(join(repo, ".bulkhead"), 0o755);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("state-dir fail-closed (F2, real CLI process)", () => {
  it("hook protocol denies, ledger stays dark during outage, resumes after", () => {
    if (skipOnRoot) return;
    const repo = initRepo();
    const ledgerPath = join(repo, ".bulkhead", "ledger.jsonl");
    const ledgerLines = () =>
      existsSync(ledgerPath)
        ? readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.trim()).length
        : 0;

    const call = () =>
      spawnSync(
        "node",
        [CLI, "hook", "pre"],
        {
          input: JSON.stringify(protectedWriteCall(repo)),
          cwd: repo,
          encoding: "utf8",
        },
      );

    try {
      // Enforcement intact: deny + ledger entry.
      const before = call();
      expect(JSON.parse(before.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
      const linesBefore = ledgerLines();
      expect(linesBefore).toBeGreaterThan(0);

      // State dir dark: still deny over the hook protocol. (We cannot read
      // the ledger THROUGH a mode-000 parent, so restore first, then prove
      // nothing was appended during the outage.)
      chmodSync(join(repo, ".bulkhead"), 0o000);
      const during = call();
      expect(JSON.parse(during.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
      chmodSync(join(repo, ".bulkhead"), 0o755);
      expect(ledgerLines()).toBe(linesBefore);

      // Restored: enforcement AND the audit trail both come back.
      const after = call();
      expect(JSON.parse(after.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
      expect(ledgerLines()).toBeGreaterThan(linesBefore);
    } finally {
      chmodSync(join(repo, ".bulkhead"), 0o755);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// --- F2b: the Stop hook is a gate too -------------------------------------

type StopResult = ReturnType<typeof handleStop>;
function stopBlockReason(result: StopResult): string | undefined {
  const out = result.output as { decision?: string; reason?: string };
  return out?.decision === "block" ? out.reason : undefined;
}

/** Record failing-test evidence the way PostToolUse would. */
function recordFailingTests(repo: string): void {
  const res = handlePostToolUse({
    cwd: repo,
    session_id: "s-f2b",
    tool_name: "Bash",
    tool_input: { command: "pnpm test" },
    tool_response: { stdout: "Tests  2 failed | 10 passed", exit_code: 1 },
  });
  expect(res.exitCode).toBe(0);
}

function falseStopClaim(repo: string, extra: Record<string, unknown> = {}): Parameters<typeof handleStop>[0] {
  return {
    cwd: repo,
    session_id: "s-f2b",
    last_assistant_message: "Done! I fixed the bug and all tests pass.",
    ...extra,
  };
}

describe("state-dir fail-closed on Stop (F2b, in-process hook)", () => {
  it("positive control: a false completion claim blocks while .bulkhead/ is writable", () => {
    if (skipOnRoot) return;
    const repo = initRepo();
    try {
      recordFailingTests(repo);
      expect(stopBlockReason(handleStop(falseStopClaim(repo)))).toContain(
        "evidence ledger disagrees",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("blocks a false claim while .bulkhead/ is unwritable (was silent ALLOW)", () => {
    if (skipOnRoot) return;
    const repo = initRepo();
    try {
      recordFailingTests(repo);
      chmodSync(join(repo, ".bulkhead"), 0o000);
      // Pre-fix the state-dir append threw EACCES out of handleStop and
      // cli.ts failed open: empty stdout, stop allowed.
      const reason = stopBlockReason(handleStop(falseStopClaim(repo)));
      expect(reason).toContain(".bulkhead");
      expect(reason).toMatch(/chmod|restor/i); // human-actionable
    } finally {
      chmodSync(join(repo, ".bulkhead"), 0o755);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("stop_hook_active does not suppress the state-dir block (retry must not bypass)", () => {
    if (skipOnRoot) return;
    const repo = initRepo();
    try {
      recordFailingTests(repo);
      chmodSync(join(repo, ".bulkhead"), 0o000);
      // If a retried stop (stop_hook_active=true) suppressed this block, the
      // agent escapes by stopping twice — so the loop guard must NOT apply to
      // the state-dir failure itself.
      const reason = stopBlockReason(handleStop(falseStopClaim(repo, { stop_hook_active: true })));
      expect(reason).toContain(".bulkhead");
    } finally {
      chmodSync(join(repo, ".bulkhead"), 0o755);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("the verify guard comes back after restore (real enforcement, not just any block)", () => {
    if (skipOnRoot) return;
    const repo = initRepo();
    try {
      recordFailingTests(repo);
      chmodSync(join(repo, ".bulkhead"), 0o000);
      expect(stopBlockReason(handleStop(falseStopClaim(repo)))).toContain(".bulkhead");
      chmodSync(join(repo, ".bulkhead"), 0o755);
      const reason = stopBlockReason(handleStop(falseStopClaim(repo)));
      expect(reason).toContain("evidence ledger disagrees"); // the real guard again
      expect(reason).toContain("test_failed");
    } finally {
      chmodSync(join(repo, ".bulkhead"), 0o755);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("state-dir fail-closed on Stop (F2b, real CLI process)", () => {
  it("hook protocol blocks while dark; verify guard returns after restore", () => {
    if (skipOnRoot) return;
    const repo = initRepo();
    const post = spawnSync(
      "node",
      [CLI, "hook", "post"],
      {
        input: JSON.stringify({
          session_id: "s-f2b-cli",
          cwd: repo,
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
          tool_response: { stdout: "Tests  2 failed | 10 passed", exit_code: 1 },
        }),
        cwd: repo,
        encoding: "utf8",
      },
    );
    expect(post.status).toBe(0);

    const stopPayload = JSON.stringify({
      session_id: "s-f2b-cli",
      cwd: repo,
      last_assistant_message: "Done! I fixed the bug and all tests pass.",
    });
    const callStop = () =>
      spawnSync("node", [CLI, "hook", "stop"], { input: stopPayload, cwd: repo, encoding: "utf8" });

    try {
      // State dir dark: the stop hook fails CLOSED in its own blocking shape.
      chmodSync(join(repo, ".bulkhead"), 0o000);
      const during = callStop();
      expect(during.status).toBe(0);
      const darkOut = JSON.parse(during.stdout) as { decision?: string; reason?: string };
      expect(darkOut.decision).toBe("block");
      expect(darkOut.reason).toContain(".bulkhead");

      // Restored: the ordinary completion-verification guard is back.
      chmodSync(join(repo, ".bulkhead"), 0o755);
      const after = callStop();
      const liveOut = JSON.parse(after.stdout) as { decision?: string; reason?: string };
      expect(liveOut.decision).toBe("block");
      expect(liveOut.reason).toContain("evidence ledger disagrees");
      expect(liveOut.reason).toContain("test_failed");
    } finally {
      chmodSync(join(repo, ".bulkhead"), 0o755);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
