import { relative, resolve } from "node:path";
import type { GuardVerdict, ToolCall } from "../types.js";
import type { Policy } from "../policy.js";
import { commandString, rmTargets, gitPushInvocations } from "../extract.js";

const GUARD = "blocked-commands";

/**
 * Deny Bash commands that match a blocked pattern, plus a structured check for
 * `rm` that escapes the workspace. Regex matching is bypassable by design
 * (obfuscation, env vars, base64) — we say so in the README. The value is
 * catching the fat-finger and the copied-from-Stack-Overflow disaster, not
 * stopping a determined adversary.
 */
export function blockedCommandsGuard(call: ToolCall, policy: Policy): GuardVerdict {
  const cmd = commandString(call);
  if (cmd === undefined) return { action: "allow", guard: GUARD };

  // 1. rm that reaches outside the workspace root.
  const outside = rmOutsideWorkspace(cmd, policy.workspaceRoot);
  if (outside) return outside;

  // 2. Dangerous force-push (structured, order-independent).
  const force = forcePush(cmd);
  if (force) return force;

  // 3. Configured regex patterns.
  for (const rule of policy.blockedCommands) {
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
