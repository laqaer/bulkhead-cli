import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileLockTimeoutError, withFileLock } from "../src/fs-lock.js";
import {
  StateDirUnavailableError,
  guardStateDir,
} from "../src/state-dir.js";
import { bulkheadDir } from "../src/paths.js";
import { tempRepo } from "./helpers.js";

describe("state lock timeout", () => {
  it("is classified as an explicit fail-closed state-substrate failure", () => {
    const repo = tempRepo();
    const dir = bulkheadDir(repo);
    const lock = join(dir, "ledger.jsonl.lock");
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, "held by another hook");

    let caught: unknown;
    try {
      guardStateDir(dir, () =>
        withFileLock(
          lock,
          () => {
            throw new Error("critical section must not run");
          },
          { timeoutMs: 25, staleMs: 60_000 },
        ),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StateDirUnavailableError);
    expect((caught as StateDirUnavailableError).fsCode).toBe("ELOCKTIMEOUT");
    expect((caught as Error).message).toContain("competing Bulkhead hook");
    expect((caught as Error).cause).toBeInstanceOf(FileLockTimeoutError);
  });
});
