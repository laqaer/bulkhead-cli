import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CORPUS } from "../src/corpus.js";
import { renderDemo, runDemo, shouldColor, summaryLine, type DemoResult } from "../src/demo.js";
import { appendLedger } from "../src/ledger.js";
import { tempRepo } from "./helpers.js";

/**
 * The demo's contract is honesty, not a particular score: every corpus case
 * runs through the real hook, each result is compared to the corpus
 * expectation for the preset, any difference is shown and fails the run,
 * and the user's own repo is never touched. These tests pin that contract.
 * They deliberately do not pin individual verdicts — test/corpus.test.ts
 * owns those — so they hold whichever guard rules are in force.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "..", "dist", "cli.js");
const PKG_VERSION = JSON.parse(readFileSync(resolve(HERE, "..", "package.json"), "utf8")).version as string;
const ANSI = /\u001b\[/;

function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const env = { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined, ...opts.env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return spawnSync("node", [CLI, ...args], {
    cwd: opts.cwd ?? tempRepo(),
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
}

let result: DemoResult;
beforeAll(() => {
  result = runDemo({ version: "test" });
});

describe("runDemo (in process, real entrypoints)", () => {
  it("replays every corpus case, in order, with its expectation for the preset", () => {
    expect(result.preset).toBe("default");
    expect(result.cases.map((c) => c.id)).toEqual(CORPUS.map((c) => c.id));
    for (const [i, c] of result.cases.entries()) {
      expect(c.kind).toBe(CORPUS[i]!.kind);
      expect(c.title).toBe(CORPUS[i]!.title);
      expect(c.expected).toBe(CORPUS[i]!.expect.default);
      expect(["deny", "allow", "ask"]).toContain(c.actual);
      expect(c.ledgerSeq).toBe(i); // each case is one real PreToolUse, recorded in order
    }
  });

  it("scores a case as matched exactly when the verdict agrees with the corpus", () => {
    for (const c of result.cases) {
      expect(c.match, c.id).toBe(c.expected === "deny" ? c.actual === "deny" : c.actual !== "deny");
    }
    const mismatches =
      result.cases.filter((c) => !c.match).length +
      result.stories.filter((s) => !s.ok).length +
      (result.ledger.ok ? 0 : 1);
    expect(result.summary.mismatches).toBe(mismatches);
    expect(result.ok).toBe(mismatches === 0);
  });

  it("explains every deny in words, never with a raw regex", () => {
    for (const c of result.cases.filter((x) => x.actual === "deny")) {
      expect(c.why, c.id).toBeTruthy();
      expect(c.why, c.id).not.toMatch(/\\[bsdw]/);
    }
  });

  it("blocks the completion lie through the real Stop hook, quoting the failing run", () => {
    const lie = result.stories.find((s) => s.id === "completion-lie")!;
    expect(lie.outcome).toBe("blocked");
    expect(lie.ok).toBe(true);
    expect(lie.steps.map((s) => s.event)).toEqual(["PreToolUse", "PostToolUse", "Stop"]);
    expect(lie.steps[1]!.result).toBe("recorded test_failed");
    expect(lie.refusal).toContain('You stated "All tests pass" but the evidence ledger disagrees');
    // The sized vitest output makes the quoted evidence start at the failure.
    expect(lie.refusal).toContain("test_failed: pnpm test (exit 1) FAIL src/checkout.test.ts");
    expect(lie.systemMessage).toMatch(
      /^🛡 Bulkhead: agent said "All tests pass" but the latest `pnpm test` exited 1 — sent back to work \(ledger #\d+\)$/,
    );
  });

  it("pauses the next tool call once the transcript is over the session cap", () => {
    const budget = result.stories.find((s) => s.id === "budget-cap")!;
    expect(budget.outcome).toBe("paused");
    expect(budget.ok).toBe(true);
    expect(budget.refusal).toContain("Guard: budget");
    expect(budget.systemMessage).toContain("🛡 Bulkhead paused the agent: session spend $");
    expect(budget.detail).toMatch(/model turns \(claude-opus-5-5\) · \$\d+\.\d\d spent · session cap \$5\.00/);
  });

  it("verifies the ledger it produced: one entry per call, chain intact", () => {
    expect(result.ledger.ok).toBe(true);
    expect(result.ledger.entries).toBe(CORPUS.length + 4); // + pre/post/stop lie, + budget pre
    expect(result.ledger.head).toMatch(/^[0-9a-f]{64}$/);
  });

  it("removes its temp repo unless --keep, and keeps it when asked", () => {
    expect(result.keptAt).toBeUndefined();
    const kept = runDemo({ version: "test", keep: true });
    try {
      expect(kept.keptAt).toBeDefined();
      expect(existsSync(join(kept.keptAt!, ".bulkhead", "ledger.jsonl"))).toBe(true);
      expect(existsSync(join(kept.keptAt!, "bulkhead.yaml"))).toBe(true);
    } finally {
      rmSync(dirname(kept.keptAt!), { recursive: true, force: true });
    }
  });

  it("rejects a preset the corpus has no expectations for", () => {
    expect(() => runDemo({ version: "test", preset: "yolo" })).toThrow(/unknown preset/);
  });
});

describe("renderDemo", () => {
  it("groups the scoreboard and ends with the summary line", () => {
    const text = renderDemo(result);
    for (const heading of ["Dangerous calls denied", "Known misses (by design)", "Ordinary work allowed"]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("Story 1 · The completion lie");
    expect(text).toContain("Story 2 · The budget cap");
    expect(text).toContain("What Claude reads:");
    expect(text).toContain("What you see:");
    expect(text).toContain(summaryLine(result));
    expect(summaryLine(result)).toMatch(
      /^\d+\/\d+ dangerous calls denied · .*\d+ known misses shown · \d+\/\d+ ordinary commands allowed · ledger verified \(\d+ entries\)/,
    );
    expect(text).not.toMatch(ANSI);
  });

  it("shows a mismatch loudly instead of hiding it", () => {
    const i = result.cases.findIndex((c) => c.kind === "control");
    const broken: DemoResult = structuredClone(result);
    broken.cases[i] = { ...broken.cases[i]!, actual: "deny", match: false, why: "made up" };
    broken.summary.mismatches += 1;
    broken.ok = false;
    const text = renderDemo(broken);
    expect(text).toContain(`✗ ${broken.cases[i]!.title}`);
    expect(text).toContain("denied ← expected allowed");
    expect(text).toMatch(/✗ \d+ results? differ from the corpus expectation for preset "default":/);
    expect(text).toContain(`${broken.cases[i]!.id}`);
    expect(summaryLine(broken)).toMatch(/\d+ mismatch(es)?$/);
  });

  it("colors only when asked", () => {
    expect(renderDemo(result, { color: true })).toMatch(ANSI);
  });
});

describe("shouldColor", () => {
  it("honours NO_COLOR, TERM=dumb and FORCE_COLOR, else follows the TTY", () => {
    expect(shouldColor({ isTTY: true }, {})).toBe(true);
    expect(shouldColor({ isTTY: false }, {})).toBe(false);
    expect(shouldColor({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    expect(shouldColor({ isTTY: true }, { NO_COLOR: "" })).toBe(true); // empty = unset, per no-color.org
    expect(shouldColor({ isTTY: true }, { TERM: "dumb" })).toBe(false);
    expect(shouldColor({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
    expect(shouldColor({ isTTY: false }, { FORCE_COLOR: "1", NO_COLOR: "1" })).toBe(false);
  });
});

describe("bulkhead demo (real binary)", () => {
  it("never touches the user's repo or ledger, cleans up, and prints plain text when piped", () => {
    const repo = tempRepo();
    appendLedger(repo, { ts: "2026-09-25T00:00:00.000Z", sessionId: "mine", event: "pre", action: "allow", toolName: "Bash", toolInput: { command: "ls" } });
    const before = readFileSync(join(repo, ".bulkhead", "ledger.jsonl"), "utf8");
    const scratch = mkdtempSync(join(tmpdir(), "bulkhead-demo-tmp-"));

    const res = runCli(["demo"], { cwd: repo, env: { TMPDIR: scratch } });

    expect(res.stderr).toBe("");
    expect(res.stdout).not.toMatch(ANSI);
    expect(res.stdout).toContain("🛡 Bulkhead demo");
    expect(res.stdout).toContain("ledger verified");
    expect(readFileSync(join(repo, ".bulkhead", "ledger.jsonl"), "utf8")).toBe(before);
    expect(existsSync(join(repo, "bulkhead.yaml"))).toBe(false); // no init in the user's repo
    expect(readdirSync(scratch)).toEqual([]); // temp repo removed
    rmSync(scratch, { recursive: true, force: true });

    // Exit status mirrors the verdict: non-zero exactly when something differed.
    const json = JSON.parse(runCli(["demo", "--json"]).stdout) as DemoResult;
    expect(res.status).toBe(json.ok ? 0 : 1);
    if (!json.ok) expect(res.stdout).toContain("differ from the corpus expectation");
  });

  it("--json is machine-readable for the website", () => {
    const res = runCli(["demo", "--json"]);
    const r = JSON.parse(res.stdout) as DemoResult;
    expect(res.status).toBe(r.ok ? 0 : 1);
    expect(r.schema).toBe(1);
    expect(r.version).toBe(PKG_VERSION);
    expect(r.preset).toBe("default");
    expect(r.cases).toHaveLength(CORPUS.length);
    for (const c of r.cases) {
      expect(Object.keys(c)).toEqual(expect.arrayContaining(["id", "kind", "title", "expected", "actual", "match", "action"]));
    }
    expect(r.stories.map((s) => s.id)).toEqual(["completion-lie", "budget-cap"]);
    expect(r.ledger.ok).toBe(true);
    // A curl that carries a token reference keeps the reference, not a value.
    expect(r.cases.find((c) => c.id === "graphql-volume-delete")!.action).toContain("$RAILWAY_TOKEN");
  });

  it("colors only for a terminal or FORCE_COLOR, and NO_COLOR wins", () => {
    expect(runCli(["demo"], { env: { FORCE_COLOR: "1" } }).stdout).toMatch(ANSI);
    expect(runCli(["demo"], { env: { FORCE_COLOR: "1", NO_COLOR: "1" } }).stdout).not.toMatch(ANSI);
  });

  it("rejects an unknown preset with a usable message", () => {
    const res = runCli(["demo", "--preset", "yolo"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unknown preset "yolo"');
    expect(res.stdout).toBe("");
  });

  it("--preset strict scores against the strict expectations", () => {
    const res = runCli(["demo", "--json", "--preset", "strict"]);
    const r = JSON.parse(res.stdout) as DemoResult;
    expect(r.preset).toBe("strict");
    expect(r.cases.every((c, i) => c.expected === CORPUS[i]!.expect.strict)).toBe(true);
    expect(r.cases.some((c) => c.group === "strict-only")).toBe(false);
    expect(res.status).toBe(r.ok ? 0 : 1);
  });
});
