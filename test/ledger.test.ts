import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { appendLedger, readLedger, readLedgerWithStats, verifyLedger } from "../src/ledger.js";
import { ledgerPath } from "../src/paths.js";
import { tempRepo } from "./helpers.js";

describe("ledger hash chain", () => {
  it("links entries and verifies", () => {
    const repo = tempRepo();
    appendLedger(repo, { ts: "t0", sessionId: "s", event: "pre", toolName: "Bash", action: "allow" });
    appendLedger(repo, { ts: "t1", sessionId: "s", event: "pre", toolName: "Write", action: "deny", guard: "protected-paths" });
    const entries = readLedger(repo);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.prevHash).toBe("GENESIS");
    expect(entries[1]!.prevHash).toBe(entries[0]!.hash);
    expect(verifyLedger(entries).ok).toBe(true);
  });

  it("detects a modified entry", () => {
    const repo = tempRepo();
    appendLedger(repo, { ts: "t0", sessionId: "s", event: "pre", action: "allow" });
    appendLedger(repo, { ts: "t1", sessionId: "s", event: "pre", action: "deny", reason: "blocked" });
    const entries = readLedger(repo);
    // Tamper: soften a denial reason but keep the stored hash.
    entries[1]!.reason = "allowed";
    const result = verifyLedger(entries);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(2);
  });

  it("detects a removed (truncated-from-middle) entry", () => {
    const repo = tempRepo();
    for (let i = 0; i < 3; i++) {
      appendLedger(repo, { ts: `t${i}`, sessionId: "s", event: "pre", action: "allow" });
    }
    const entries = readLedger(repo);
    entries.splice(1, 1); // drop the middle entry
    expect(verifyLedger(entries).ok).toBe(false);
  });

  it("detects a hand-edited raw file", () => {
    const repo = tempRepo();
    appendLedger(repo, { ts: "t0", sessionId: "s", event: "pre", action: "deny", reason: "no" });
    const path = ledgerPath(repo);
    const tampered = JSON.stringify({
      seq: 0,
      ts: "t0",
      sessionId: "s",
      event: "pre",
      action: "allow",
      prevHash: "GENESIS",
      hash: "deadbeef",
    });
    writeFileSync(path, tampered + "\n");
    expect(verifyLedger(readLedger(repo)).ok).toBe(false);
  });

  it("an empty ledger is valid", () => {
    const repo = tempRepo();
    expect(verifyLedger(readLedger(repo)).ok).toBe(true);
  });

  it("tolerates a torn line and keeps appending (does not throw)", () => {
    const repo = tempRepo();
    appendLedger(repo, { ts: "t0", sessionId: "s", event: "pre", action: "allow" });
    // Simulate a killed hook that half-wrote its line.
    const path = ledgerPath(repo);
    const { appendFileSync } = require("node:fs");
    appendFileSync(path, '{"ts":"t1","seq":1,'); // no newline, truncated JSON
    // readLedger must not throw on the torn line...
    expect(() => readLedger(repo)).not.toThrow();
    // ...and a fresh append must still succeed (self-heal), not brick the session.
    expect(() => appendLedger(repo, { ts: "t2", sessionId: "s", event: "pre", action: "deny" })).not.toThrow();
    const entries = readLedger(repo);
    expect(entries.some((e) => e.action === "deny")).toBe(true);
  });

  it("many sequential appends produce a contiguous, verifiable chain", () => {
    const repo = tempRepo();
    for (let i = 0; i < 25; i++) {
      appendLedger(repo, { ts: `t${i}`, sessionId: "s", event: "pre", action: "allow" });
    }
    const result = verifyLedger(readLedger(repo));
    expect(result.ok).toBe(true);
    expect(result.count).toBe(25);
  });

  it("reports skipped unparseable lines via readLedgerWithStats", () => {
    const repo = tempRepo();
    appendLedger(repo, { ts: "t0", sessionId: "s", event: "pre", action: "allow" });
    appendLedger(repo, { ts: "t1", sessionId: "s", event: "pre", action: "deny" });
    const path = ledgerPath(repo);
    // Corrupt the last line in place (drop its closing chars) — a truncation
    // that leaves partial JSON behind must be surfaced, not silently ignored.
    const raw = readFileSync(path, "utf8");
    const lines = raw.trimEnd().split("\n");
    lines[lines.length - 1] = lines[lines.length - 1]!.slice(0, -20);
    writeFileSync(path, lines.join("\n") + "\n");
    const stats = readLedgerWithStats(repo);
    expect(stats.skippedLines).toBe(1);
    expect(stats.entries).toHaveLength(1);
    expect(verifyLedger(stats.entries).ok).toBe(true);
  });

  it("DOCUMENTED LIMITATION: cleanly truncating trailing entries still verifies", () => {
    // A bare hash chain cannot prove the tail wasn't removed. This test pins
    // the honest behavior so the README/CLI wording never drifts back into an
    // overclaim: if this ever starts failing, we gained tail detection — update
    // the copy to match.
    const repo = tempRepo();
    for (let i = 0; i < 3; i++) {
      appendLedger(repo, { ts: `t${i}`, sessionId: "s", event: "pre", action: "allow" });
    }
    const path = ledgerPath(repo);
    const firstTwoLines = readFileSync(path, "utf8").trimEnd().split("\n").slice(0, 2);
    writeFileSync(path, firstTwoLines.join("\n") + "\n");
    const stats = readLedgerWithStats(repo);
    expect(stats.skippedLines).toBe(0); // clean truncation leaves no residue
    const result = verifyLedger(stats.entries);
    expect(result.ok).toBe(true); // the prefix verifies — that is the limitation
    expect(result.count).toBe(2);
  });
});
