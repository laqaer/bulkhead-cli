import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import picomatch from "picomatch";
import type { GuardVerdict, ToolCall } from "../types.js";
import type { Policy } from "../policy.js";
import { isFileWriteTool, isBashTool, targetPaths, rmTargets } from "../extract.js";

const GUARD = "protected-paths";

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

/**
 * Deny writes and deletes to configured protected paths (prod/, migrations/,
 * .env, ...). Enforcement is reliable for structured file tools (Write/Edit),
 * where the path is a named field. For Bash we cover the common destructive
 * case — `rm` of a protected path — but a shell can reach a file many ways we
 * cannot see, so this guard is containment for the obvious mistakes, not a
 * sandbox. Blocked-commands + the workspace-boundary check carry the rest.
 *
 * F1: matching runs on BOTH the lexical path and its realpath-resolved form
 * (`resolveRealCandidate` below), so a symlinked ancestor created with an
 * allowed Bash command (`ln -s prod gate`, then Write `gate/evil.txt`) no
 * longer walks through the guard. Resolution is deny-widening only — see the
 * comment on `check`.
 */
export function protectedPathsGuard(call: ToolCall, policy: Policy): GuardVerdict {
  const deny = policy.protectedPaths.deny;
  if (deny.length === 0) return { action: "allow", guard: GUARD };

  const root = resolve(policy.workspaceRoot);
  // Resolve the ROOT through symlinks too, so the relative paths computed for
  // resolved candidates stay consistent when the workspace lives under a
  // symlinked parent (macOS `/tmp` -> `/private/tmp` is the classic case).
  const rootReal = resolveRealCandidate(root);
  // DENY matches case-insensitively, ALLOW does not. That asymmetry is
  // deliberate and is the whole fix.
  //
  // macOS and Windows volumes are case-insensitive by default, so `.ENV` and
  // `.env` are the same file. A case-sensitive deny matcher let `.ENV`,
  // `.Env`, `PROD/`, `Migrations/` and `.Bulkhead/` through while reporting
  // "allow" -- including the evidence ledger, whose hash chain detects edits
  // and mid-chain deletes but not tail truncation.
  //
  // Applying nocase to the ALLOW list too would hand the same bypass back:
  // an exemption for `prod/README.md` would start exempting `PROD/README.MD`.
  // A deny must fail closed, so only the deny side widens.
  //
  // This is unconditional rather than probed per-volume: a guard that is
  // enforcing on a laptop and permissive in Linux CI is worse than one that
  // is slightly over-strict everywhere. On a genuinely case-sensitive volume
  // this can deny a distinct file whose name differs only by case; that is
  // the intended trade, and `protectedPaths.allow` is the escape hatch.
  const isMatch = picomatch(deny, { dot: true, nocase: true });
  const isAllowed =
    policy.protectedPaths.allow.length > 0
      ? picomatch(policy.protectedPaths.allow, { dot: true })
      : () => false;

  const check = (absPath: string): GuardVerdict | null => {
    // Match globs against the repo-relative path (what users write in policy).
    //
    // F1: candidates are the raw lexical pair FIRST (relative + absolute —
    // exactly what pre-fix versions matched, unchanged), then the
    // realpath-resolved pair. Because resolution only ever ADDS candidates,
    // the change is deny-widening by construction: a call that denied before
    // still denies, and `allow` exemptions keep winning at the candidate that
    // names them. Resolution never removes a deny.
    const real = resolveRealCandidate(absPath);
    const rel = relative(root, absPath);
    // Raw pair keeps the historical shape: outside-root paths matched the
    // absolute form only (their relative form is meaningless `../..` noise).
    const rawCandidates = rel.startsWith("..") ? [absPath] : [rel, absPath];
    const candidates =
      real === absPath && rootReal === root
        ? rawCandidates
        : [...rawCandidates, relative(rootReal, real), real];
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
    // Must mirror the deny matcher above, or a case-variant path is denied
    // with `rule` falling through to the entire deny list joined together.
    if (picomatch(pattern, { dot: true, nocase: true })(path)) return pattern;
  }
  return deny.join(", ");
}
