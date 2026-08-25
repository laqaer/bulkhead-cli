import { describe, it, expect } from "vitest";
import { linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultPolicy } from "../src/policy.js";
import { protectedPathsGuard } from "../src/guards/protected-paths.js";
import { blockedCommandsGuard } from "../src/guards/blocked-commands.js";
import { budgetGuard } from "../src/guards/budget.js";
import { loopCheck, emptyLoopState, signatureFor } from "../src/guards/loop.js";
import type { ToolCall } from "../src/types.js";
import { tempRepo } from "./helpers.js";

const ROOT = "/repo";
const policy = defaultPolicy(ROOT);

function write(path: string): ToolCall {
  return { toolName: "Write", toolInput: { file_path: path, content: "x" } };
}
function bash(command: string): ToolCall {
  return { toolName: "Bash", toolInput: { command } };
}

describe("protected-paths guard", () => {
  it("denies writing to a protected dir", () => {
    expect(protectedPathsGuard(write("/repo/prod/config.yaml"), policy).action).toBe("deny");
  });
  it("denies writing to .env", () => {
    expect(protectedPathsGuard(write("/repo/.env"), policy).action).toBe("deny");
  });
  it("denies writing to .env.production via glob", () => {
    expect(protectedPathsGuard(write("/repo/.env.production"), policy).action).toBe("deny");
  });
  it("denies writing to migrations", () => {
    expect(protectedPathsGuard(write("/repo/migrations/001_init.sql"), policy).action).toBe("deny");
  });
  it("denies the agent writing to its own evidence ledger", () => {
    expect(protectedPathsGuard(write("/repo/.bulkhead/ledger.jsonl"), policy).action).toBe("deny");
  });
  // Defect K: on a case-insensitive volume (macOS/Windows default) `.ENV` and
  // `.env` are the SAME FILE, but picomatch matched case-sensitively, so every
  // one of these reached the real file while reporting "allow". `.bulkhead/**`
  // is the evidence ledger, whose hash chain catches edits and mid-chain
  // deletes but NOT tail truncation -- so this bypass granted exactly the
  // attack the ledger cannot detect afterwards.
  it.each([
    "/repo/.ENV",
    "/repo/.Env",
    "/repo/.ENV.local",
    "/repo/PROD/config.yaml",
    "/repo/Prod/config.yaml",
    "/repo/Migrations/001_init.sql",
    "/repo/.Bulkhead/ledger.jsonl",
  ])("denies %s -- same file as its lowercase form on a case-insensitive volume", (path) => {
    expect(protectedPathsGuard(write(path), policy).action).toBe("deny");
  });

  it("names the matched rule for a case-variant path, not the whole deny list", () => {
    const v = protectedPathsGuard(write("/repo/.ENV"), policy);
    expect(v.action).toBe("deny");
    // matchedRule() must mirror the deny matcher; if it does not, it falls
    // through to deny.join(", ") and the user is told every rule matched.
    expect(v.rule).not.toContain(",");
  });

  it("does NOT widen the allow-exception by case -- a deny must fail closed", () => {
    const p = defaultPolicy(ROOT);
    p.protectedPaths.allow = ["prod/README.md"];
    // exact case: still exempt
    expect(protectedPathsGuard(write("/repo/prod/README.md"), p).action).toBe("allow");
    // case variant of the EXEMPTION must not inherit the exemption, or the
    // fix for the deny side hands the bypass straight back on the allow side.
    expect(protectedPathsGuard(write("/repo/PROD/README.MD"), p).action).toBe("deny");
  });

  it("allows writing to an ordinary source file", () => {
    expect(protectedPathsGuard(write("/repo/src/index.ts"), policy).action).toBe("allow");
  });
  it("honors allow exceptions", () => {
    const p = defaultPolicy(ROOT);
    p.protectedPaths.allow = ["prod/README.md"];
    expect(protectedPathsGuard(write("/repo/prod/README.md"), p).action).toBe("allow");
    expect(protectedPathsGuard(write("/repo/prod/secrets.yaml"), p).action).toBe("deny");
  });
  it("denies rm of a protected path via Bash", () => {
    expect(protectedPathsGuard(bash("rm -rf prod"), policy).action).toBe("deny");
  });
  it("relative-path write resolves against the root", () => {
    // Write tools give absolute paths; simulate a relative one resolved to root.
    expect(protectedPathsGuard(write("prod/x"), policy).action).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// F1: symlinks defeated protected-path matching. The guard matched path
// STRINGS; a Bash-created symlink (`ln -s prod gate`) is not an rm shape, so
// it was allowed, and a structured write THROUGH it resolved lexically to
// `gate/...`, which no deny pattern covers — while the bytes landed in prod/.
// The fix matches the realpath-resolved candidate IN ADDITION to the raw path
// (deny-widening only: resolution may create denies, never remove them).
//
// These tests run against a real filesystem because symlink resolution is the
// thing under test. tempRepo() lives under macOS /var (-> /private/var), so
// every expectation here is also exercised across a root that differs from
// its own realpath.
// ---------------------------------------------------------------------------
describe("protected-paths: symlink resolution (F1)", () => {
  // Layout per test:
  //   repo/prod/           (protected dir)
  //   repo/.env            (protected file)
  //   repo/realsrc/        (NOT protected — the over-broad-fix tripwire)
  //   repo/gate            -> prod      (dir symlink)
  //   repo/settings.conf   -> .env      (file symlink)
  //   repo/srclink         -> realsrc   (dir symlink to an allowed target)
  function setup(): { repo: string; cleanup: () => void } {
    const repo = tempRepo();
    mkdirSync(join(repo, "prod"));
    mkdirSync(join(repo, "realsrc"));
    writeFileSync(join(repo, ".env"), "S=1");
    symlinkSync(join(repo, "prod"), join(repo, "gate"));
    symlinkSync(join(repo, ".env"), join(repo, "settings.conf"));
    symlinkSync(join(repo, "realsrc"), join(repo, "srclink"));
    return { repo, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
  }

  function edit(path: string): ToolCall {
    return { toolName: "Edit", toolInput: { file_path: path, old_string: "a", new_string: "b" } };
  }
  function multiEdit(path: string): ToolCall {
    return {
      toolName: "MultiEdit",
      toolInput: { edits: [{ file_path: path, old_string: "a", new_string: "b" }] },
    };
  }
  function notebook(path: string): ToolCall {
    return { toolName: "NotebookEdit", toolInput: { notebook_path: path, content: "{}" } };
  }

  it("denies Write through a dir symlink into a protected dir", () => {
    const { repo, cleanup } = setup();
    try {
      const call = write(join(repo, "gate", "evil.txt"));
      expect(protectedPathsGuard(call, defaultPolicy(repo)).action).toBe("deny");
    } finally {
      cleanup();
    }
  });

  it("denies Edit through a dir symlink into a protected dir", () => {
    const { repo, cleanup } = setup();
    try {
      const call = edit(join(repo, "gate", "config.yaml"));
      expect(protectedPathsGuard(call, defaultPolicy(repo)).action).toBe("deny");
    } finally {
      cleanup();
    }
  });

  it("denies MultiEdit through a dir symlink into a protected dir", () => {
    const { repo, cleanup } = setup();
    try {
      const call = multiEdit(join(repo, "gate", "x.txt"));
      expect(protectedPathsGuard(call, defaultPolicy(repo)).action).toBe("deny");
    } finally {
      cleanup();
    }
  });

  it("denies NotebookEdit through a file symlink onto a protected file", () => {
    const { repo, cleanup } = setup();
    try {
      const call = notebook(join(repo, "settings.conf"));
      expect(protectedPathsGuard(call, defaultPolicy(repo)).action).toBe("deny");
    } finally {
      cleanup();
    }
  });

  it("denies Write through a file symlink onto a protected file", () => {
    const { repo, cleanup } = setup();
    try {
      const call = write(join(repo, "settings.conf"));
      expect(protectedPathsGuard(call, defaultPolicy(repo)).action).toBe("deny");
    } finally {
      cleanup();
    }
  });

  it("denies rm through a dir symlink into a protected dir", () => {
    const { repo, cleanup } = setup();
    try {
      const call = bash(`rm ${join(repo, "gate", "evil.txt")}`);
      expect(protectedPathsGuard(call, defaultPolicy(repo)).action).toBe("deny");
    } finally {
      cleanup();
    }
  });

  it("denies when the leaf chain does not exist yet (deepest-existing rejoin)", () => {
    const { repo, cleanup } = setup();
    try {
      // gate/a/b/c.txt: only `gate` exists; realpath of the deepest existing
      // ancestor is prod/, so this must deny as prod/a/b/c.txt.
      const call = write(join(repo, "gate", "a", "b", "c.txt"));
      expect(protectedPathsGuard(call, defaultPolicy(repo)).action).toBe("deny");
    } finally {
      cleanup();
    }
  });

  it("still allows writes through a symlink to a NON-protected target", () => {
    // The regression that catches an over-broad realpath fix: resolution must
    // widen denies, never create new ones.
    const { repo, cleanup } = setup();
    try {
      const call = write(join(repo, "srclink", "app.ts"));
      expect(protectedPathsGuard(call, defaultPolicy(repo)).action).toBe("allow");
    } finally {
      cleanup();
    }
  });
});

describe("blocked-commands guard", () => {
  it("denies force-push to main (flag-first)", () => {
    expect(blockedCommandsGuard(bash("git push --force origin main"), policy).action).toBe("deny");
  });
  it("denies force-push to main with TRAILING flag (order-independent)", () => {
    // Regression: the old positional regex missed this common ordering.
    expect(blockedCommandsGuard(bash("git push origin main --force"), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash("git push origin main -f"), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash("git push origin master --force"), policy).action).toBe("deny");
  });
  it("denies unconditional force-push (bare, and remote-only)", () => {
    expect(blockedCommandsGuard(bash("git push --force"), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash("git push origin --force"), policy).action).toBe("deny");
  });
  it("denies HEAD:main force-push", () => {
    expect(blockedCommandsGuard(bash("git push --force origin HEAD:main"), policy).action).toBe("deny");
  });
  it("allows --force-with-lease, even to main (the safe variant)", () => {
    expect(blockedCommandsGuard(bash("git push --force-with-lease origin feature"), policy).action).toBe("allow");
    expect(blockedCommandsGuard(bash("git push --force-with-lease origin main"), policy).action).toBe("allow");
  });
  it("allows force-push to a feature branch whose name contains 'main'/'master'", () => {
    // Regression: the old `\b(main|master)\b` word-match false-positived here.
    expect(blockedCommandsGuard(bash("git push -f origin feature/main-nav"), policy).action).toBe("allow");
    expect(blockedCommandsGuard(bash("git push --force origin release-main"), policy).action).toBe("allow");
    expect(blockedCommandsGuard(bash("git push origin hotfix/master-fix --force"), policy).action).toBe("allow");
  });
  it("allows an ordinary force-push to an explicit feature branch", () => {
    expect(blockedCommandsGuard(bash("git push --force origin develop"), policy).action).toBe("allow");
  });
  it("denies DROP TABLE", () => {
    expect(blockedCommandsGuard(bash('psql -c "DROP TABLE users"'), policy).action).toBe("deny");
  });
  // Regression: content patterns fired on text that merely MENTIONS SQL, so
  // `echo "drop table"` was denied. Matching is on the command's effect, not
  // on the presence of a destructive word anywhere in the string.
  it("allows text-only commands that merely mention destructive SQL", () => {
    expect(blockedCommandsGuard(bash('echo "drop table"'), policy).action).toBe("allow");
    expect(blockedCommandsGuard(bash('echo "DROP TABLE users"'), policy).action).toBe("allow");
    expect(blockedCommandsGuard(bash('grep -r "drop table" ./docs'), policy).action).toBe("allow");
    expect(blockedCommandsGuard(bash('rg "DROP DATABASE" src/'), policy).action).toBe("allow");
    expect(blockedCommandsGuard(bash('cat migrations/README.md | grep -i "truncate table"'), policy).action).toBe("allow");
  });

  it("STILL denies real destructive SQL when a text command is in the pipeline", () => {
    // The whole point of the whole-command rule: a per-segment skip would let
    // these through, converting a false positive into a false negative.
    expect(blockedCommandsGuard(bash('echo "DROP TABLE users" | psql'), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash('echo "DROP TABLE users" | psql -d prod'), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash('grep -i "drop table" x.sql && psql -c "DROP TABLE users"'), policy).action).toBe("deny");
  });

  it("does not treat command substitution or redirection as inert", () => {
    // `echo` reads as harmless, but the substitution actually runs mkfs.
    expect(blockedCommandsGuard(bash("echo $(mkfs.ext4 /dev/sda)"), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash("echo `mkfs.ext4 /dev/sda`"), policy).action).toBe("deny");
    // Writing the statement into a file is a side effect, not just printing.
    expect(blockedCommandsGuard(bash('echo "DROP TABLE users" > wipe.sql'), policy).action).toBe("deny");
  });

  it("does not treat PROCESS substitution as inert", () => {
    // `<(...)` is neither a pipe nor a quoted string, so a segment splitter
    // reads `cat <(psql ...)` as a lone `cat` while the shell really does run
    // the psql inside it. main denied these; the skip must not turn that into
    // an allow.
    expect(blockedCommandsGuard(bash('cat <(psql -c "DROP TABLE users")'), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash('echo <(psql -c "DROP TABLE users")'), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash('grep x <(psql -c "DROP TABLE users")'), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash("cat <(mkfs.ext4 /dev/sda)"), policy).action).toBe("deny");
  });

  it("does not treat a bare & as a segment separator it can ignore", () => {
    // A single `&` backgrounds the first command and runs the second. It is
    // not one of the separators the splitter knows, so the whole string used
    // to reduce to an inert `echo`.
    expect(blockedCommandsGuard(bash('echo harmless & psql -c "DROP TABLE users"'), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash('echo hi &psql -c "DROP TABLE users"'), policy).action).toBe("deny");
  });

  it("never skips a customer-authored rule, however inert the command looks", () => {
    // The skip exists for the built-in prose-sensitive defaults only. If an
    // operator bans `echo`, the guard does not get to overrule them.
    const custom = { ...policy, blockedCommands: [{ pattern: "\\becho\\b", message: "no echo" }] };
    expect(blockedCommandsGuard(bash("echo harmless"), custom).action).toBe("deny");
    const secrets = { ...policy, blockedCommands: [{ pattern: "id_rsa", message: "no key reads" }] };
    expect(blockedCommandsGuard(bash("cat ~/.ssh/id_rsa"), secrets).action).toBe("deny");
  });

  it("knows single quotes are literal but double quotes still substitute", () => {
    // Double quotes do NOT make $(...) or backticks safe — the shell runs
    // them — so a quoted substitution must never read as inert prose.
    expect(blockedCommandsGuard(bash('echo "$(psql -c \'DROP TABLE users\')"'), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash('echo "`psql -c \'DROP TABLE users\'`"'), policy).action).toBe("deny");
    // Single quotes genuinely are literal, so this one stays allowed.
    expect(blockedCommandsGuard(bash("echo 'DROP TABLE users $(whoami)'"), policy).action).toBe("allow");
  });

  it("requires a bare executable token, not a path basename", () => {
    // `./echo` is a local script that can do anything; matching on the
    // basename would let it inherit the allowlist.
    expect(blockedCommandsGuard(bash('./echo "DROP TABLE users"'), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash('/tmp/echo "DROP TABLE users"'), policy).action).toBe("deny");
  });

  it("rejects allowlisted text tools carrying an execution hook", () => {
    expect(blockedCommandsGuard(bash('rg --pre=./run.sh "DROP TABLE"'), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash('rg --pre ./run.sh "DROP TABLE"'), policy).action).toBe("deny");
    // QUOTED options are still options. Deleting quoted tokens as "prose"
    // hides the flag while the shell passes it to rg verbatim.
    expect(blockedCommandsGuard(bash('rg "--pre=./run.sh" "DROP TABLE" src/'), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash('rg "--pre" "./run.sh" "DROP TABLE" src/'), policy).action).toBe("deny");
    // A leading assignment can arm a preprocessor without being an executable.
    expect(blockedCommandsGuard(bash('LESSOPEN="|./x.sh %s" less "DROP TABLE users"'), policy).action).toBe("deny");
    // Trimmed from the allowlist: pagers, sort (-o/--compress-program), yq -i.
    expect(blockedCommandsGuard(bash('less "DROP TABLE users"'), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash('sort --compress-program=./x.sh "DROP TABLE users"'), policy).action).toBe("deny");
  });

  it("treats an unrecognised executable as capable of executing (unknown ⇒ scan)", () => {
    expect(blockedCommandsGuard(bash('somesqltool "DROP TABLE users"'), policy).action).toBe("deny");
    // sed/awk are deliberately NOT inert — both can execute.
    expect(blockedCommandsGuard(bash('sed -n "s/DROP TABLE/x/p" f.sql'), policy).action).toBe("deny");
    expect(blockedCommandsGuard(bash('awk "/DROP TABLE/" f.sql'), policy).action).toBe("deny");
  });

  it("denies rm targeting a filesystem root", () => {
    expect(blockedCommandsGuard(bash("rm -rf /"), policy).action).toBe("deny");
  });
  it("denies rm escaping the workspace via ..", () => {
    expect(blockedCommandsGuard(bash("rm -rf ../../etc"), policy).action).toBe("deny");
  });
  it("allows rm inside the workspace", () => {
    expect(blockedCommandsGuard(bash("rm -rf build/"), policy).action).toBe("allow");
  });
  it("allows an ordinary command", () => {
    expect(blockedCommandsGuard(bash("npm test"), policy).action).toBe("allow");
  });
  it("abstains on non-Bash tools", () => {
    expect(blockedCommandsGuard(write("/repo/src/x.ts"), policy).action).toBe("allow");
  });
  it("survives a malformed user regex without throwing", () => {
    const p = defaultPolicy(ROOT);
    p.blockedCommands = [{ pattern: "(" }];
    expect(() => blockedCommandsGuard(bash("echo hi"), p)).not.toThrow();
    expect(blockedCommandsGuard(bash("echo hi"), p).action).toBe("allow");
  });
});

describe("budget guard", () => {
  const base = { byModel: {}, unpricedModels: [] };
  it("denies when session cap is reached", () => {
    const v = budgetGuard({ ...base, sessionUsd: 5.01, dayUsd: 5.01 }, policy);
    expect(v.action).toBe("deny");
    expect(v.rule).toContain("session");
  });
  it("denies when daily cap is reached", () => {
    const v = budgetGuard({ ...base, sessionUsd: 1, dayUsd: 20 }, policy);
    expect(v.action).toBe("deny");
    expect(v.rule).toContain("daily");
  });
  it("allows under both caps", () => {
    expect(budgetGuard({ ...base, sessionUsd: 1, dayUsd: 2 }, policy).action).toBe("allow");
  });
  it("disables a cap set to 0", () => {
    const p = defaultPolicy(ROOT);
    p.budget.sessionUsd = 0;
    expect(budgetGuard({ ...base, sessionUsd: 1000, dayUsd: 1 }, p).action).toBe("allow");
  });
});

describe("loop guard", () => {
  const cfg = { maxRepeats: 3, windowSeconds: 300 };
  const call: ToolCall = { toolName: "Bash", toolInput: { command: "npm test" } };

  it("freezes after maxRepeats identical calls in the window", () => {
    let state = emptyLoopState();
    const sig = signatureFor(call);
    let last;
    for (let i = 0; i < 3; i++) {
      const r = loopCheck(state, sig, 1000 + i * 10, cfg);
      state = r.state;
      last = r.verdict;
    }
    expect(last!.action).toBe("deny");
  });

  it("does not freeze when arguments differ", () => {
    let state = emptyLoopState();
    let last;
    for (let i = 0; i < 5; i++) {
      const c: ToolCall = { toolName: "Bash", toolInput: { command: `echo ${i}` } };
      const r = loopCheck(state, signatureFor(c), 1000 + i * 10, cfg);
      state = r.state;
      last = r.verdict;
    }
    expect(last!.action).toBe("allow");
  });

  it("forgets calls outside the window", () => {
    let state = emptyLoopState();
    const sig = signatureFor(call);
    // Two hits far apart, then two close — should not reach 3 within window.
    state = loopCheck(state, sig, 0, cfg).state;
    state = loopCheck(state, sig, 1_000_000, cfg).state; // >300s later; prunes the first
    const r = loopCheck(state, sig, 1_000_000 + 5000, cfg);
    expect(r.verdict.action).toBe("allow");
  });

  it("produces identical signatures regardless of key order", () => {
    const a: ToolCall = { toolName: "Edit", toolInput: { file_path: "x", old_string: "a", new_string: "b" } };
    const b: ToolCall = { toolName: "Edit", toolInput: { new_string: "b", file_path: "x", old_string: "a" } };
    expect(signatureFor(a)).toBe(signatureFor(b));
  });
});

// KNOWN LIMITATION, pinned deliberately: hard links.
//
// The F1 fix resolves symlinks because `realpath` can see them. A hard link is
// a second directory entry for the SAME inode, so there is no link to resolve
// and no path relationship to discover — `realpath` on the alias returns the
// alias. Matching on paths therefore cannot see it.
//
// These tests assert the CURRENT (permissive) verdicts on purpose. They are a
// tripwire, not an endorsement: if someone lands inode comparison, these go red
// and must be flipped to `deny` in the same change. The exposure is bounded —
// `ln` cannot create a hard link to a directory (the OS refuses), so no NEW
// file can appear inside a protected dir this way; only modification of an
// already-existing protected file is reachable. The allowed write is still
// recorded in the ledger, so the evidence half keeps working. See README
// "What it does and doesn't stop" and
// https://github.com/laqaer/bulkhead-cli/issues/3.
describe("protected-paths: hard links are NOT covered (documented limitation)", () => {
  function setup(): { repo: string; cleanup: () => void } {
    const repo = tempRepo();
    mkdirSync(join(repo, "prod"));
    writeFileSync(join(repo, ".env"), "S=1");
    writeFileSync(join(repo, "prod", "config.txt"), "k=v");
    linkSync(join(repo, ".env"), join(repo, "hardcopy.conf"));
    linkSync(join(repo, "prod", "config.txt"), join(repo, "sneaky.txt"));
    return { repo, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
  }

  it("allows a Write through a hard link onto a protected file", () => {
    const { repo, cleanup } = setup();
    try {
      const call = write(join(repo, "hardcopy.conf"));
      expect(protectedPathsGuard(call, defaultPolicy(repo)).action).toBe("allow");
    } finally {
      cleanup();
    }
  });

  it("allows a Write through a hard link to a file inside a protected dir", () => {
    const { repo, cleanup } = setup();
    try {
      const call = write(join(repo, "sneaky.txt"));
      expect(protectedPathsGuard(call, defaultPolicy(repo)).action).toBe("allow");
    } finally {
      cleanup();
    }
  });

  it("still denies the protected originals by their real paths", () => {
    const { repo, cleanup } = setup();
    try {
      expect(protectedPathsGuard(write(join(repo, ".env")), defaultPolicy(repo)).action).toBe("deny");
      expect(
        protectedPathsGuard(write(join(repo, "prod", "config.txt")), defaultPolicy(repo)).action,
      ).toBe("deny");
    } finally {
      cleanup();
    }
  });

  it("cannot hard-link a directory, so no new file can be created inside prod/", () => {
    const { repo, cleanup } = setup();
    try {
      let code = "NONE";
      try {
        linkSync(join(repo, "prod"), join(repo, "gatedir"));
      } catch (e) {
        code = (e as NodeJS.ErrnoException).code ?? "UNKNOWN";
      }
      expect(code).not.toBe("NONE");
    } finally {
      cleanup();
    }
  });
});
