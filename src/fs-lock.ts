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
 * Cross-process critical section for the hot path.
 *
 * Claude Code runs tool calls in parallel, and each fires a PreToolUse hook as a
 * separate Node process. Several of those processes touch the same files (the
 * ledger, the daily-spend rollup), so an unlocked read-modify-write races: two
 * processes read the same tail and both append, forking the hash chain. This
 * takes a best-effort exclusive lock via an `wx` (O_EXCL) lockfile with bounded
 * spin-wait and stale-lock recovery. It never deadlocks the hook: if the lock
 * can't be acquired within the timeout it proceeds anyway (a rare, logged
 * degradation is better than freezing the user's agent).
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
        // Give up on the lock rather than block the agent. Proceed unlocked.
        return fn();
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
