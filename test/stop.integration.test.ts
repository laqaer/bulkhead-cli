import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { tempRepo } from "./helpers.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function runHook(kind: "pre" | "post" | "stop", payload: unknown, cwd: string) {
  return spawnSync("node", [CLI, "hook", kind], {
    input: JSON.stringify(payload),
    cwd,
    encoding: "utf8",
  });
}
function run(args: string[], cwd: string) {
  return spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
}

describe("completion verification through the real binary", () => {
  it("records failed-test evidence, then blocks a stop that claims tests pass", () => {
    const repo = tempRepo();
    run(["init", "--command", `node ${CLI} hook`], repo);

    // 1. The agent ran the tests and they FAILED — PostToolUse records it.
    const post = runHook(
      "post",
      {
        session_id: "s-verify",
        cwd: repo,
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
        tool_response: { stdout: "Tests  2 failed | 10 passed", exit_code: 1 },
      },
      repo,
    );
    expect(post.status).toBe(0);
    const ledger = readFileSync(join(repo, ".bulkhead", "ledger.jsonl"), "utf8");
    expect(ledger).toContain("test_failed");

    // 2. The agent tries to finish claiming the tests pass — blocked.
    const stop = runHook(
      "stop",
      {
        session_id: "s-verify",
        cwd: repo,
        last_assistant_message: "Done! I fixed the bug and all tests pass.",
      },
      repo,
    );
    expect(stop.status).toBe(0);
    const out = JSON.parse(stop.stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("evidence ledger disagrees");
    expect(out.reason).toContain("test_failed");
    // Claude reads `reason`; the human sees one line.
    expect(out.systemMessage).toBe(
      '🛡 Bulkhead: agent said "all tests pass" but the latest `pnpm test` exited 1 — sent back to work (ledger #1)',
    );
    expect(Object.keys(out)).toEqual(["decision", "reason", "systemMessage"]);
  });

  it("allows the stop after a passing re-run supports the claim", () => {
    const repo = tempRepo();
    run(["init", "--command", `node ${CLI} hook`], repo);

    runHook("post", {
      session_id: "s", cwd: repo, tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: { stdout: "2 failed", exit_code: 1 },
    }, repo);
    runHook("post", {
      session_id: "s", cwd: repo, tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: { stdout: "12 passed", exit_code: 0 },
    }, repo);

    const stop = runHook("stop", {
      session_id: "s", cwd: repo,
      last_assistant_message: "All tests pass now.",
    }, repo);
    const parsed = stop.stdout.trim() ? JSON.parse(stop.stdout) : {};
    expect(parsed.decision).toBeUndefined();
  });

  it("never blocks twice: stop_hook_active suppresses the block (loop guard)", () => {
    const repo = tempRepo();
    run(["init", "--command", `node ${CLI} hook`], repo);
    runHook("post", {
      session_id: "s", cwd: repo, tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: { stdout: "", exit_code: 1 },
    }, repo);

    const stop = runHook("stop", {
      session_id: "s", cwd: repo,
      stop_hook_active: true,
      last_assistant_message: "tests pass",
    }, repo);
    const parsed = stop.stdout.trim() ? JSON.parse(stop.stdout) : {};
    expect(parsed.decision).toBeUndefined(); // verdict recorded, block suppressed
    expect(parsed.systemMessage).toBeUndefined(); // nothing was blocked, nothing to announce
    const ledger = readFileSync(join(repo, ".bulkhead", "ledger.jsonl"), "utf8");
    expect(ledger).toContain("stop_hook_active");
  });

  it("bulkhead report shows the whole story", () => {
    const repo = tempRepo();
    run(["init", "--command", `node ${CLI} hook`], repo);
    runHook("pre", {
      session_id: "s", prompt_id: "p1", cwd: repo, tool_name: "Bash",
      tool_input: { command: "pnpm test" },
    }, repo);
    runHook("post", {
      session_id: "s", prompt_id: "p1", cwd: repo, tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: { stdout: "3 failed", exit_code: 1 },
    }, repo);
    runHook("stop", {
      session_id: "s", prompt_id: "p1", cwd: repo,
      last_assistant_message: "tests pass",
    }, repo);

    const report = run(["report"], repo);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("test_failed×1");
    expect(report.stdout).toContain("Completion checks");
    expect(report.stdout).toContain("contradicted");
    expect(report.stdout).toContain("stop(s) blocked");
  });

  it("status renders a stop denial as a readable row, not a blank one", () => {
    const repo = tempRepo();
    run(["init", "--command", `node ${CLI} hook`], repo);
    runHook("post", {
      session_id: "s", cwd: repo, tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: { stdout: "1 failed", exit_code: 1 },
    }, repo);
    runHook("stop", { session_id: "s", cwd: repo, last_assistant_message: "All tests pass." }, repo);
    const status = run(["status"], repo);
    expect(status.stdout).toContain('⛔ #1 Stop [verify] contradicted: "All tests pass"');
  });

  it("the stop entry snapshots session cost (turn-final model call not dropped)", () => {
    const repo = tempRepo();
    run(["init", "--command", `node ${CLI} hook`], repo);
    // A transcript whose final model call cost ~$25 (1M output @ opus).
    const transcript = join(repo, "t.jsonl");
    const { writeFileSync } = require("node:fs");
    writeFileSync(
      transcript,
      JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-4-8", usage: { output_tokens: 1_000_000 } } }) + "\n",
    );
    runHook("stop", {
      session_id: "s-cost", cwd: repo, transcript_path: transcript,
      last_assistant_message: "Refactored the parser.",
    }, repo);
    const entries = readFileSync(join(repo, ".bulkhead", "ledger.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    const stop = entries.find((e) => e.event === "stop" && e.sessionId === "s-cost");
    expect(stop.cost.sessionUsd).toBeCloseTo(25, 1);
  });

  it("init refuses to overwrite an unparseable settings.json", () => {
    const repo = tempRepo();
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    const broken = '{ "model": "claude-opus-4-8", }'; // trailing comma
    writeFileSync(join(repo, ".claude", "settings.json"), broken);
    const res = run(["init", "--command", `node ${CLI} hook`], repo);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("not valid JSON");
    expect(readFileSync(join(repo, ".claude", "settings.json"), "utf8")).toBe(broken); // preserved
  });

  it("init registers the Stop hook", () => {
    const repo = tempRepo();
    run(["init", "--command", `node ${CLI} hook`], repo);
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("hook stop");
  });
});

describe("bulkhead receipt through the real binary", () => {
  function session(repo: string) {
    run(["init", "--command", `node ${CLI} hook`], repo);
    runHook("pre", { session_id: "s-old", cwd: repo, tool_name: "Bash", tool_input: { command: "ls" } }, repo);
    runHook("pre", {
      session_id: "s-new", cwd: repo, tool_name: "Bash",
      tool_input: { command: "git push --force origin main" },
    }, repo);
    runHook("pre", {
      session_id: "s-new", cwd: repo, tool_name: "Bash",
      tool_input: { command: "DB_PASSWORD=hunter2hunter2 psql -c 'DROP TABLE users;'" },
    }, repo);
    runHook("post", {
      session_id: "s-new", cwd: repo, tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: { stdout: "Tests  2 failed | 10 passed (12)", exit_code: 1 },
    }, repo);
    runHook("stop", { session_id: "s-new", cwd: repo, last_assistant_message: "All tests pass." }, repo);
  }

  it("defaults to the most recent session, as redacted markdown", () => {
    const repo = tempRepo();
    session(repo);
    const res = run(["receipt"], repo);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("### 🛡 Bulkhead receipt");
    expect(res.stdout).toContain("Session `s-new`");
    expect(res.stdout).toContain("`git push --force origin main` | force-push to a protected branch");
    expect(res.stdout).toContain("⛔ **Claim ≠ evidence**");
    expect(res.stdout).toContain("`pnpm test` exited 1 · Tests 2 failed \\| 10 passed (12)");
    expect(res.stdout).toContain("Verify: `npx @bulkheadtools/cli ledger verify`");
    expect(res.stdout).not.toContain("hunter2hunter2");
    expect(res.stdout).not.toContain(repo);
  });

  it("--session picks another session; --no-redact shows the raw command", () => {
    const repo = tempRepo();
    session(repo);
    expect(run(["receipt", "--session", "s-old"], repo).stdout).toContain("Session `s-old`");
    expect(run(["receipt", "--last", "--no-redact"], repo).stdout).toContain("hunter2hunter2");
  });

  it("--format txt is a 48-column receipt", () => {
    const repo = tempRepo();
    session(repo);
    const res = run(["receipt", "--format", "txt"], repo);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("B U L K H E A D");
    expect(res.stdout).toContain("*** CLAIM ≠ EVIDENCE ***");
    for (const line of res.stdout.split("\n")) expect([...line].length).toBeLessThanOrEqual(48);
  });

  it("--out writes the file and infers html from the extension", () => {
    const repo = tempRepo();
    session(repo);
    const res = run(["receipt", "--out", "receipt.html"], repo);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Wrote html receipt for session s-new to");
    const html = readFileSync(join(repo, "receipt.html"), "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<span class="stamp">CLAIM ≠ EVIDENCE</span>');
  });

  it("fails clearly on an unknown session, a bad format, or an empty ledger", () => {
    const repo = tempRepo();
    session(repo);
    const unknown = run(["receipt", "--session", "nope"], repo);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('No session "nope"');
    expect(unknown.stdout).toBe("");
    const bad = run(["receipt", "--format", "pdf"], repo);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('unknown --format "pdf"');
    const empty = run(["receipt"], tempRepo());
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("nothing to put on a receipt");
    expect(empty.stdout).toBe("");
  });
});
