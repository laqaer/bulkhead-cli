import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tempRepo, writeTranscript } from "./helpers.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

/** Run the built CLI as Claude Code would, with a hook payload on stdin. */
function runHook(kind: "pre" | "post", payload: unknown, cwd: string) {
  const res = spawnSync("node", [CLI, "hook", kind], {
    input: JSON.stringify(payload),
    cwd,
    encoding: "utf8",
  });
  return res;
}

function run(args: string[], cwd: string) {
  return spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
}

describe("CLI integration (real process, real hook protocol)", () => {
  it("blocks a protected-path write and records it in the ledger", () => {
    const repo = tempRepo();
    run(["init", "--command", `node ${CLI} hook`], repo);

    const res = runHook(
      "pre",
      {
        session_id: "s1",
        cwd: repo,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(repo, ".env"), content: "SECRET=1" },
      },
      repo,
    );

    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("Bulkhead blocked");

    // Ledger recorded the denial.
    const ledger = readFileSync(join(repo, ".bulkhead", "ledger.jsonl"), "utf8");
    expect(ledger).toContain('"action":"deny"');
    expect(ledger).toContain("protected-paths");

    const verify = run(["ledger", "verify"], repo);
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain("verified");
  });

  it("blocks rm -rf / and stays silent (allow) on an ordinary command", () => {
    const repo = tempRepo();
    run(["init", "--command", `node ${CLI} hook`], repo);

    const denied = runHook(
      "pre",
      { session_id: "s", cwd: repo, tool_name: "Bash", tool_input: { command: "rm -rf /" } },
      repo,
    );
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");

    const allowed = runHook(
      "pre",
      { session_id: "s", cwd: repo, tool_name: "Bash", tool_input: { command: "npm test" } },
      repo,
    );
    // On allow we emit no permission decision — the host proceeds normally.
    expect(allowed.status).toBe(0);
    const parsed = allowed.stdout.trim() ? JSON.parse(allowed.stdout) : {};
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });

  it("pauses (denies) once the session budget cap is exceeded", () => {
    const repo = tempRepo();
    run(["init", "--command", `node ${CLI} hook`], repo);
    // Default session cap is $5. A transcript with ~$25 of Opus output blows it.
    const transcript = join(repo, "transcript.jsonl");
    writeTranscript(transcript, [
      { id: "m1", model: "claude-opus-4-8", usage: { output_tokens: 1_000_000 } }, // $25
    ]);

    const res = runHook(
      "pre",
      {
        session_id: "s-budget",
        cwd: repo,
        transcript_path: transcript,
        tool_name: "Read", // even a harmless tool is paused
        tool_input: { file_path: join(repo, "README.md") },
      },
      repo,
    );
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("cap");
  });

  it("freezes an identical tool call after repeated attempts (loop kill-switch)", () => {
    const repo = tempRepo();
    // Tight loop cap for a fast test.
    writeFileSync(
      join(repo, "bulkhead.yaml"),
      "version: 1\nloop:\n  max_repeats: 3\n  window_seconds: 300\nbudget:\n  session_usd: 0\n  daily_usd: 0\n",
    );
    run(["init", "--command", `node ${CLI} hook`], repo);

    const payload = {
      session_id: "s-loop",
      cwd: repo,
      tool_name: "Bash",
      tool_input: { command: "echo same" },
    };
    let last;
    for (let i = 0; i < 3; i++) last = runHook("pre", payload, repo);
    const out = JSON.parse(last!.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("loop");
  });

  it("fails open (exit 0, no decision) on malformed hook input", () => {
    const repo = tempRepo();
    run(["init", "--command", `node ${CLI} hook`], repo);
    const res = spawnSync("node", [CLI, "hook", "pre"], {
      input: "not json{{{",
      cwd: repo,
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
  });

  it("init is idempotent and writes runnable settings", () => {
    const repo = tempRepo();
    const first = run(["init", "--command", `node ${CLI} hook`], repo);
    expect(first.status).toBe(0);
    expect(existsSync(join(repo, "bulkhead.yaml"))).toBe(true);
    run(["init", "--command", `node ${CLI} hook`], repo);
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });
});
