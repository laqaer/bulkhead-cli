import {
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Raised when a cross-process state lock remains held past the bounded wait.
 *
 * This carries an errno-like code so guardStateDir can convert it into the same
 * explicit fail-closed decision as other state-substrate availability failures.
 */
export class FileLockTimeoutError extends Error {
  readonly code = "ELOCKTIMEOUT";
  readonly lockPath: string;
  readonly timeoutMs: number;

  constructor(lockPath: string, timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms waiting for Bulkhead state lock \`${lockPath}\`. ` +
        "The protected update was not executed without the lock.",
    );
    this.name = "FileLockTimeoutError";
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Cross-process critical section for the hot path.
 *
 * Claude Code runs tool calls in parallel, and each fires a PreToolUse hook as a
 * separate Node process. Several of those processes touch the same files (the
 * ledger, the daily-spend rollup), so an unlocked read-modify-write races: two
 * processes read the same tail and both append, forking the hash chain.
 *
 * The lock uses an `wx` (O_EXCL) lockfile with bounded spin-wait and stale-lock
 * recovery. If the lock cannot be acquired before the timeout, the operation is
 * NOT executed: a missing state update is recoverable and visible, while an
 * unlocked hash-chain append permanently poisons ledger integrity. PreToolUse
 * and Stop callers wrap this through guardStateDir and therefore fail closed.
 */
export function withFileLock<T>(
  lockPath: string,
  fn: () => T,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): T {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const staleMs = opts.staleMs ?? 5000;
  const start = Date.now();
  mkdirSync(dirname(lockPath), { recursive: true });

  let fd: number | undefined;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Reclaim a lock left behind by a crashed/killed hook process.
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          try { unlinkSync(lockPath); } catch { /* someone else took it */ }
          continue;
        }
      } catch { /* lock vanished; retry */ }
      if (Date.now() - start > timeoutMs) {
        throw new FileLockTimeoutError(lockPath, timeoutMs);
      }
      sleepSync(15);
    }
  }

  try {
    return fn();
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

/**
 * Atomic write via a per-process-unique temp file + rename. A constant temp
 * name would collide across concurrent hook processes (one's rename ENOENTs
 * after another consumed the shared temp); the pid + counter suffix makes each
 * writer's temp file its own.
 */
export function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = uniqueTmpPath(path);
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

let tmpCounter = 0;
export function uniqueTmpPath(path: string): string {
  tmpCounter += 1;
  return `${path}.${process.pid}.${tmpCounter}.tmp`;
}

/** Block the current thread for `ms` without a busy loop (Atomics-based). */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}
