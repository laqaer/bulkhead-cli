import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bulkheadDir, policyPath } from "./paths.js";
import { DEFAULT_POLICY_YAML, GITIGNORE_LINE } from "./templates.js";

/** Tools that can cause damage or that we want in the loop/budget accounting. */
export const DEFAULT_PRE_MATCHER = "*";
export const DEFAULT_POST_MATCHER = "*";

export interface InitOptions {
  /**
   * Base command Claude Code will run for each hook; " pre" / " post" is
   * appended. Defaults to invoking the published CLI via npx. Override for
   * local development to point at the built binary.
   */
  hookCommand?: string;
  /** Overwrite an existing bulkhead.yaml. Default: keep the user's file. */
  force?: boolean;
}

export interface InitResult {
  repoRoot: string;
  policyCreated: boolean;
  settingsPath: string;
  settingsUpdated: boolean;
  gitignoreUpdated: boolean;
}

interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
}
interface HookMatcher {
  /** Omitted for events that don't match on tools (Stop). */
  matcher?: string;
  hooks: HookCommand[];
  /** Marks a matcher entry that Bulkhead owns, so re-init replaces it cleanly. */
  bulkhead?: boolean;
}

// Legacy signal for hooks installed before matchers carried the `bulkhead: true`
// marker. Deliberately specific (the published package spec) so we never strip a
// user's own hook that merely references a path or script containing "bulkhead"
// (e.g. `node /Users/me/bulkhead-tools/lint.js`).
const LEGACY_COMMAND_MARKER = "@bulkhead/cli";

export function runInit(repoRoot: string, opts: InitOptions = {}): InitResult {
  const base = opts.hookCommand ?? "npx --yes @bulkhead/cli hook";

  // 1. Policy file.
  const pPath = policyPath(repoRoot);
  let policyCreated = false;
  if (!existsSync(pPath) || opts.force) {
    writeFileSync(pPath, DEFAULT_POLICY_YAML);
    policyCreated = true;
  }

  // 2. State dir.
  mkdirSync(bulkheadDir(repoRoot), { recursive: true });

  // 3. .gitignore.
  const gitignoreUpdated = ensureGitignore(repoRoot);

  // 4. .claude/settings.json hooks merge.
  const claudeDir = join(repoRoot, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.json");
  const settingsUpdated = mergeSettings(settingsPath, base);

  return {
    repoRoot,
    policyCreated,
    settingsPath,
    settingsUpdated,
    gitignoreUpdated,
  };
}

function ensureGitignore(repoRoot: string): boolean {
  const path = join(repoRoot, ".gitignore");
  let content = "";
  if (existsSync(path)) content = readFileSync(path, "utf8");
  const lines = content.split("\n").map((l) => l.trim());
  if (lines.includes(GITIGNORE_LINE)) return false;
  const next = content.endsWith("\n") || content === "" ? content : content + "\n";
  writeFileSync(path, next + GITIGNORE_LINE + "\n");
  return true;
}

/**
 * Merge Bulkhead's PreToolUse/PostToolUse hooks into settings.json. Idempotent:
 * any existing bulkhead entries (identified by the command containing
 * "bulkhead") are removed first, so re-running init never duplicates them and
 * always upgrades the command to the current one.
 */
export function mergeSettings(settingsPath: string, base: string): boolean {
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    // An unparseable settings.json must ABORT, not be replaced with {} — that
    // would silently destroy the user's model choice, permissions, and any
    // other hooks the moment they run init with a stray trailing comma.
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `${settingsPath} exists but is not valid JSON (${String(err)}). ` +
          `Fix or remove it, then re-run bulkhead init — refusing to overwrite your settings.`,
      );
    }
  }

  const hooks = (settings.hooks && typeof settings.hooks === "object"
    ? (settings.hooks as Record<string, unknown>)
    : {}) as Record<string, HookMatcher[]>;

  const pre = stripBulkhead(asMatcherArray(hooks.PreToolUse));
  pre.push({
    matcher: DEFAULT_PRE_MATCHER,
    bulkhead: true,
    hooks: [{ type: "command", command: `${base} pre`, timeout: 10 }],
  });

  const post = stripBulkhead(asMatcherArray(hooks.PostToolUse));
  post.push({
    matcher: DEFAULT_POST_MATCHER,
    bulkhead: true,
    hooks: [{ type: "command", command: `${base} post`, timeout: 10 }],
  });

  // Stop hooks match on the event itself, not a tool — no matcher.
  const stop = stripBulkhead(asMatcherArray(hooks.Stop));
  stop.push({
    bulkhead: true,
    hooks: [{ type: "command", command: `${base} stop`, timeout: 10 }],
  });

  const nextHooks = { ...hooks, PreToolUse: pre, PostToolUse: post, Stop: stop };
  const next = { ...settings, hooks: nextHooks };
  writeFileSync(settingsPath, JSON.stringify(next, null, 2) + "\n");
  return true;
}

function asMatcherArray(v: unknown): HookMatcher[] {
  return Array.isArray(v) ? (v as HookMatcher[]) : [];
}

/**
 * Remove any Bulkhead-owned matcher so re-init never duplicates it. A matcher is
 * ours if it carries the `bulkhead: true` marker (the reliable signal) or — for
 * entries written by older versions that predate the marker — if one of its
 * commands references the published CLI spec `@bulkhead/cli`. We do NOT strip on
 * the bare word "bulkhead", so a user's own hook that points at a script or
 * directory named "bulkhead" is never silently deleted.
 */
function stripBulkhead(matchers: HookMatcher[]): HookMatcher[] {
  return matchers
    .filter((m) => m.bulkhead !== true)
    .map((m) => ({
      ...m,
      hooks: (m.hooks ?? []).filter(
        (h) => !(typeof h.command === "string" && h.command.includes(LEGACY_COMMAND_MARKER)),
      ),
    }))
    .filter((m) => m.hooks.length > 0);
}
