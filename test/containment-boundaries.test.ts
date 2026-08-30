import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultPolicy,
  normalizePolicy,
} from "../src/policy.js";
import { protectedPathsGuard } from "../src/guards/protected-paths.js";
import type { ToolCall } from "../src/types.js";
import { tempRepo } from "./helpers.js";

function write(path: string): ToolCall {
  return { toolName: "Write", toolInput: { file_path: path, content: "x" } };
}

function edit(path: string): ToolCall {
  return {
    toolName: "Edit",
    toolInput: { file_path: path, old_string: "a", new_string: "b" },
  };
}

function multiEdit(path: string): ToolCall {
  return {
    toolName: "MultiEdit",
    toolInput: {
      edits: [{ file_path: path, old_string: "a", new_string: "b" }],
    },
  };
}

function notebook(path: string): ToolCall {
  return {
    toolName: "NotebookEdit",
    toolInput: { notebook_path: path, new_source: "[]" },
  };
}

describe("policy self-protection", () => {
  it("ignores a policy-supplied workspace root and retains baseline rules", () => {
    const policy = normalizePolicy(
      {
        workspace_root: "/tmp/attacker-root",
        protected_paths: { deny: [], allow: [] },
        blocked_commands: [],
      },
      "/repo",
    );

    expect(policy.workspaceRoot).toBe("/repo");
    expect(policy.protectedPaths.deny).toEqual(
      expect.arrayContaining(["bulkhead.yaml", ".bulkhead", ".bulkhead/**", ".env"]),
    );
    expect(policy.blockedCommands.map((rule) => rule.pattern)).toEqual(
      expect.arrayContaining([
        "\\bDROP\\s+TABLE\\b",
        "\\bDROP\\s+DATABASE\\b",
        "\\bmkfs\\.[a-z0-9]+\\b",
      ]),
    );
  });

  it("adds project rules without replacing the baseline", () => {
    const policy = normalizePolicy(
      {
        protected_paths: { deny: ["secrets/**"] },
        blocked_commands: [
          { pattern: "\\bterraform\\s+destroy\\b", message: "No destroy" },
        ],
      },
      "/repo",
    );

    expect(policy.protectedPaths.deny).toEqual(
      expect.arrayContaining([".env", "bulkhead.yaml", "secrets/**"]),
    );
    expect(policy.blockedCommands.map((rule) => rule.pattern)).toEqual(
      expect.arrayContaining([
        "\\bDROP\\s+TABLE\\b",
        "\\bterraform\\s+destroy\\b",
      ]),
    );
  });

  it("does not let allow rules exempt the policy or evidence state", () => {
    const policy = defaultPolicy("/repo");
    policy.protectedPaths.allow = ["bulkhead.yaml", ".bulkhead/**"];

    expect(protectedPathsGuard(write("/repo/bulkhead.yaml"), policy).action).toBe("deny");
    expect(
      protectedPathsGuard(write("/repo/.bulkhead/ledger.jsonl"), policy).action,
    ).toBe("deny");
  });

  it("preserves exact allow exceptions for non-immutable project paths", () => {
    const policy = defaultPolicy("/repo");
    policy.protectedPaths.allow = ["prod/README.md"];

    expect(protectedPathsGuard(write("/repo/prod/README.md"), policy).action).toBe(
      "allow",
    );
    expect(protectedPathsGuard(write("/repo/prod/secrets.yaml"), policy).action).toBe(
      "deny",
    );
  });

  it("checks a canonical immutable target before an allowed symlink alias", () => {
    const repo = tempRepo();
    try {
      writeFileSync(join(repo, "bulkhead.yaml"), "version: 1\n");
      symlinkSync(join(repo, "bulkhead.yaml"), join(repo, "policy-link"));
      const policy = defaultPolicy(repo);
      policy.protectedPaths.allow = ["policy-link"];

      expect(protectedPathsGuard(write(join(repo, "policy-link")), policy).action).toBe(
        "deny",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("structured file-tool workspace containment", () => {
  const toolShapes: Array<[string, (path: string) => ToolCall]> = [
    ["Write", write],
    ["Edit", edit],
    ["MultiEdit", multiEdit],
    ["NotebookEdit", notebook],
  ];

  for (const [name, callFor] of toolShapes) {
    it(`denies ${name} targeting an absolute path outside the workspace`, () => {
      const repo = tempRepo();
      const outside = mkdtempSync(join(tmpdir(), "bulkhead-outside-"));
      try {
        const verdict = protectedPathsGuard(
          callFor(join(outside, "owned.txt")),
          defaultPolicy(repo),
        );
        expect(verdict.action).toBe("deny");
        expect(verdict.rule).toBe("structured-write-outside-workspace");
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }

  it("denies a relative parent-directory escape", () => {
    const repo = tempRepo();
    try {
      const verdict = protectedPathsGuard(write("../outside.txt"), defaultPolicy(repo));
      expect(verdict.action).toBe("deny");
      expect(verdict.rule).toBe("structured-write-outside-workspace");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("denies a path that is lexical-inside but resolves through a symlink outside", () => {
    const repo = tempRepo();
    const outside = mkdtempSync(join(tmpdir(), "bulkhead-outside-"));
    try {
      symlinkSync(outside, join(repo, "escape"));
      const verdict = protectedPathsGuard(
        write(join(repo, "escape", "owned.txt")),
        defaultPolicy(repo),
      );
      expect(verdict.action).toBe("deny");
      expect(verdict.rule).toBe("structured-write-outside-workspace");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("cannot move the workspace boundary through workspace_root policy input", () => {
    const repo = tempRepo();
    const outside = mkdtempSync(join(tmpdir(), "bulkhead-outside-"));
    try {
      const policy = normalizePolicy({ workspace_root: outside }, repo);
      expect(policy.workspaceRoot).toBe(repo);
      expect(
        protectedPathsGuard(write(join(outside, "owned.txt")), policy).action,
      ).toBe("deny");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows an ordinary structured write inside the canonical workspace", () => {
    const repo = tempRepo();
    try {
      expect(
        protectedPathsGuard(write(join(repo, "src", "index.ts")), defaultPolicy(repo))
          .action,
      ).toBe("allow");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
