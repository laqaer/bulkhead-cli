import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, rmSync, symlinkSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRealCandidate } from "../src/guards/protected-paths.js";
import { tempRepo } from "./helpers.js";

// Pins the internals of the F1 fix: the deepest-existing-ancestor resolver.
// The guard-level behaviour lives in guards.test.ts; this file exists so a
// regression in the resolution mechanics (not just its observable verdicts)
// fails loudly.

const repo = tempRepo();
const cleanup = () => rmSync(repo, { recursive: true, force: true });
afterAll(cleanup);

/** Idempotent fixture pieces shared by several cases below. */
function ensureFixture(): void {
  mkdirSync(join(repo, "prod"), { recursive: true });
  mkdirSync(join(repo, "realsrc"), { recursive: true });
  writeFileSync(join(repo, ".env"), "S=1");
  symlinkIfMissing("prod", "gate");
  symlinkIfMissing(".env", "settings.conf");
}

function symlinkIfMissing(target: string, linkPath: string): void {
  try {
    symlinkSync(join(repo, target), join(repo, linkPath));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

describe("resolveRealCandidate (F1 internals)", () => {
  it("returns the lexical path unchanged when everything exists as a real dir", () => {
    ensureFixture();
    mkdirSync(join(repo, "plain"), { recursive: true });
    writeFileSync(join(repo, "plain", "a.txt"), "x");
    const p = join(repo, "plain", "a.txt");
    expect(resolveRealCandidate(p)).toBe(realpathSync(p));
  });

  it("resolves an existing symlinked ancestor", () => {
    ensureFixture();
    expect(resolveRealCandidate(join(repo, "gate", "x.txt"))).toBe(
      join(realpathSync(repo), "prod", "x.txt"),
    );
  });

  it("resolves through the deepest EXISTING ancestor and rejoins the missing tail", () => {
    ensureFixture();
    // gate/a/b/c.txt — gate/a does not exist, so resolution must stop at the
    // deepest existing component (gate) and rejoin a/b/c onto its target.
    expect(resolveRealCandidate(join(repo, "gate", "a", "b", "c.txt"))).toBe(
      join(realpathSync(repo), "prod", "a", "b", "c.txt"),
    );
  });

  it("resolves a fully-missing chain to the lexical path under the root", () => {
    ensureFixture();
    // nothing below repo exists — the lexical path IS the best candidate
    const p = join(repo, "nope", "deeper", "f.txt");
    expect(resolveRealCandidate(p)).toBe(join(realpathSync(repo), "nope", "deeper", "f.txt"));
  });

  it("follows a chain of two symlinks", () => {
    ensureFixture();
    symlinkIfMissing("settings.conf", "twice.conf");
    expect(resolveRealCandidate(join(repo, "twice.conf"))).toBe(
      join(realpathSync(repo), ".env"),
    );
  });
});
