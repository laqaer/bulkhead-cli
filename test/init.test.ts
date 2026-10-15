import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runInit, mergeSettings } from "../src/init.js";
import { DEFAULT_POLICY_YAML, STRICT_POLICY_YAML } from "../src/templates.js";
import { loadPolicy, STRICT_PRESET_BLOCKED_COMMANDS } from "../src/policy.js";
import { protectedPathsGuard } from "../src/guards/protected-paths.js";
import { tempRepo } from "./helpers.js";

describe("runInit --preset", () => {
  const strictPatterns = STRICT_PRESET_BLOCKED_COMMANDS.map((r) => r.pattern);

  it("writes the default policy when no preset is given", () => {
    const repo = tempRepo();
    const r = runInit(repo, { hookCommand: "node /abs/cli.js hook" });
    expect(r.preset).toBe("default");
    expect(readFileSync(join(repo, "bulkhead.yaml"), "utf8")).toBe(DEFAULT_POLICY_YAML);
    const patterns = loadPolicy(repo).blockedCommands.map((b) => b.pattern);
    for (const p of strictPatterns) expect(patterns).not.toContain(p);
  });

  it("writes the strict policy, and loading it enforces every strict rule", () => {
    const repo = tempRepo();
    const r = runInit(repo, { hookCommand: "node /abs/cli.js hook", preset: "strict" });
    expect(r.preset).toBe("strict");
    expect(r.policyCreated).toBe(true);
    expect(readFileSync(join(repo, "bulkhead.yaml"), "utf8")).toBe(STRICT_POLICY_YAML);
    const patterns = loadPolicy(repo).blockedCommands.map((b) => b.pattern);
    expect(patterns).toEqual(expect.arrayContaining(strictPatterns));
  });

  it("rejects an unknown preset before writing anything", () => {
    const repo = tempRepo();
    expect(() =>
      runInit(repo, { preset: "paranoid" as unknown as "strict" }),
    ).toThrow(/Unknown preset "paranoid"\. Expected one of: default, strict\./);
    expect(existsSync(join(repo, "bulkhead.yaml"))).toBe(false);
    expect(existsSync(join(repo, ".claude", "settings.json"))).toBe(false);
  });

  it("keeps an existing policy when a different preset is requested without force", () => {
    const repo = tempRepo();
    runInit(repo, { hookCommand: "node /abs/cli.js hook" });
    const r = runInit(repo, { hookCommand: "node /abs/cli.js hook", preset: "strict" });
    expect(r.policyCreated).toBe(false);
    expect(readFileSync(join(repo, "bulkhead.yaml"), "utf8")).toBe(DEFAULT_POLICY_YAML);
  });

  it("replaces an existing policy with the requested preset under force", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "bulkhead.yaml"), "version: 1\n# custom\n");
    const r = runInit(repo, { hookCommand: "node /abs/cli.js hook", preset: "strict", force: true });
    expect(r.policyCreated).toBe(true);
    expect(readFileSync(join(repo, "bulkhead.yaml"), "utf8")).toBe(STRICT_POLICY_YAML);
  });

  it("still writes and upgrades .claude/settings.json, which the policy it installs protects", () => {
    // settings.json is immutable to the GUARDED AGENT's tools. init is not a
    // tool call — it writes the file directly — so install and re-init work.
    const repo = tempRepo();
    runInit(repo, { hookCommand: "old-cmd", preset: "strict" });
    runInit(repo, { hookCommand: "new-cmd", preset: "strict" });
    const settingsPath = join(repo, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const commands = settings.hooks.PreToolUse.flatMap((m: any) => m.hooks.map((h: any) => h.command));
    expect(commands).toEqual(["new-cmd pre"]);

    const agentEdit = { toolName: "Edit", toolInput: { file_path: settingsPath, old_string: "a", new_string: "b" } };
    expect(protectedPathsGuard(agentEdit, loadPolicy(repo)).action).toBe("deny");
  });
});

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
    runInit(repo, { hookCommand: "npx --yes @bulkheadtools/cli hook" });
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    const commands = settings.hooks.PreToolUse.flatMap((m: any) => m.hooks.map((h: any) => h.command));
    expect(commands).toContain("node /Users/me/bulkhead-tools/lint.js"); // user's hook survives
    expect(commands).toContain("npx --yes @bulkheadtools/cli hook pre"); // ours added
  });

  it("strips a legacy @bulkheadtools/cli hook on re-init even without the marker", () => {
    const repo = tempRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    // A pre-marker install: our command, but no bulkhead:true on the matcher.
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "*", hooks: [{ type: "command", command: "npx --yes @bulkheadtools/cli hook pre" }] },
          ],
        },
      }),
    );
    runInit(repo, { hookCommand: "npx --yes @bulkheadtools/cli hook" });
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse).toHaveLength(1); // deduped, not doubled
  });

  it("strips a pre-rename @bulkhead/cli hook on re-init", () => {
    const repo = tempRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    // Installed while the package was still specced as @bulkhead/cli — the npm org
    // `bulkhead` was taken, so it shipped as @bulkheadtools/cli. Anyone who ran init
    // from the GitHub install form before the rename has this exact command.
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
    runInit(repo, { hookCommand: "npx --yes @bulkheadtools/cli hook" });
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    const commands = settings.hooks.PreToolUse.flatMap((m: any) => m.hooks.map((h: any) => h.command));
    expect(commands).toEqual(["npx --yes @bulkheadtools/cli hook pre"]); // old spec gone, not doubled
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
