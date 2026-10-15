import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bulkheadDir, policyPath } from "./paths.js";
import {
  GITIGNORE_LINE,
  POLICY_PRESETS,
  isPolicyPreset,
  policyTemplate,
  type PolicyPreset,
} from "./templates.js";

export { POLICY_PRESETS, isPolicyPreset, type PolicyPreset };

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
  /**
   * Which policy file to write: `default` (conservative) or `strict` (adds
   * rules for routine-but-destructive commands, for unattended runs). Only
   * takes effect when the policy file is written — an existing bulkhead.yaml
   * is kept unless `force` is set, preset or not.
   */
  preset?: PolicyPreset;
}

export interface InitResult {
  repoRoot: string;
  /** The preset requested (default when none was given). */
  preset: PolicyPreset;
  /** True when bulkhead.yaml was written from `preset`'s template. */
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

// Legacy signals for hooks installed before matchers carried the `bulkhead: true`
// marker. Each entry is a package spec only our own installer ever writes, so we
// never strip a user's own hook that merely references a path or script
// containing "bulkhead" (e.g. `node /Users/me/bulkhead-tools/lint.js`).
//
// `@bulkhead/cli` is the pre-rename spec: the npm org `bulkhead` was taken, so the
// package ships as `@bulkheadtools/cli`. Anyone who ran `init` while the site
// advertised the install-from-GitHub form has that older spec in their settings,
// and re-init must still recognise and replace it.
const LEGACY_COMMAND_MARKERS = ["@bulkheadtools/cli", "@bulkhead/cli"] as const;

function isLegacyBulkheadCommand(command: unknown): boolean {
  return typeof command === "string" && LEGACY_COMMAND_MARKERS.some((m) => command.includes(m));
}

export function runInit(repoRoot: string, opts: InitOptions = {}): InitResult {
  const base = opts.hookCommand ?? "npx --yes @bulkheadtools/cli hook";
  const preset: unknown = opts.preset ?? "default";
  // Validate before touching the disk: an unknown preset must never fall
  // back to writing some other policy the caller did not ask for.
  if (!isPolicyPreset(preset)) {
    throw new Error(
      `Unknown preset ${JSON.stringify(preset)}. Expected one of: ${POLICY_PRESETS.join(", ")}.`,
    );
  }

  // 1. Policy file. An existing one is the user's and is never replaced
  // without `force` — including when a different preset was requested.
  const pPath = policyPath(repoRoot);
  let policyCreated = false;
  if (!existsSync(pPath) || opts.force) {
    writeFileSync(pPath, policyTemplate(preset));
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
    preset,
    policyCreated,
    settingsPath,
    settingsUpdated,
    gitignoreUpdated,
  };
}

export interface UninstallResult {
  repoRoot: string;
  settingsPath: string;
  /** Bulkhead hook commands removed from settings.json (0 when none were there). */
  hooksRemoved: number;
  /** Left in place on purpose: the user's policy and the evidence ledger. */
  policyKept: boolean;
  stateKept: boolean;
}

/**
 * Remove Bulkhead's hooks from .claude/settings.json and nothing else. Every
 * other hook, permission and setting is kept byte-for-byte in meaning; hook
 * events left empty are dropped. bulkhead.yaml (the user's policy) and
 * .bulkhead/ (the ledger — the evidence) stay: deleting evidence is the
 * human's call, and the CLI says how.
 */
export function runUninstall(repoRoot: string): UninstallResult {
  const settingsPath = join(repoRoot, ".claude", "settings.json");
  const result: UninstallResult = {
    repoRoot,
    settingsPath,
    hooksRemoved: 0,
    policyKept: existsSync(policyPath(repoRoot)),
    stateKept: existsSync(bulkheadDir(repoRoot)),
  };
  if (!existsSync(settingsPath)) return result;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${settingsPath} is not valid JSON (${String(err)}). Fix it, then re-run bulkhead uninstall — refusing to rewrite your settings.`,
    );
  }
  if (!settings.hooks || typeof settings.hooks !== "object") return result;

  const hooks = { ...(settings.hooks as Record<string, unknown>) };
  let removed = 0;
  for (const event of ["PreToolUse", "PostToolUse", "Stop"]) {
    if (!Array.isArray(hooks[event])) continue;
    const before = asMatcherArray(hooks[event]);
    const after = stripBulkhead(before);
    const count = (ms: HookMatcher[]) => ms.reduce((n, m) => n + (m.hooks ?? []).length, 0);
    removed += count(before) - count(after);
    if (after.length === 0) delete hooks[event];
    else hooks[event] = after;
  }
  if (removed === 0) return result;

  const next: Record<string, unknown> = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  writeFileSync(settingsPath, JSON.stringify(next, null, 2) + "\n");
  return { ...result, hooksRemoved: removed };
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
 * commands references a published CLI spec we ship under (`@bulkheadtools/cli`, or
 * the pre-rename `@bulkhead/cli`). We do NOT strip on the bare word "bulkhead", so
 * a user's own hook that points at a script or directory named "bulkhead" is never
 * silently deleted.
 */
function stripBulkhead(matchers: HookMatcher[]): HookMatcher[] {
  return matchers
    .filter((m) => m.bulkhead !== true)
    .map((m) => ({
      ...m,
      hooks: (m.hooks ?? []).filter(
        (h) => !isLegacyBulkheadCommand(h.command),
      ),
    }))
    .filter((m) => m.hooks.length > 0);
}
