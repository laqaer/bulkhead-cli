import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Locate the repo root by walking up from a starting directory looking for a
 * `bulkhead.yaml`, then `.git`, then falling back to the start. Hooks run with
 * `cwd` set to wherever Claude Code was launched, which is usually — but not
 * always — the repo root, so we anchor on the policy file first.
 */
export function findRepoRoot(startDir: string): string {
  let dir = resolve(startDir);
  // Prefer the directory that actually holds a policy file.
  for (let cur = dir; ; ) {
    if (existsSync(join(cur, "bulkhead.yaml"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (let cur = dir; ; ) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dir;
}

/** All Bulkhead state lives here, under the repo root, and is gitignored. */
export function bulkheadDir(repoRoot: string): string {
  return join(repoRoot, ".bulkhead");
}

export function ledgerPath(repoRoot: string): string {
  return join(bulkheadDir(repoRoot), "ledger.jsonl");
}

export function loopStatePath(repoRoot: string): string {
  return join(bulkheadDir(repoRoot), "loop-state.json");
}

export function spendDir(repoRoot: string): string {
  return join(bulkheadDir(repoRoot), "spend");
}

export function policyPath(repoRoot: string): string {
  return join(repoRoot, "bulkhead.yaml");
}
