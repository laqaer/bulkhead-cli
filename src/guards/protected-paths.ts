import { relative, resolve } from "node:path";
import picomatch from "picomatch";
import type { GuardVerdict, ToolCall } from "../types.js";
import type { Policy } from "../policy.js";
import { isFileWriteTool, isBashTool, targetPaths, rmTargets } from "../extract.js";

const GUARD = "protected-paths";

/**
 * Deny writes and deletes to configured protected paths (prod/, migrations/,
 * .env, ...). Enforcement is reliable for structured file tools (Write/Edit),
 * where the path is a named field. For Bash we cover the common destructive
 * case — `rm` of a protected path — but a shell can reach a file many ways we
 * cannot see, so this guard is containment for the obvious mistakes, not a
 * sandbox. Blocked-commands + the workspace-boundary check carry the rest.
 */
export function protectedPathsGuard(call: ToolCall, policy: Policy): GuardVerdict {
  const deny = policy.protectedPaths.deny;
  if (deny.length === 0) return { action: "allow", guard: GUARD };

  const root = resolve(policy.workspaceRoot);
  const isMatch = picomatch(deny, { dot: true });
  const isAllowed =
    policy.protectedPaths.allow.length > 0
      ? picomatch(policy.protectedPaths.allow, { dot: true })
      : () => false;

  const check = (absPath: string): GuardVerdict | null => {
    // Match globs against the repo-relative path (what users write in policy).
    const rel = relative(root, absPath);
    const candidates = rel.startsWith("..") ? [absPath] : [rel, absPath];
    for (const c of candidates) {
      const norm = c.split("\\").join("/");
      if (isAllowed(norm)) return null;
      if (isMatch(norm)) {
        return {
          action: "deny",
          guard: GUARD,
          rule: matchedRule(norm, deny),
          reason: `\`${rel || absPath}\` is a protected path (write/delete denied by bulkhead.yaml).`,
        };
      }
    }
    return null;
  };

  if (isFileWriteTool(call.toolName)) {
    for (const p of targetPaths(call, root)) {
      const v = check(p);
      if (v) return v;
    }
  }

  if (isBashTool(call.toolName)) {
    const cmd = call.toolInput?.command;
    if (typeof cmd === "string") {
      const targets = rmTargets(cmd);
      if (targets) {
        for (const t of targets) {
          const abs = resolve(root, t);
          const v = check(abs);
          if (v) {
            return {
              ...v,
              reason: `\`rm\` targets protected path \`${t}\` (denied by bulkhead.yaml).`,
            };
          }
        }
      }
    }
  }

  return { action: "allow", guard: GUARD };
}

function matchedRule(path: string, deny: string[]): string {
  for (const pattern of deny) {
    if (picomatch(pattern, { dot: true })(path)) return pattern;
  }
  return deny.join(", ");
}
