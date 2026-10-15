import { afterAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CORPUS, type CorpusCase, type CorpusPreset, type CorpusVerdict } from "../src/corpus.js";
import { handlePreToolUse, type PreToolUseOutput } from "../src/hook.js";
import { runInit } from "../src/init.js";
import { tempRepo } from "./helpers.js";

/**
 * Pins the incident corpus (src/corpus.ts) to what the shipped policy actually
 * does. Every case runs through the REAL PreToolUse entrypoint — the function
 * `bulkhead hook pre` calls — inside a temp repo that `runInit` set up with the
 * preset under test, so the policy is the bulkhead.yaml a user would get.
 *
 * If a change makes a known miss start being caught, or lets an incident
 * shape through, or starts blocking a control, the matching case fails here
 * and the corpus claim has to be updated on purpose.
 */

const PRESETS: CorpusPreset[] = ["default", "strict"];
const FILE_PATH_KEYS = ["file_path", "notebook_path", "path"] as const;

const repos = new Map<CorpusPreset, string>();
function repoFor(preset: CorpusPreset): string {
  let repo = repos.get(preset);
  if (!repo) {
    repo = tempRepo();
    runInit(repo, { preset, hookCommand: "node /nonexistent/cli.js hook" });
    repos.set(preset, repo);
  }
  return repo;
}

afterAll(() => {
  for (const repo of repos.values()) rmSync(repo, { recursive: true, force: true });
});

/** A hook payload shaped like the one Claude Code sends for this tool call. */
function payload(c: CorpusCase, root: string, preset: CorpusPreset) {
  const toolInput: Record<string, unknown> = { ...c.input };
  // Claude Code hands file tools absolute paths; the corpus stores them
  // repo-relative so it reads the same in docs and `bulkhead demo`.
  for (const key of FILE_PATH_KEYS) {
    const value = toolInput[key];
    if (typeof value === "string" && !isAbsolute(value)) toolInput[key] = join(root, value);
  }
  return {
    session_id: `corpus-${preset}-${c.id}`,
    transcript_path: join(root, "no-transcript.jsonl"),
    cwd: root,
    hook_event_name: "PreToolUse",
    tool_name: c.tool,
    tool_input: toolInput,
  };
}

function decide(c: CorpusCase, preset: CorpusPreset): { verdict: CorpusVerdict; reason: string } {
  const root = repoFor(preset);
  const result = handlePreToolUse(payload(c, root, preset));
  expect(result.exitCode).toBe(0);
  const out = result.output as PreToolUseOutput;
  const decision = out.hookSpecificOutput?.permissionDecision;
  // The corpus only speaks allow/deny; an `ask` would mean the risky gate is
  // on, which neither preset does.
  expect(decision === undefined || decision === "deny").toBe(true);
  return {
    verdict: decision === "deny" ? "deny" : "allow",
    reason: out.hookSpecificOutput?.permissionDecisionReason ?? "",
  };
}

describe("incident corpus: shape of the data", () => {
  it("has unique ids", () => {
    const ids = CORPUS.map((c) => c.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  it("explains every incident the default preset lets through", () => {
    const unexplained = CORPUS.filter(
      (c) => c.kind === "incident" && c.expect.default === "allow" && !c.note,
    ).map((c) => c.id);
    expect(unexplained).toEqual([]);
  });

  it("explains every known miss", () => {
    const unexplained = CORPUS.filter((c) => c.kind === "known-miss" && !c.note).map((c) => c.id);
    expect(unexplained).toEqual([]);
  });

  it("pins known misses and controls as allowed under every preset", () => {
    const wrong = CORPUS.filter(
      (c) =>
        (c.kind === "known-miss" || c.kind === "control") &&
        (c.expect.default !== "allow" || c.expect.strict !== "allow"),
    ).map((c) => c.id);
    expect(wrong).toEqual([]);
  });

  it("never has strict allow what default denies (strict only adds rules)", () => {
    const wrong = CORPUS.filter((c) => c.expect.default === "deny" && c.expect.strict !== "deny").map(
      (c) => c.id,
    );
    expect(wrong).toEqual([]);
  });
});

for (const preset of PRESETS) {
  describe(`incident corpus through the real PreToolUse hook (--preset ${preset})`, () => {
    it.each(CORPUS.map((c) => [c.id, c] as const))("%s", (_id, c) => {
      const { verdict, reason } = decide(c, preset);
      expect(verdict, `${c.title}\n${reason}`).toBe(c.expect[preset]);
      if (verdict === "deny") {
        // A deny is a Bulkhead refusal the agent can read, never an accident
        // of the budget or loop guards.
        expect(reason).toContain("Bulkhead blocked this action.");
        expect(reason).not.toMatch(/Guard: (budget|loop)/);
      }
    });
  });
}
