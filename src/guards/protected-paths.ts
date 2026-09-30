import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import type { GuardVerdict, ToolCall } from "../types.js";
import {
  IMMUTABLE_PROTECTED_PATHS,
  type Policy,
} from "../policy.js";
import { isFileWriteTool, isBashTool, targetPaths, rmTargets } from "../extract.js";
import { HARD_LINK_SCAN_LIMIT, scanHardLinks } from "./hard-links.js";

const GUARD = "protected-paths";
const WORKSPACE_BOUNDARY_RULE = "structured-write-outside-workspace";
const HARD_LINK_UNVERIFIED_RULE = "hard-link-alias-unverified";

/**
 * Resolve `target` to its real location WITHOUT requiring the leaf to exist.
 *
 * Structured writes usually name a file that does not exist yet, so a plain
 * `realpathSync` (ENOENT) is useless. Instead: walk up to the deepest
 * component that DOES exist, realpath it, and re-join the missing tail onto
 * it. A symlinked ancestor (`ln -s prod gate`, then write `gate/evil.txt`)
 * therefore resolves to `prod/evil.txt` even though `gate/evil.txt` itself
 * never existed.
 *
 * If resolution is impossible for a non-ENOENT reason (e.g. EACCES somewhere
 * along the walk) we return the lexical path: resolution must never REMOVE a
 * deny, and the lexical candidate is matched separately anyway, so this
 * fallback only means "no additional information".
 */
export function resolveRealCandidate(target: string): string {
  const lexical = resolve(target);
  let current = lexical;
  const missingTail: string[] = [];
  for (;;) {
    if (existsSync(current)) {
      try {
        const real = realpathSync(current);
        return missingTail.length === 0 ? real : join(real, ...missingTail);
      } catch {
        return lexical; // raced/unreadable: fall back to lexical, no widening
      }
    }
    const parent = dirname(current);
    if (parent === current) return lexical; // walked off the fs root
    missingTail.unshift(basename(current));
    current = parent;
  }
}

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

function workspaceBoundaryVerdict(
  absPath: string,
  root: string,
  rootReal: string,
): GuardVerdict | null {
  const lexical = resolve(absPath);
  const real = resolveRealCandidate(lexical);
  if (isWithinRoot(root, lexical) && isWithinRoot(rootReal, real)) return null;

  return {
    action: "deny",
    guard: GUARD,
    rule: WORKSPACE_BOUNDARY_RULE,
    reason: `Structured write target \`${absPath}\` resolves outside the project workspace; refusing host-level file access.`,
  };
}

/**
 * Deny structured writes outside the canonical workspace and writes/deletes to
 * configured protected paths (prod/, migrations/, .env, ...).
 *
 * Structured file tools have a named target, so their workspace boundary is a
 * non-configurable invariant: neither an absolute path, `..` escape, nor a
 * symlinked ancestor may reach another repository or host file. Configured
 * allow globs are evaluated only after that boundary.
 *
 * For Bash we cover the common destructive case — `rm` of a protected path —
 * but a shell can reach a file many ways we cannot see, so this guard is
 * containment for the obvious mistakes, not a sandbox. blocked-commands owns
 * the structured rm-outside-workspace check.
 *
 * Matching runs on BOTH the lexical path and its realpath-resolved form, so a
 * symlinked ancestor created with an allowed Bash command (`ln -s prod gate`,
 * then Write `gate/evil.txt`) cannot walk through a protected path.
 *
 * A hard link has no path relationship to resolve, so structured writes also
 * compare file identity: when the target already exists with more than one
 * link, any other name for the same inode that is protected denies the write
 * (see scanHardLinks). The workspace boundary stays path-based — a hard link
 * to a host file outside the workspace is only caught by an absolute deny glob.
 */
export function protectedPathsGuard(call: ToolCall, policy: Policy): GuardVerdict {
  const root = resolve(policy.workspaceRoot);
  // Resolve the ROOT through symlinks too, so the relative paths computed for
  // resolved candidates stay consistent when the workspace lives under a
  // symlinked parent (macOS `/tmp` -> `/private/tmp` is the classic case).
  const rootReal = resolveRealCandidate(root);

  if (isFileWriteTool(call.toolName)) {
    for (const path of targetPaths(call, root)) {
      const boundary = workspaceBoundaryVerdict(path, root, rootReal);
      if (boundary) return boundary;
    }
  }

  const deny = policy.protectedPaths.deny;
  // DENY and immutable self-protection match case-insensitively; ALLOW does
  // not. On default macOS/Windows volumes, a case variant names the same file,
  // while widening allow exceptions would hand the bypass straight back.
  const isMatch =
    deny.length > 0
      ? picomatch(deny, { dot: true, nocase: true })
      : () => false;
  const isImmutable = picomatch([...IMMUTABLE_PROTECTED_PATHS], {
    dot: true,
    nocase: true,
  });
  const isAllowed =
    policy.protectedPaths.allow.length > 0
      ? picomatch(policy.protectedPaths.allow, { dot: true })
      : () => false;

  // Path-only verdict: lexical + canonical candidates, no identity check. It
  // classifies the target itself and every hard-link alias the scan finds.
  const pathVerdict = (absPath: string, real: string): GuardVerdict | null => {
    const rel = relative(root, absPath);
    // Raw pair keeps the historical shape: outside-root paths matched the
    // absolute form only (their relative form is meaningless `../..` noise).
    const rawCandidates = rel.startsWith("..") ? [absPath] : [rel, absPath];
    const candidates =
      real === absPath && rootReal === root
        ? rawCandidates
        : [...rawCandidates, relative(rootReal, real), real];
    const normalized = [...new Set(candidates.map((c) => c.split("\\").join("/")))];

    // Self-protection is evaluated across every lexical + canonical candidate
    // before user allow exceptions. An alias allow rule may never exempt the
    // policy file or evidence/state directory it resolves onto.
    for (const norm of normalized) {
      if (isImmutable(norm)) {
        return {
          action: "deny",
          guard: GUARD,
          rule: matchedRule(norm, [...IMMUTABLE_PROTECTED_PATHS]),
          reason: `\`${rel || absPath}\` is part of Bulkhead's immutable policy/state boundary.`,
        };
      }
    }

    for (const norm of normalized) {
      if (isAllowed(norm)) return null;
    }
    for (const norm of normalized) {
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

  const display = (absPath: string): string => {
    const rel = relative(root, absPath);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absPath;
  };

  // Identity check (issue #3): a hard link is a second name for the SAME
  // inode, invisible to path matching, so writing an unprotected alias writes
  // the protected file. Runs for writes only — unlinking an alias (`rm`)
  // leaves the protected name and its contents untouched.
  const hardLinkVerdict = (absPath: string, real: string): GuardVerdict | null => {
    const scan = scanHardLinks(real, {
      root,
      rootReal,
      patterns: [...IMMUTABLE_PROTECTED_PATHS, ...deny],
      classify: (alias) => pathVerdict(alias, resolveRealCandidate(alias)),
      limit: HARD_LINK_SCAN_LIMIT,
    });
    if (scan.kind === "clear") return null;
    if (scan.kind === "alias") {
      return {
        action: "deny",
        guard: GUARD,
        rule: scan.verdict.rule,
        reason: `\`${display(absPath)}\` is a hard link to \`${display(scan.path)}\` — the same file, so writing one writes both. ${scan.verdict.reason}`,
      };
    }
    // Could not enumerate every protected name: fail closed. Only reachable
    // for targets with more than one link.
    return {
      action: "deny",
      guard: GUARD,
      rule: HARD_LINK_UNVERIFIED_RULE,
      reason: `\`${display(absPath)}\` has ${scan.links} hard links and Bulkhead could not rule out that one of them is a protected path: ${scan.detail}.`,
    };
  };

  /** The one chokepoint every structured write and Bash `rm` target passes. */
  const check = (absPath: string, access: "write" | "delete"): GuardVerdict | null => {
    const real = resolveRealCandidate(absPath);
    const verdict = pathVerdict(absPath, real);
    if (verdict || access === "delete") return verdict;
    return hardLinkVerdict(absPath, real);
  };

  if (isFileWriteTool(call.toolName)) {
    for (const path of targetPaths(call, root)) {
      const verdict = check(path, "write");
      if (verdict) return verdict;
    }
  }

  if (isBashTool(call.toolName)) {
    const cmd = call.toolInput?.command;
    if (typeof cmd === "string") {
      const targets = rmTargets(cmd);
      if (targets) {
        for (const target of targets) {
          const abs = resolve(root, target);
          const verdict = check(abs, "delete");
          if (verdict) {
            return {
              ...verdict,
              reason: `\`rm\` targets protected path \`${target}\` (denied by Bulkhead).`,
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
    if (picomatch(pattern, { dot: true, nocase: true })(path)) return pattern;
  }
  return deny.join(", ");
}
