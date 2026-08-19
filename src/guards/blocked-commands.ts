import { relative, resolve } from "node:path";
import type { GuardVerdict, ToolCall } from "../types.js";
import type { Policy } from "../policy.js";
import { commandString, rmTargets, gitPushInvocations } from "../extract.js";

const GUARD = "blocked-commands";

/**
 * Commands that only read, print, or filter text — they never execute their
 * arguments as code. If *every* segment of a command invokes one of these, the
 * command cannot run the SQL it merely mentions: it is talking *about*
 * `DROP TABLE`, not executing it.
 *
 * Deliberately small. Anything not on this list is treated as capable of
 * executing, so an unrecognised command still gets scanned — unknown means
 * scan, never means skip. Excluded on purpose, all of them text tools that
 * can be talked into running something:
 *   - `sed` / `awk`    — `sed e` and awk's `system()` both execute.
 *   - `less` / `more`  — LESSOPEN/LESSCLOSE run a preprocessor command.
 *   - `sort`           — `--compress-program` executes, `-o` writes a file.
 *   - `ag` / `ack`     — configurable pagers and filters that shell out.
 *   - `yq`             — `-i` edits files in place.
 */
const INERT_TEXT_COMMANDS = new Set([
  "echo", "printf", "cat", "head", "tail",
  "grep", "egrep", "fgrep", "rg",
  "wc", "uniq", "cut", "tr", "rev", "nl", "fold", "column", "comm",
  "jq", "true", "false",
]);

/**
 * Flags that hand an allowlisted command something to execute. `rg --pre` is
 * the sharp one: ripgrep is a pure text tool right up until you give it a
 * preprocessor binary to run over every file it reads.
 */
const EXEC_FLAGS = new Set([
  "--pre", "--pre-glob", "--hostname-bin", "--compress-program",
  "--pager", "--preprocessor", "--filter",
]);

/**
 * The built-in patterns that describe destructive *content* — the ones that
 * fire on text merely quoting a statement, which is the whole of issue #2.
 * Only these may be skipped, and only for a provably inert command.
 *
 * This is exact built-in *pattern* semantics, not provenance. `bulkhead init`
 * writes these very patterns into the user's bulkhead.yaml (see templates.ts),
 * so a flag set in defaultPolicy() would miss every real install — matching on
 * the pattern string is what makes the fix reach actual installs at all.
 *
 * Known limit, stated plainly: string equality cannot tell a stock rule from
 * an identical regex a customer wrote themselves, so an operator who
 * independently authors one of these four patterns gets the exception too.
 * What it does buy is narrower and still worth having — a rule whose pattern
 * differs from all four, such as banning `echo` or a secret-file read, is
 * never skipped, however inert the command looks. Distinguishing true
 * provenance needs the policy loader to tag rules at parse time; that is a
 * larger change than this fix, and worth doing if this set ever grows.
 */
const PROSE_SENSITIVE_DEFAULTS = new Set([
  "\\bDROP\\s+TABLE\\b",
  "\\bDROP\\s+DATABASE\\b",
  "\\bTRUNCATE\\s+TABLE\\b",
  "\\bmkfs\\.[a-z0-9]+\\b",
]);

/**
 * Split a command into segments of tokens, tracking quote state, or return
 * null when it contains anything this check cannot honestly reason about.
 *
 * Null means "not eligible for the inert exception" — it is the fail-closed
 * answer, not an error. The inversion matters: an earlier revision enumerated
 * dangerous constructs and missed `<(...)`, then a bare `&`. Enumerating
 * hazards is a game you lose one counterexample at a time, so this accepts
 * only syntax it fully understands and refuses everything else.
 *
 * Quote semantics are the load-bearing part, and the two halves are not
 * symmetric:
 *   - Single quotes are literal. `echo 'DROP TABLE $(x)'` really is inert.
 *   - Double quotes still run `$(...)` and backticks, so those stay fatal
 *     inside them — but the token's *text* is preserved, because deleting it
 *     would hide `rg "--pre=./run.sh"`, where the quoted token is a real
 *     option that makes rg execute a script.
 */
function scanCommand(cmd: string): string[][] | null {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let cur = "";
  let hasCur = false;

  const endToken = () => {
    if (hasCur) tokens.push(cur);
    cur = "";
    hasCur = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i]!;

    if (c === "'") {
      const close = cmd.indexOf("'", i + 1);
      if (close === -1) return null; // unterminated
      cur += cmd.slice(i + 1, close);
      hasCur = true;
      i = close + 1;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= cmd.length) return null; // unterminated
        const d = cmd[j]!;
        if (d === '"') break;
        if (d === "\\") {
          if (j + 1 >= cmd.length) return null;
          cur += cmd[j + 1]!;
          j += 2;
          continue;
        }
        // Substitution survives double quotes — the shell would run it.
        if (d === "$" || d === "`") return null;
        cur += d;
        j++;
      }
      hasCur = true;
      i = j + 1;
      continue;
    }

    if (c === " " || c === "\t") {
      endToken();
      i++;
      continue;
    }
    if (c === "\n" || c === ";") {
      endSegment();
      i++;
      continue;
    }
    if (c === "|") {
      endSegment();
      i += cmd[i + 1] === "|" ? 2 : 1;
      continue;
    }
    if (c === "&") {
      // `&&` chains; a lone `&` backgrounds the first command and runs the
      // next one, which is exactly the form a segment splitter overlooks.
      if (cmd[i + 1] !== "&") return null;
      endSegment();
      i += 2;
      continue;
    }
    // Substitution, redirection, grouping, escaping.
    if ("$`(){}<>\\".includes(c)) return null;

    cur += c;
    hasCur = true;
    i++;
  }

  endSegment();
  return segments;
}

/**
 * True when the whole command provably does nothing but handle text.
 *
 * Whole-command, not per-segment, and that distinction is the entire point:
 * `echo "DROP TABLE users" | psql` must still be denied. Skipping only the
 * `echo` segment would convert a false positive into a false negative on the
 * one case that actually matters, so a single non-inert segment disqualifies
 * the whole command.
 *
 * Scanned here rather than via commandSegments(): that helper is a best-effort
 * *evidence* parser, not a shell parser — it ignores a lone `&`, cannot see
 * process substitution, and reduces `./echo` to the basename `echo`. Good
 * enough to describe what a command probably did; not good enough to be the
 * proof that lets a command bypass enforcement.
 */
function isInertTextOnly(cmd: string): boolean {
  const segments = scanCommand(cmd);
  if (segments === null || segments.length === 0) return false;

  for (const tokens of segments) {
    const exe = tokens[0]!;

    // A leading VAR=value can arm a preprocessor (LESSOPEN, PATH, IFS)
    // without ever appearing as an executable.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(exe)) return false;

    // Must be a bare allowlisted token, never a path. `./echo` is a local
    // script that can do anything, and matching on the basename would let it
    // inherit the allowlist. Wrappers are not skipped past either: `sudo`,
    // `env`, `command` and `sh -c` are simply not inert.
    if (!INERT_TEXT_COMMANDS.has(exe)) return false;

    for (const token of tokens.slice(1)) {
      if (EXEC_FLAGS.has(token.split("=")[0]!)) return false;
    }
  }

  return true;
}

export function blockedCommandsGuard(call: ToolCall, policy: Policy): GuardVerdict {
  const cmd = commandString(call);
  if (cmd === undefined) return { action: "allow", guard: GUARD };

  // 1. rm that reaches outside the workspace root.
  const outside = rmOutsideWorkspace(cmd, policy.workspaceRoot);
  if (outside) return outside;

  // 2. Dangerous force-push (structured, order-independent).
  const force = forcePush(cmd);
  if (force) return force;

  // 3. Configured regex patterns — content matching, so they are the ones that
  // fire on text that merely *mentions* a destructive command (issue #2:
  // `echo drop table`). The structured checks above are not skipped: they read
  // argument structure, not prose, and were never prone to this.
  //
  // Note this skips *rules*, not the guard. An earlier revision returned allow
  // for the whole command, which silently overrode customer-authored deny
  // rules — a guard quietly declining to enforce the policy it was given is a
  // worse bug than the false positive it was fixing.
  const inert = isInertTextOnly(cmd);

  for (const rule of policy.blockedCommands) {
    if (inert && PROSE_SENSITIVE_DEFAULTS.has(rule.pattern)) continue;

    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, "i");
    } catch {
      // A malformed user pattern must never crash enforcement; skip it.
      continue;
    }
    if (re.test(cmd)) {
      return {
        action: "deny",
        guard: GUARD,
        rule: rule.pattern,
        reason: rule.message
          ? `${rule.message} — matched blocked command pattern.`
          : `Command matches blocked pattern \`${rule.pattern}\`.`,
      };
    }
  }

  return { action: "allow", guard: GUARD };
}

function rmOutsideWorkspace(cmd: string, workspaceRoot: string): GuardVerdict | null {
  const targets = rmTargets(cmd);
  if (!targets || targets.length === 0) return null;
  const root = resolve(workspaceRoot);
  for (const t of targets) {
    // Absolute-path root deletes and obvious escapes.
    if (t === "/" || t === "/*" || t === "~" || t === "~/" || t.startsWith("/*")) {
      return deny(t, "targets a filesystem root");
    }
    const abs = resolve(root, t);
    const rel = relative(root, abs);
    if (rel === "" || rel.startsWith("..")) {
      return deny(t, "resolves outside the workspace");
    }
  }
  return null;
}

function deny(target: string, why: string): GuardVerdict {
  return {
    action: "deny",
    guard: GUARD,
    rule: "rm-outside-workspace",
    reason: `\`rm\` target \`${target}\` ${why}; refusing to delete outside the project.`,
  };
}

/**
 * Structured detection of a dangerous force-push. Order-independent (so
 * `git push origin main --force` is caught, not just `git push --force origin
 * main`), and precise about the branch so a feature branch merely *named*
 * `feature/main-nav` or `release-main` is NOT blocked. Denies when a hard force
 * flag is present AND either (a) a protected branch (main/master) is a push
 * target, or (b) there's no explicit refspec at all (an unconditional force to
 * whatever branch is tracked — could be main). `--force-with-lease` and
 * `--force-if-includes` are the safe variants and are never treated as a hard
 * force.
 */
function forcePush(cmd: string): GuardVerdict | null {
  for (const { flags, positionals } of gitPushInvocations(cmd)) {
    if (!flags.some(isHardForceFlag)) continue;
    const refs = positionals.filter((p) => !p.includes("://")); // drop URL remotes
    if (refs.some(isProtectedRef)) {
      return {
        action: "deny",
        guard: GUARD,
        rule: "force-push-protected-branch",
        reason: "Force-push to a protected branch (main/master) — refusing.",
      };
    }
    // 0 or 1 positional means at most a remote, no explicit refspec: the force
    // pushes to the tracked branch, which may be main. 2+ means an explicit
    // refspec is named and (per the check above) it isn't main/master.
    if (positionals.length <= 1) {
      return {
        action: "deny",
        guard: GUARD,
        rule: "force-push-unconditional",
        reason: "Unconditional force-push (no explicit non-default branch) — refusing; it may target the tracked branch.",
      };
    }
  }
  return null;
}

function isHardForceFlag(flag: string): boolean {
  if (flag === "-f") return true;
  // Combined short flags like -uf.
  if (/^-[a-z]+$/i.test(flag) && flag.includes("f")) return true;
  if (flag.startsWith("--force")) {
    return !flag.startsWith("--force-with-lease") && !flag.startsWith("--force-if-includes");
  }
  return false;
}

function isProtectedRef(token: string): boolean {
  const t = token.replace(/^\+/, "");
  // For a src:dst refspec, only the destination gets overwritten.
  const dst = t.includes(":") ? t.split(":").pop() ?? t : t;
  return /(^|\/)(main|master)$/.test(dst);
}
