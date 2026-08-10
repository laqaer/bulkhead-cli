import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { appendLedger, readLedger, verifyLedger } from "../src/ledger.js";
import { tempRepo } from "./helpers.js";

const LEDGER_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "ledger.js");

/** Append to the ledger from a separate OS process, as parallel hooks do. */
function appendInChildProcess(repo: string, tag: string): Promise<void> {
  const src = `import { appendLedger } from ${JSON.stringify(LEDGER_DIST)};
appendLedger(${JSON.stringify(repo)}, { ts: ${JSON.stringify(tag)}, sessionId: "s", event: "pre", action: "allow" });`;
  return new Promise((res, rej) => {
    const child = spawn("node", ["--input-type=module", "-e", src], { stdio: "ignore" });
    child.on("exit", (code) => (code === 0 ? res() : rej(new Error(`child exited ${code}`))));
    child.on("error", rej);
  });
}

describe("ledger under concurrent processes", () => {
  it("does not fork the hash chain when many hooks append at once", async () => {
    const repo = tempRepo();
    // Seed one entry so children race off a shared tail.
    appendLedger(repo, { ts: "seed", sessionId: "s", event: "pre", action: "allow" });

    const N = 10;
    await Promise.all(Array.from({ length: N }, (_, i) => appendInChildProcess(repo, `c${i}`)));

    const entries = readLedger(repo);
    expect(entries).toHaveLength(N + 1);
    // Contiguous sequence numbers (no duplicate seq => no fork) and intact chain.
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: N + 1 }, (_, i) => i));
    expect(verifyLedger(entries).ok).toBe(true);
  }, 30000);
});
