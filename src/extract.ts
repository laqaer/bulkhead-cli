import { isAbsolute, resolve } from "node:path";
import type { ToolCall } from "./types.js";

/**
 * File-writing / editing tools whose target path we can read structurally.
 * These are the tools where protected-path enforcement is reliable — the path
 * is a named field, not buried in a shell string.
 */
const FILE_WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

const BASH_TOOLS = new Set(["Bash", "BashOutput"]);

export function isFileWriteTool(toolName: string): boolean {
  return FILE_WRITE_TOOLS.has(toolName);
}

export function isBashTool(toolName: string): boolean {
  return BASH_TOOLS.has(toolName);
}

/**
 * Pull the target file path(s) from a structured file tool's input. Returns
 * absolute paths resolved against `cwd`. Unknown shapes yield an empty list —
 * we never guess.
 */
export function targetPaths(call: ToolCall, cwd: string): string[] {
  const input = call.toolInput ?? {};
  const raw: string[] = [];
  const fp = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path;
  if (typeof fp === "string") raw.push(fp);
  // Some tools accept a list of edits each with their own path.
  const edits = input.edits;
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (e && typeof e === "object") {
        const ep = (e as Record<string, unknown>).file_path;
        if (typeof ep === "string") raw.push(ep);
      }
    }
  }
  return raw.map((p) => (isAbsolute(p) ? resolve(p) : resolve(cwd, p)));
}

/** The Bash command string, or undefined if this isn't a command tool call. */
export function commandString(call: ToolCall): string | undefined {
  const c = call.toolInput?.command;
  return typeof c === "string" ? c : undefined;
}

/**
 * Extract candidate filesystem targets from an `rm` invocation for
 * workspace-boundary checking. This is a best-effort tokenizer, not a shell
 * parser — it handles the common shapes (`rm -rf foo bar`, quoted paths) and is
 * deliberately conservative: anything it can't classify as a flag is treated as
 * a target. It does NOT try to defeat obfuscation (that's a documented
 * limitation — hooks are containment, not a sandbox).
 */
export function rmTargets(command: string): string[] | null {
  // Only consider commands that actually call rm as a word.
  if (!/\brm\b/.test(command)) return null;
  const targets: string[] = [];
  // Split on shell separators to inspect each simple command segment.
  const segments = command.split(/(?:&&|\|\||;|\|)/);
  for (const seg of segments) {
    const tokens = tokenize(seg);
    const rmIdx = tokens.findIndex((t) => t === "rm" || t.endsWith("/rm"));
    if (rmIdx === -1) continue;
    for (const tok of tokens.slice(rmIdx + 1)) {
      if (tok.startsWith("-")) continue; // flag
      targets.push(tok);
    }
  }
  return targets;
}

/**
 * Parse each `git push` in a command into its flags and positional args
 * (remote + refspecs), across `&&`/`||`/`;`/`|`-separated segments. Order-
 * independent, so it catches both `git push --force origin main` and
 * `git push origin main --force`. Best-effort tokenizer, not a shell parser.
 */
export function gitPushInvocations(
  command: string,
): Array<{ flags: string[]; positionals: string[] }> {
  const out: Array<{ flags: string[]; positionals: string[] }> = [];
  for (const seg of command.split(/(?:&&|\|\||;|\|)/)) {
    const tokens = tokenize(seg);
    const gi = tokens.findIndex(
      (t, i) => (t === "git" || t.endsWith("/git")) && tokens[i + 1] === "push",
    );
    if (gi === -1) continue;
    const rest = tokens.slice(gi + 2);
    out.push({
      flags: rest.filter((t) => t.startsWith("-")),
      positionals: rest.filter((t) => !t.startsWith("-")),
    });
  }
  return out;
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out.filter((t) => t.length > 0);
}
