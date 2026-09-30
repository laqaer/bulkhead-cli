import { lstatSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import picomatch from "picomatch";
import type { GuardVerdict } from "../types.js";

/**
 * Directory entries one alias scan may visit before it stops and reports the
 * target as unverifiable (which the guard turns into a deny). The scan only
 * runs for write targets with more than one hard link, and with the built-in
 * patterns it touches the workspace root plus `prod/`, `migrations/` and
 * `.bulkhead/`. The bound exists so an unanchored user glob (`**\/*.pem`) in a
 * huge tree — or a guarded agent padding a protected dir with junk — costs a
 * refusal, not a hook timeout the host would treat as "proceed".
 */
export const HARD_LINK_SCAN_LIMIT = 20_000;

export type HardLinkScan =
  | { kind: "clear" }
  | { kind: "alias"; links: bigint; path: string; verdict: GuardVerdict }
  | { kind: "unverifiable"; links: bigint; detail: string };

export interface HardLinkScanOptions {
  /** Lexical workspace root; relative patterns are walked from here. */
  root: string;
  /** Canonical workspace root; `../`-anchored patterns resolve against it. */
  rootReal: string;
  /** Every glob whose matches are protected (deny ∪ immutable). */
  patterns: readonly string[];
  /** Path-only verdict for a candidate alias; null means "not protected". */
  classify: (absPath: string) => GuardVerdict | null;
  /** Maximum directory entries to visit; see HARD_LINK_SCAN_LIMIT. */
  limit: number;
}

/**
 * Is `targetReal` — an existing file about to be written — another directory
 * entry for the same inode as a protected path?
 *
 * A hard link has no link to resolve: `realpath` on the alias returns the
 * alias, so path matching (lexical or canonical) cannot see it. Identity can.
 * Files with a single link (the overwhelmingly common case) cost one `stat`.
 * Only when `nlink > 1` do we enumerate the directory entries that could match
 * a protected glob and compare `dev`+`ino` against the target.
 *
 * Nothing here is cached: the protected set is recomputed on every call, so a
 * link created after the policy was loaded — or between two tool calls — is
 * seen by the next check.
 *
 * Enumeration walks canonical entries only and never follows symlinks. A
 * symlink is not a name for the inode, and following one would let a link
 * planted inside a protected directory drag unrelated files into the
 * protected set. Symlink aliases are already covered by realpath matching.
 */
export function scanHardLinks(targetReal: string, opts: HardLinkScanOptions): HardLinkScan {
  let target;
  try {
    target = statSync(targetReal, { bigint: true });
  } catch {
    // Missing: the write creates a fresh inode, which cannot alias anything.
    // Any other failure: the guard's resolution rule applies — it may widen a
    // deny, never invent one, and the tool cannot open what we cannot stat.
    return { kind: "clear" };
  }
  // Directories cannot be hard-linked (and count `.` entries in nlink).
  if (target.isDirectory() || target.nlink < 2n) return { kind: "clear" };

  const budget = { remaining: opts.limit };
  for (const [start, patterns] of walkPlan(opts)) {
    const found = walk(start, patterns, target, targetReal, opts, budget);
    if (found) return { ...found, links: target.nlink };
  }
  return { kind: "clear" };
}

/**
 * One path segment of a glob: a matcher for that segment, or `null` for "any
 * depth from here" (`**`, or a segment we cannot position reliably).
 */
type Segment = ((name: string) => boolean) | null;

/** Same flags as the deny matcher, so pruning never disagrees with matching. */
const SEGMENT_OPTS = { dot: true, nocase: true } as const;

/** Group every protected glob by the directory its walk starts from. */
function walkPlan(opts: HardLinkScanOptions): Map<string, Segment[][]> {
  const plan = new Map<string, Segment[][]>();
  const add = (start: string, segs: Segment[]): void => {
    const list = plan.get(start);
    if (list) list.push(segs);
    else plan.set(start, [segs]);
  };

  for (const pattern of new Set(opts.patterns)) {
    if (pattern.startsWith("!")) {
      // A negated glob can match almost anything: walk the whole workspace.
      add(opts.root, [null]);
      continue;
    }
    const rel = pattern.replace(/^(?:\.\/)+/, "");
    // Relative globs are walked from the root segment by segment, so a
    // case-variant glob (`PROD/**`) still finds `prod/` on any volume.
    // Absolute and `../`-anchored globs name a fixed location — possibly
    // outside the workspace — so their walk starts at the literal static base.
    const anchored = rel.startsWith("/") || rel === ".." || rel.startsWith("../");
    if (!anchored) {
      add(opts.root, segments(rel));
      continue;
    }
    const scan = picomatch.scan(rel);
    const base = rel.startsWith("/") ? scan.base || "/" : resolve(opts.rootReal, scan.base);
    if (scan.glob) add(base, segments(scan.glob));
    else if (basename(base)) add(dirname(base), segments(basename(base))); // exact path: its leaf
  }
  return plan;
}

function segments(glob: string): Segment[] {
  const out: Segment[] = [];
  for (const seg of glob.split("/")) {
    // Brace and extglob groups may contain "/" themselves, so positions past
    // one are unknowable; empty/dot segments are unusual enough to not guess.
    // Either way: stop pruning and walk everything below.
    if (seg === "**" || seg === "" || seg === "." || seg === ".." || /[{}()]/.test(seg)) {
      out.push(null);
      return out;
    }
    out.push(picomatch(seg, SEGMENT_OPTS));
  }
  return out;
}

/** Could a glob match something strictly below the directory at `dirSegs`? */
function mayContainMatch(segs: Segment[], dirSegs: readonly string[]): boolean {
  for (let i = 0; i < dirSegs.length; i++) {
    const seg = segs[i];
    if (seg === undefined) return false; // glob is shallower than this dir
    if (seg === null) return true;
    if (!seg(dirSegs[i]!)) return false;
  }
  return segs.length > dirSegs.length;
}

type Found =
  | { kind: "alias"; path: string; verdict: GuardVerdict }
  | { kind: "unverifiable"; detail: string };

function walk(
  start: string,
  patterns: Segment[][],
  target: { dev: bigint; ino: bigint },
  targetReal: string,
  opts: HardLinkScanOptions,
  budget: { remaining: number },
): Found | null {
  const stack: string[][] = [[]];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const dir = join(start, ...rel);
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (vanished(err)) continue;
      // An unreadable protected directory could hide the alias; `chmod 000
      // prod` must not turn this check back off.
      return { kind: "unverifiable", detail: `cannot read \`${dir}\` (${errCode(err)})` };
    }
    for (const entry of entries) {
      if (--budget.remaining < 0) {
        return {
          kind: "unverifiable",
          detail: `scan stopped after ${opts.limit} directory entries`,
        };
      }
      if (entry.isSymbolicLink()) continue;
      const childRel = [...rel, entry.name];
      if (entry.isDirectory()) {
        if (patterns.some((p) => mayContainMatch(p, childRel))) stack.push(childRel);
        continue;
      }
      const path = join(dir, entry.name);
      let st;
      try {
        st = lstatSync(path, { bigint: true });
      } catch (err) {
        if (vanished(err)) continue;
        return { kind: "unverifiable", detail: `cannot stat \`${path}\` (${errCode(err)})` };
      }
      if (st.dev !== target.dev || st.ino !== target.ino) continue;
      if (isSameEntry(path, targetReal)) continue; // the target itself, not an alias
      const verdict = opts.classify(path);
      if (verdict) return { kind: "alias", path, verdict };
    }
  }
  return null;
}

function isSameEntry(path: string, targetReal: string): boolean {
  try {
    return realpathSync(path) === targetReal;
  } catch {
    return false; // cannot prove it is the target: classify it like any alias
  }
}

function vanished(err: unknown): boolean {
  const code = errCode(err);
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? "unknown error";
}
