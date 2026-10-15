import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDemo, summaryLine } from "../src/demo.js";

/**
 * The README quotes the last line of `bulkhead demo`. It is typed by hand, and
 * every corpus change moves it, so pin it to the real output: a stale README is
 * a claim the engine no longer backs.
 */
const README = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md");

describe("README demo line", () => {
  it("matches the summary line `bulkhead demo` prints", () => {
    const quoted = readFileSync(README, "utf8")
      .split("\n")
      .filter((line) => /dangerous calls denied · .*ledger verified \(\d+ entries\)/.test(line));
    expect(quoted, "the README quotes the demo summary exactly once").toHaveLength(1);
    expect(quoted[0]).toBe(summaryLine(runDemo({ version: "test" })));
  });
});
