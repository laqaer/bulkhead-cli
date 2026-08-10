import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runInit, mergeSettings } from "../src/init.js";
import { tempRepo } from "./helpers.js";

describe("runInit", () => {
  it("creates policy, hooks, gitignore", () => {
    const repo = tempRepo();
    const r = runInit(repo, { hookCommand: "node /abs/cli.js hook" });
    expect(r.policyCreated).toBe(true);
    expect(existsSync(join(repo, "bulkhead.yaml"))).toBe(true);
    expect(existsSync(join(repo, ".claude", "settings.json"))).toBe(true);
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toContain(".bulkhead/");

    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("node /abs/cli.js hook pre");
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe("node /abs/cli.js hook post");
  });

  it("does not overwrite an existing policy without --force", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "bulkhead.yaml"), "version: 1\n# custom\n");
    const r = runInit(repo, {});
    expect(r.policyCreated).toBe(false);
    expect(readFileSync(join(repo, "bulkhead.yaml"), "utf8")).toContain("# custom");
  });

  it("is idempotent — re-running does not duplicate hooks", () => {
    const repo = tempRepo();
    runInit(repo, { hookCommand: "node /abs/cli.js hook" });
    runInit(repo, { hookCommand: "node /abs/cli.js hook" });
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
  });

  it("preserves a user's unrelated hooks and settings", () => {
    const repo = tempRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({
        model: "claude-opus-4-8",
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }],
        },
      }),
    );
    mergeSettings(join(repo, ".claude", "settings.json"), "node /abs/cli.js hook");
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(settings.model).toBe("claude-opus-4-8");
    const commands = settings.hooks.PreToolUse.flatMap((m: any) => m.hooks.map((h: any) => h.command));
    expect(commands).toContain("my-linter");
    expect(commands).toContain("node /abs/cli.js hook pre");
  });

  it("does NOT delete a user hook that merely references a 'bulkhead' path", () => {
    const repo = tempRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Write|Edit", hooks: [{ type: "command", command: "node /Users/me/bulkhead-tools/lint.js" }] },
          ],
        },
      }),
    );
    runInit(repo, { hookCommand: "npx --yes @bulkhead/cli hook" });
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    const commands = settings.hooks.PreToolUse.flatMap((m: any) => m.hooks.map((h: any) => h.command));
    expect(commands).toContain("node /Users/me/bulkhead-tools/lint.js"); // user's hook survives
    expect(commands).toContain("npx --yes @bulkhead/cli hook pre"); // ours added
  });

  it("strips a legacy @bulkhead/cli hook on re-init even without the marker", () => {
    const repo = tempRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    // A pre-marker install: our command, but no bulkhead:true on the matcher.
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "*", hooks: [{ type: "command", command: "npx --yes @bulkhead/cli hook pre" }] },
          ],
        },
      }),
    );
    runInit(repo, { hookCommand: "npx --yes @bulkhead/cli hook" });
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse).toHaveLength(1); // deduped, not doubled
  });

  it("upgrades the bulkhead command on re-init", () => {
    const repo = tempRepo();
    runInit(repo, { hookCommand: "old-cmd" });
    runInit(repo, { hookCommand: "new-cmd" });
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    const commands = settings.hooks.PreToolUse.flatMap((m: any) => m.hooks.map((h: any) => h.command));
    expect(commands).toEqual(["new-cmd pre"]);
  });
});
