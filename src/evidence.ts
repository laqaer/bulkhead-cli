import type { Evidence } from "./types.js";
import { isFileWriteTool } from "./extract.js";

/**
 * Classify a completed tool call into typed evidence, deterministically.
 *
 * This is the raw material for completion verification: "the agent said the
 * tests pass — did a test command actually run, and did it exit 0?"
 *
 * Two rules keep this honest (both learned from confirmed false-positives):
 *
 * 1. COMMAND POSITION ONLY. A runner name is a signal only when it is the thing
 *    being executed — `pnpm test`, `npx vitest` — never when it appears inside
 *    arguments or quotes (`grep "pytest" README.md`, `tail vitest.log`,
 *    `git commit -m "fix vitest timeout"` are NOT test runs).
 * 2. STRONG SIGNALS ONLY for outcomes. Exit codes and unambiguous summaries
 *    decide pass/fail; an interrupted run or ambiguous output is recorded as
 *    `test_run` (undetermined) rather than guessed. Bare "error" substrings and
 *    per-test ✓ ticks are deliberately not signals.
 */
export function classifyEvidence(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: unknown,
): Evidence[] {
  if (toolName === "Write") {
    const p = pathOf(toolInput);
    return p ? [{ type: "file_created", detail: p }] : [];
  }
  if (isFileWriteTool(toolName)) {
    const p = pathOf(toolInput);
    return p ? [{ type: "file_modified", detail: p }] : [];
  }
  if (toolName === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    if (!command) return [];
    return classifyBash(command, toolResponse);
  }
  return [];
}

function pathOf(toolInput: Record<string, unknown>): string | undefined {
  const p = toolInput.file_path ?? toolInput.filePath ?? toolInput.path ?? toolInput.notebook_path;
  return typeof p === "string" && p.length > 0 ? p : undefined;
}

// ---------------------------------------------------------------------------
// Command-position parsing
// ---------------------------------------------------------------------------

interface CommandSegment {
  /** Executable basename (`./node_modules/.bin/vitest` -> `vitest`). */
  bin: string;
  /** Following tokens, quotes stripped, env-var prefixes skipped. */
  args: string[];
}

/**
 * Best-effort split of a shell command into simple-command segments, with
 * quoted strings REMOVED first so their contents can never look like a
 * command. Not a shell parser; good enough to decide "what is being run".
 */
export function commandSegments(command: string): CommandSegment[] {
  const noQuotes = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, " ");
  const out: CommandSegment[] = [];
  // Newlines are ordinary command separators — agents routinely batch shell
  // work as a multi-line string, so a risky action on line 2 must still be seen.
  // (Quoted multi-line content was already removed above.)
  for (const raw of noQuotes.split(/&&|\|\||;|\n|\|/)) {
    let tokens = raw.trim().split(/\s+/).filter(Boolean);
    // Skip env-var assignments and transparent wrappers.
    while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
    while (tokens[0] && ["time", "command", "sudo"].includes(tokens[0])) tokens = tokens.slice(1);
    const first = tokens[0];
    if (!first) continue;
    out.push({ bin: first.split("/").pop() ?? first, args: tokens.slice(1) });
  }
  return out;
}

const DIRECT_RUNNERS = new Set(["vitest", "jest", "pytest", "mocha", "rspec", "phpunit", "ctest"]);
const PKG_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Is any segment of this command actually invoking a test runner? */
export function isTestInvocation(command: string): boolean {
  for (const seg of commandSegments(command)) {
    const args = seg.args;
    const positional = args.filter((a) => !a.startsWith("-"));
    if (DIRECT_RUNNERS.has(seg.bin)) return true;
    if (seg.bin === "playwright" && positional[0] === "test") return true;
    if (seg.bin === "cypress" && positional[0] === "run") return true;
    if ((seg.bin === "go" || seg.bin === "cargo" || seg.bin === "swift") && positional[0] === "test") return true;
    if (seg.bin === "make" && positional.includes("test")) return true;
    if (seg.bin === "python" || seg.bin === "python3") {
      const mi = args.indexOf("-m");
      if (mi !== -1 && (args[mi + 1] === "pytest" || args[mi + 1] === "unittest")) return true;
    }
    if (seg.bin === "npx" && DIRECT_RUNNERS.has(positional[0] ?? "")) return true;
    if (PKG_MANAGERS.has(seg.bin)) {
      if (positional[0] === "exec" && DIRECT_RUNNERS.has(positional[1] ?? "")) return true;
      // npm test / pnpm run test:unit / yarn test — a script named test[:*].
      if (positional.some((a) => /^test(:[\w-]+)?$/.test(a))) return true;
    }
  }
  return false;
}

function invokes(command: string, bin: string, ...subcommand: string[]): boolean {
  return commandSegments(command).some((seg) => {
    if (seg.bin !== bin) return false;
    const positional = seg.args.filter((a) => !a.startsWith("-"));
    return subcommand.every((word, i) => positional[i] === word);
  });
}

// ---------------------------------------------------------------------------
// Outcome signals
// ---------------------------------------------------------------------------

// Counts must be nonzero ("0 failed" is a PASS summary), and the bare
// FAIL/PASS banners are case-sensitive on purpose — the word "fail" in prose is
// not a signal. Per-test ✓ ticks are NOT a pass signal (they appear long before
// an interrupted run would have finished); a ✗/✘ does indicate ≥1 real failure.
const FAIL_PHRASES =
  /\b[1-9]\d*\s+fail(ed|ing|ures?)?\b|\btests?\s+failed\b|✗|✘/i;
const FAIL_BANNER = /(^|\s)FAIL(ED)?(\s|:|$)/m;
const TRACEBACK = /Traceback \(most recent call last\)/;
const PASS_PHRASES =
  /\b[1-9]\d*\s+pass(ed|ing)?\b|\ball tests? passed\b|\btests?\s+passed\b|\btest result: ok\b/i;
const PASS_BANNER = /(^|\s)PASS(ED)?(\s|:|$)/m;

function looksFailed(out: string): boolean {
  return FAIL_PHRASES.test(out) || FAIL_BANNER.test(out);
}
function looksPassed(out: string): boolean {
  return PASS_PHRASES.test(out) || PASS_BANNER.test(out);
}

function classifyBash(command: string, response: unknown): Evidence[] {
  const out = responseText(response);
  const exit = exitCodeOf(response);
  const interrupted = interruptedOf(response);
  const evidence: Evidence[] = [];

  if (invokes(command, "git", "commit")) {
    // Success requires proof: exit 0, or (when the host gives no exit code)
    // git's own success signature in the output. A husky rejection or "nothing
    // to commit" must not mint commit evidence.
    const signature = out.match(/\[[\w\/.@-]+\s+[0-9a-f]{6,}\]\s+(.+)/);
    if (exit === 0 || (exit === undefined && signature)) {
      const fromFlag = command.match(/-m\s+["']([^"']+)["']/);
      evidence.push({
        type: "commit_created",
        detail: truncate(signature?.[1] ?? fromFlag?.[1] ?? "commit created"),
      });
    }
  }

  if (invokes(command, "gh", "pr", "create")) {
    const url = out.match(/https:\/\/github\.com\/\S+\/pull\/\d+/);
    const alreadyExists = /already exists/i.test(out);
    // gh prints an existing PR's URL in its failure message — that is not a
    // PR created by this command.
    if (url && !alreadyExists && (exit === undefined || exit === 0)) {
      evidence.push({ type: "pr_created", detail: url[0] });
    } else if (!url && exit === 0) {
      evidence.push({ type: "pr_created", detail: "PR created (URL not captured)" });
    }
  }

  if (isTestInvocation(command)) {
    const tail = truncate(out.slice(-400), 400); // summaries live at the end
    if (interrupted) {
      // The run never finished; the unexecuted remainder may fail. Never guess.
      evidence.push({ type: "test_run", detail: truncate(`${command} (interrupted before completion)`) });
    } else if (exit !== undefined) {
      evidence.push({
        type: exit === 0 ? "test_passed" : "test_failed",
        detail: truncate(`${command} (exit ${exit}) ${tail}`),
      });
    } else if (looksFailed(out)) {
      evidence.push({ type: "test_failed", detail: truncate(`${command} ${tail}`) });
    } else if (looksPassed(out)) {
      // A pass summary outranks an incidental traceback (pytest -s / log_cli
      // legitimately print tracebacks from passing error-path tests).
      evidence.push({ type: "test_passed", detail: truncate(`${command} ${tail}`) });
    } else if (TRACEBACK.test(out)) {
      evidence.push({ type: "test_failed", detail: truncate(`${command} ${tail}`) });
    } else {
      evidence.push({ type: "test_run", detail: truncate(`${command} (outcome undetermined)`) });
    }
  }

  return evidence;
}

// ---------------------------------------------------------------------------
// Response-shape helpers
// ---------------------------------------------------------------------------

/** Pull readable text out of whatever shape the host's tool_response takes. */
export function responseText(response: unknown): string {
  if (response == null) return "";
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return response.map(responseText).join("\n");
  if (typeof response === "object") {
    const o = response as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["stdout", "stderr", "output", "text", "content", "result"]) {
      const v = o[key];
      if (typeof v === "string") parts.push(v);
      else if (Array.isArray(v) || (v && typeof v === "object")) parts.push(responseText(v));
    }
    if (parts.length > 0) return parts.join("\n");
    try {
      return JSON.stringify(o).slice(0, 2000);
    } catch {
      return "";
    }
  }
  return String(response);
}

/** Find an exit code field if the host provides one. */
export function exitCodeOf(response: unknown): number | undefined {
  if (!response || typeof response !== "object") return undefined;
  const o = response as Record<string, unknown>;
  for (const key of ["exit_code", "exitCode", "code", "returnCode", "returncode", "status"]) {
    const v = o[key];
    if (typeof v === "number" && Number.isInteger(v)) return v;
  }
  return undefined;
}

/** Claude Code's Bash response carries `interrupted` when the command was cut off. */
export function interruptedOf(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  return (response as Record<string, unknown>).interrupted === true;
}

function truncate(s: string, max = 300): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}
