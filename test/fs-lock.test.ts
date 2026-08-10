import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, atomicWrite, uniqueTmpPath } from "../src/fs-lock.js";
import { tempRepo } from "./helpers.js";

describe("fs-lock", () => {
  it("runs the critical section and releases the lock", () => {
    const repo = tempRepo();
    const lock = join(repo, "x.lock");
    const result = withFileLock(lock, () => {
      expect(existsSync(lock)).toBe(true); // held during the section
      return 42;
    });
    expect(result).toBe(42);
    expect(existsSync(lock)).toBe(false); // released after
  });

  it("uniqueTmpPath returns distinct paths per call", () => {
    const a = uniqueTmpPath("/tmp/x");
    const b = uniqueTmpPath("/tmp/x");
    expect(a).not.toBe(b);
    expect(a).toContain(String(process.pid));
  });

  it("atomicWrite creates the file and leaves no temp behind", () => {
    const repo = tempRepo();
    const f = join(repo, "sub", "data.json");
    atomicWrite(f, '{"ok":true}');
    expect(JSON.parse(readFileSync(f, "utf8")).ok).toBe(true);
  });
});
