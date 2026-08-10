import { describe, it, expect } from "vitest";
import { classifyEvidence, exitCodeOf, responseText } from "../src/evidence.js";

const bash = (command: string, response: unknown) =>
  classifyEvidence("Bash", { command }, response);

describe("classifyEvidence — file tools", () => {
  it("Write -> file_created with path", () => {
    const ev = classifyEvidence("Write", { file_path: "/repo/src/a.ts", content: "x" }, {});
    expect(ev).toEqual([{ type: "file_created", detail: "/repo/src/a.ts" }]);
  });
  it("Edit -> file_modified", () => {
    const ev = classifyEvidence("Edit", { file_path: "/repo/src/a.ts" }, {});
    expect(ev[0]!.type).toBe("file_modified");
  });
  it("unknown tool -> no evidence", () => {
    expect(classifyEvidence("Read", { file_path: "/x" }, {})).toEqual([]);
  });
});

describe("classifyEvidence — tests", () => {
  it("exit code 0 wins over scary-looking output", () => {
    // Output mentions 'error' — the old forge heuristic would flag this failed.
    const ev = bash("pnpm test", { stdout: "checked error-handling paths\n79 passed", exit_code: 0 });
    expect(ev[0]!.type).toBe("test_passed");
  });
  it("nonzero exit code -> test_failed even with quiet output", () => {
    const ev = bash("npm test", { stdout: "", exit_code: 1 });
    expect(ev[0]!.type).toBe("test_failed");
  });
  it("no exit code: strong fail pattern -> test_failed (fail beats pass)", () => {
    const ev = bash("vitest run", { stdout: "Tests  3 failed | 10 passed" });
    expect(ev[0]!.type).toBe("test_failed");
  });
  it("no exit code: strong pass pattern -> test_passed ('0 failed' is not a failure)", () => {
    const ev = bash("cargo test", { stdout: "test result: ok. 42 passed; 0 failed" });
    expect(ev[0]!.type).toBe("test_passed");
  });
  it("no exit code, no strong signal -> test_run (undetermined)", () => {
    const ev = bash("pytest -q", { stdout: "collecting ..." });
    expect(ev[0]!.type).toBe("test_run");
  });
  it("non-test command -> no test evidence", () => {
    expect(bash("ls -la", { stdout: "total 8" })).toEqual([]);
  });
  it("'latest' keyword doesn't false-positive as a test command", () => {
    expect(bash("npm view zod@latest version", { stdout: "4.1.0" })).toEqual([]);
  });

  // Command-position regressions: runner names as DATA are not test runs.
  it("grep for a runner name is not a test run (grep exit 1 = no match)", () => {
    expect(bash('grep -rn "pytest" README.md', { stdout: "", exit_code: 1 })).toEqual([]);
  });
  it("reading a test log is not a test run", () => {
    expect(bash("tail -20 vitest.log", { stdout: "Tests  3 failed | 10 passed" })).toEqual([]);
    expect(bash("cat pytest-output.txt", { stdout: "1 failed" })).toEqual([]);
  });
  it("a commit message naming a runner is not a test run", () => {
    const ev = bash('git commit -m "fix vitest timeout"', {
      stdout: "[main abc1234] fix vitest timeout",
      exit_code: 0,
    });
    expect(ev).toEqual([{ type: "commit_created", detail: "fix vitest timeout" }]);
  });
  it("pip install pytest is not a test run", () => {
    expect(bash("pip install pytest", { stdout: "Successfully installed", exit_code: 0 })).toEqual([]);
  });
  it("recognizes npx/python -m/script-name runner forms", () => {
    expect(bash("npx vitest run", { stdout: "", exit_code: 0 })[0]!.type).toBe("test_passed");
    expect(bash("python -m pytest tests/", { stdout: "", exit_code: 1 })[0]!.type).toBe("test_failed");
    expect(bash("pnpm run test:unit", { stdout: "5 passed" })[0]!.type).toBe("test_passed");
  });

  // Outcome-signal regressions.
  it("an interrupted run is never a pass — test_run (undetermined)", () => {
    const ev = bash("pnpm test", {
      stdout: " ✓ test/a.test.ts (12 tests) 34ms\n ✓ test/b.test.ts (8 tests)",
      stderr: "Command timed out after 2m 0.0s",
      interrupted: true,
    });
    expect(ev[0]!.type).toBe("test_run");
  });
  it("per-test ✓ ticks alone are not a completed pass", () => {
    const ev = bash("pnpm test", { stdout: " ✓ test/a.test.ts (12 tests)" });
    expect(ev[0]!.type).toBe("test_run");
  });
  it("a pass summary outranks an incidental traceback (pytest -s)", () => {
    const ev = bash("pytest -s tests/", {
      stdout: "Traceback (most recent call last):\n  ...logged by a passing test...\n===== 10 passed in 0.8s =====",
    });
    expect(ev[0]!.type).toBe("test_passed");
  });
  it("a traceback with no pass summary is still a failure signal", () => {
    const ev = bash("pytest tests/", { stdout: "Traceback (most recent call last):\n  boom" });
    expect(ev[0]!.type).toBe("test_failed");
  });
});

describe("classifyEvidence — commits and PRs", () => {
  it("git commit success -> commit_created with message from output", () => {
    const ev = bash('git commit -m "fix things"', {
      stdout: "[main 1a2b3c4d] fix things\n 2 files changed",
      exit_code: 0,
    });
    expect(ev[0]).toEqual({ type: "commit_created", detail: "fix things" });
  });
  it("git commit failure (nonzero exit) -> no commit evidence", () => {
    const ev = bash('git commit -m "x"', { stderr: "nothing to commit", exit_code: 1 });
    expect(ev).toEqual([]);
  });
  it("gh pr create -> pr_created with URL extracted", () => {
    const ev = bash("gh pr create --fill", {
      stdout: "https://github.com/laqaer/bulkhead/pull/12\n",
      exit_code: 0,
    });
    expect(ev[0]).toEqual({ type: "pr_created", detail: "https://github.com/laqaer/bulkhead/pull/12" });
  });
  it("gh pr create failure with no URL -> no evidence", () => {
    const ev = bash("gh pr create", { stderr: "auth required", exit_code: 1 });
    expect(ev).toEqual([]);
  });

  // Success-proof regressions.
  it("git commit with NO exit code needs git's success signature", () => {
    // Claude Code's Bash response carries no exit code — a husky rejection or
    // 'nothing to commit' must not mint commit evidence.
    expect(bash('git commit -m "wip"', { stdout: "", stderr: "husky - pre-commit hook exited with code 1 (error)" })).toEqual([]);
    expect(bash('git commit -m "wip"', { stdout: "nothing to commit, working tree clean" })).toEqual([]);
    const ok = bash('git commit -m "wip"', { stdout: "[main 9f8e7d6] wip\n 1 file changed" });
    expect(ok).toEqual([{ type: "commit_created", detail: "wip" }]);
  });
  it("a failed 'gh pr create' printing an EXISTING PR's URL is not pr_created", () => {
    const ev = bash("gh pr create --fill", {
      stderr: 'a pull request for branch "fix" into branch "main" already exists:\nhttps://github.com/o/r/pull/45',
      exit_code: 1,
    });
    expect(ev).toEqual([]);
  });
  it("quoted command text is not an invocation", () => {
    expect(bash('echo "git commit -m done"', { stdout: "git commit -m done", exit_code: 0 })).toEqual([]);
  });
});

describe("response helpers", () => {
  it("exitCodeOf finds common field names", () => {
    expect(exitCodeOf({ exit_code: 2 })).toBe(2);
    expect(exitCodeOf({ exitCode: 0 })).toBe(0);
    expect(exitCodeOf({ nothing: true })).toBeUndefined();
    expect(exitCodeOf("string")).toBeUndefined();
  });
  it("responseText flattens nested shapes", () => {
    expect(responseText({ stdout: "a", stderr: "b" })).toBe("a\nb");
    expect(responseText([{ text: "x" }, "y"])).toContain("x");
  });
});
