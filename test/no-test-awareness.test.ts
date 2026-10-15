import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bulkhead must behave the same whether or not it is being measured. An open
 * case set may mark its runs with environment variables; a guard that read
 * them could special-case a benchmark. Nothing in src/ may mention the case
 * set or its markers — this pins the no-special-casing rule for Bulkhead first.
 *
 * The name is assembled from two pieces so that this file, which is mirrored
 * byte-for-byte, does not itself spell it out.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const NAME = new RegExp(["guard", "cases"].join(""), "i");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

describe("no test-awareness", () => {
  it("src/ never references a benchmark marker or the case set", () => {
    const hits = files(SRC).filter((f) => NAME.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
