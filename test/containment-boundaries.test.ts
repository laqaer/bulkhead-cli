import { describe, expect, it } from "vitest";
import {
  linkSync,
  mkdirSync,
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

  it("denies an allowed hard-link alias of the policy file or the evidence ledger", () => {
    // Writing a hard link to bulkhead.yaml rewrites the policy; one to the
    // ledger can truncate its tail, which the hash chain cannot detect.
    const repo = tempRepo();
    try {
      mkdirSync(join(repo, ".bulkhead"));
      writeFileSync(join(repo, "bulkhead.yaml"), "version: 1\n");
      writeFileSync(join(repo, ".bulkhead", "ledger.jsonl"), "{}\n");
      linkSync(join(repo, "bulkhead.yaml"), join(repo, "policy-copy.yaml"));
      linkSync(join(repo, ".bulkhead", "ledger.jsonl"), join(repo, "ledger-copy.jsonl"));
      const policy = defaultPolicy(repo);
      policy.protectedPaths.allow = ["policy-copy.yaml", "ledger-copy.jsonl"];

      const toPolicy = protectedPathsGuard(write(join(repo, "policy-copy.yaml")), policy);
      expect(toPolicy.action).toBe("deny");
      expect(toPolicy.rule).toBe("bulkhead.yaml");
      const toLedger = protectedPathsGuard(write(join(repo, "ledger-copy.jsonl")), policy);
      expect(toLedger.action).toBe("deny");
      expect(toLedger.rule).toBe(".bulkhead/**");
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

  // KNOWN LIMITATION, pinned deliberately: the boundary is path-based, and a
  // hard link has no path relationship to its other names. Proving a file has
  // no name outside the workspace would mean scanning the whole filesystem,
  // so a same-filesystem `ln ~/.zshrc z` then Write `z` reaches the host file.
  // Identity matching covers protected globs, including absolute ones — which
  // is how a user protects specific host files. See README "What it does and
  // doesn't stop". If a boundary identity check lands, flip the first assert.
  it("catches a hard link to a host file only when an absolute deny glob names it", () => {
    const repo = tempRepo();
    const outside = mkdtempSync(join(tmpdir(), "bulkhead-outside-"));
    try {
      writeFileSync(join(outside, "id_key"), "secret");
      linkSync(join(outside, "id_key"), join(repo, "key-copy"));
      const policy = defaultPolicy(repo);
      expect(protectedPathsGuard(write(join(repo, "key-copy")), policy).action).toBe("allow");

      policy.protectedPaths.deny = [...policy.protectedPaths.deny, `${outside}/**`];
      const verdict = protectedPathsGuard(write(join(repo, "key-copy")), policy);
      expect(verdict.action).toBe("deny");
      expect(verdict.rule).toBe(`${outside}/**`);
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
