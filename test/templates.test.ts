import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  BUILTIN_BLOCKED_COMMANDS,
  BUILTIN_PROTECTED_PATHS,
  DEFAULT_ALLOWED_PATHS,
  PROSE_SENSITIVE_PATTERNS,
  STRICT_PRESET_BLOCKED_COMMANDS,
  defaultPolicy,
  normalizePolicy,
} from "../src/policy.js";
import {
  DEFAULT_POLICY_YAML,
  STRICT_POLICY_YAML,
  POLICY_PRESETS,
  isPolicyPreset,
  policyTemplate,
} from "../src/templates.js";

/**
 * The file `bulkhead init` writes is what a user reads to learn what is
 * enforced. These tests parse it back and hold it to the enforced lists, so
 * the documentation cannot drift from the code (the fork bomb rule had already
 * drifted out of the hand-written YAML before the lists were generated).
 */
type RawPolicy = {
  protected_paths: { deny: string[]; allow: string[] };
  blocked_commands: Array<{ pattern: string; message?: string }>;
  budget: unknown;
  loop: unknown;
  verify: unknown;
  risky: unknown;
};

const parsedDefault = parseYaml(DEFAULT_POLICY_YAML) as RawPolicy;
const parsedStrict = parseYaml(STRICT_POLICY_YAML) as RawPolicy;

describe("policy templates", () => {
  it("lists every built-in command rule, verbatim and in order", () => {
    expect(parsedDefault.blocked_commands).toEqual(
      BUILTIN_BLOCKED_COMMANDS.map(({ pattern, message }) => ({ pattern, message })),
    );
  });

  it("lists every built-in protected path", () => {
    expect(parsedDefault.protected_paths.deny).toEqual([...BUILTIN_PROTECTED_PATHS]);
    expect(parsedDefault.protected_paths.allow).toEqual([...DEFAULT_ALLOWED_PATHS]);
    expect(parsedDefault.protected_paths.deny).toEqual(
      expect.arrayContaining([".claude/settings.json", ".claude/settings.local.json"]),
    );
  });

  it("strict is the default plus the strict block, and nothing else differs", () => {
    expect(parsedStrict.blocked_commands).toEqual([
      ...BUILTIN_BLOCKED_COMMANDS,
      ...STRICT_PRESET_BLOCKED_COMMANDS,
    ].map(({ pattern, message }) => ({ pattern, message })));
    expect(parsedStrict.protected_paths).toEqual(parsedDefault.protected_paths);
    for (const key of ["budget", "loop", "verify", "risky"] as const) {
      expect(parsedStrict[key]).toEqual(parsedDefault[key]);
    }
  });

  it("the strict file explains itself", () => {
    expect(STRICT_POLICY_YAML).toContain("# Preset: strict");
    expect(STRICT_POLICY_YAML).toContain("# ── Strict preset");
    expect(STRICT_POLICY_YAML).toMatch(/git clean — ANY forced clean is denied/);
    expect(STRICT_POLICY_YAML).toMatch(/--force-with-lease stays allowed/);
    expect(DEFAULT_POLICY_YAML).toContain("# Preset: default");
    expect(DEFAULT_POLICY_YAML).not.toContain("# ── Strict preset");
  });

  it("every shipped pattern compiles as a case-insensitive regex", () => {
    for (const rule of [...BUILTIN_BLOCKED_COMMANDS, ...STRICT_PRESET_BLOCKED_COMMANDS]) {
      expect(() => new RegExp(rule.pattern, "i"), rule.pattern).not.toThrow();
      expect(rule.message, rule.pattern).toBeTruthy();
    }
  });

  it("loading the strict file keeps the built-ins first and adds each strict rule once", () => {
    const policy = normalizePolicy(parsedStrict, "/repo");
    const patterns = policy.blockedCommands.map((r) => r.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
    expect(patterns).toEqual([
      ...defaultPolicy("/repo").blockedCommands.map((r) => r.pattern),
      ...STRICT_PRESET_BLOCKED_COMMANDS.map((r) => r.pattern),
    ]);
  });

  it("marks only curl|sh and the fork bomb as not skippable for inert text", () => {
    const notProse = [...BUILTIN_BLOCKED_COMMANDS, ...STRICT_PRESET_BLOCKED_COMMANDS]
      .filter((r) => !PROSE_SENSITIVE_PATTERNS.has(r.pattern))
      .map((r) => r.message);
    expect(notProse).toEqual(["Piping a downloaded script straight into a shell", "Fork bomb"]);
  });

  it("knows exactly two presets", () => {
    expect([...POLICY_PRESETS]).toEqual(["default", "strict"]);
    expect(isPolicyPreset("strict")).toBe(true);
    expect(isPolicyPreset("Strict")).toBe(false);
    expect(isPolicyPreset(true)).toBe(false);
    expect(policyTemplate("default")).toBe(DEFAULT_POLICY_YAML);
    expect(policyTemplate("strict")).toBe(STRICT_POLICY_YAML);
  });
});
