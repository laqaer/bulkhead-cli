import { describe, expect, it } from "vitest";
import { bulkheadSelfCommand, shellWriteTargets } from "../src/extract.js";
import { protectedPathsGuard } from "../src/guards/protected-paths.js";
import { blockedCommandsGuard } from "../src/guards/blocked-commands.js";
import { defaultPolicy } from "../src/policy.js";
import { tempRepo } from "./helpers.js";

const bash = (command: string) => ({ toolName: "Bash", toolInput: { command } });

describe("shellWriteTargets", () => {
  it.each([
    ["echo hi > out.txt", ["out.txt"]],
    ["echo hi >> log.txt 2>&1", ["log.txt"]],
    ["cmd &> all.log", ["all.log"]],
    ["cmd 2> err.log", ["err.log"]],
    ["echo x >file.txt", ["file.txt"]],
    ["echo x | tee -a a.txt b.txt", ["a.txt", "b.txt"]],
    ["sed -i 's/a/b/' bulkhead.yaml", ["bulkhead.yaml"]],
    ["sed -i.bak -e 's/a/b/' -e 's/c/d/' conf.yml", ["conf.yml"]],
    ["sed -i '' 's/a/b/' x.txt", ["x.txt"]],
    ["perl -pi -e 's/5/500/' bulkhead.yaml", ["bulkhead.yaml"]],
    ["cp .env.example .env", [".env"]],
    ["mv bulkhead.yaml /tmp/old.yaml", ["bulkhead.yaml", "/tmp/old.yaml"]],
    ["truncate -s 0 .bulkhead/ledger.jsonl", [".bulkhead/ledger.jsonl"]],
    ["dd if=/dev/zero of=disk.img bs=1M count=1", ["disk.img"]],
    ["ln -sf /dev/null .claude/settings.json", [".claude/settings.json"]],
    ["sudo tee /etc/hosts < hosts", ["/etc/hosts"]],
    ["FOO=1 env sed -i s/a/b/ f.txt", ["f.txt"]],
    // -t / --target-directory: the destination is the directory plus each source's name.
    ["cp -t .claude tmp/settings.json", [".claude/settings.json"]],
    ["cp --target-directory=.claude tmp/settings.json", [".claude/settings.json"]],
    ["cp --target-directory .claude tmp/settings.json", [".claude/settings.json"]],
    ["cp --target .claude tmp/settings.json", [".claude/settings.json"]],
    ["cp -t.claude tmp/settings.json", [".claude/settings.json"]],
    ["cp -rt .claude a b/c.txt", [".claude/a", ".claude/c.txt"]],
    ["cp -t .bulkhead/ tmp/ledger.jsonl", [".bulkhead/ledger.jsonl"]],
    ["cp -t .claude -- -odd tmp/x", [".claude/-odd", ".claude/x"]],
    ["install -m 644 -t .claude tmp/settings.json", [".claude/settings.json"]],
    ["mv -t .claude tmp/settings.json", ["tmp/settings.json", ".claude/settings.json"]],
    ["ln -f -t .claude tmp/settings.json", [".claude/settings.json"]],
    ["ln -ft .claude tmp/settings.json", [".claude/settings.json"]],
    ["cp -t build src/a.ts", ["build/a.ts"]],
  ])("%s → %j", (cmd, expected) => {
    expect(shellWriteTargets(cmd)).toEqual(expected);
  });

  it.each([
    "cat bulkhead.yaml",
    "grep session_usd bulkhead.yaml",
    "sed 's/a/b/' bulkhead.yaml",
    'echo "sed -i x bulkhead.yaml > .env"',
    "git commit -m 'write > bulkhead.yaml'",
    "npm test > /dev/null 2>&1",
    "cp bulkhead.yaml",
    "cp -t build",
    "ln -t .claude tmp/x",
    "ls -la && echo done",
  ])("no write target in %s", (cmd) => {
    expect(shellWriteTargets(cmd)).toEqual([]);
  });
});

describe("protected paths through the shell", () => {
  const root = tempRepo();
  const policy = defaultPolicy(root);

  it.each([
    "sed -i 's/session_usd: 5/session_usd: 500/' bulkhead.yaml",
    "perl -pi -e 's/block/off/' bulkhead.yaml",
    "echo 'verify: {mode: off}' >> bulkhead.yaml",
    "mv bulkhead.yaml bulkhead.yaml.off",
    "truncate -s 0 .bulkhead/ledger.jsonl",
    "echo '{}' > .claude/settings.json",
    "ln -sf /dev/null .claude/settings.local.json",
    'echo "DATABASE_URL=postgres://prod" > .env',
    "cp .env.example .env",
    "printf x | tee prod/config.yaml",
    "cat /tmp/m.sql > migrations/001_init.sql",
    // -t / --target-directory must not hide the destination.
    "cp -t .claude tmp/settings.json",
    "cp --target-directory=.claude tmp/settings.json",
    "cp --target-directory .claude tmp/settings.local.json",
    "cp -t.claude tmp/settings.json",
    "install -t .claude tmp/settings.json",
    "mv -t .claude tmp/settings.json",
    "ln -f -t .claude tmp/settings.json",
    "cp -t .bulkhead tmp/ledger.jsonl",
    "cp -t . tmp/.env",
  ])("denies %s", (cmd) => {
    const v = protectedPathsGuard(bash(cmd), policy);
    expect(v.action, cmd).toBe("deny");
    expect(v.reason).toMatch(/protected path|boundary/);
  });

  it.each([
    "echo ok > notes.txt",
    "sed -i 's/a/b/' src/app.ts",
    "cat bulkhead.yaml",
    "grep -n verify bulkhead.yaml > /tmp/out.txt",
    "cp README.md docs/README.md",
    "cp -t docs README.md",
    "cp -t .claude tmp/notes.md",
    'git commit -m "tighten bulkhead.yaml"',
    "npm test 2>&1 | tee test-output.log",
  ])("allows %s", (cmd) => {
    expect(protectedPathsGuard(bash(cmd), policy).action, cmd).toBe("allow");
    expect(blockedCommandsGuard(bash(cmd), policy).action, cmd).toBe("allow");
  });
});

describe("bulkheadSelfCommand — the agent can't re-run Bulkhead's own installer", () => {
  it.each([
    ["bulkhead init", "init"],
    ["bulkhead init --force --preset default", "init"],
    ["npx --yes @bulkheadtools/cli init --force", "init"],
    ["npx @bulkheadtools/cli@0.2.0 init", "init"],
    ["npx -y -p @bulkheadtools/cli bulkhead init", "init"],
    ['bulkhead init --command "true"', "init"],
    ["npm exec -- @bulkheadtools/cli init", "init"],
    ["pnpm dlx @bulkheadtools/cli uninstall", "uninstall"],
    ["bunx @bulkheadtools/cli uninstall", "uninstall"],
    ["./node_modules/.bin/bulkhead uninstall", "uninstall"],
    ["node node_modules/@bulkheadtools/cli/dist/cli.js init --force", "init"],
    ["node /home/me/bulkhead/packages/core/dist/cli.js init --force", "init"],
    ["node ../bulkhead-cli/dist/cli.js uninstall", "uninstall"],
    ["cd sub && sudo bulkhead init", "init"],
    ["bash -c 'npx @bulkheadtools/cli init --force'", "init"],
  ])("%s → %s", (cmd, expected) => {
    expect(bulkheadSelfCommand(cmd)).toBe(expected);
  });

  it.each([
    "npx @bulkheadtools/cli demo",
    "npx @bulkheadtools/cli receipt --last",
    "bulkhead ledger verify",
    "bulkhead init --help",
    "npm init -y",
    "git init",
    "terraform init",
    "npx create-next-app init",
    "node scripts/cli.js init",
    "node /home/me/bulkhead/scripts/seed.js init",
    "echo 'bulkhead init --force'",
    "git commit -m 'run bulkhead init'",
  ])("%s → null", (cmd) => {
    expect(bulkheadSelfCommand(cmd)).toBeNull();
  });

  it("protectedPathsGuard denies it with a reason that names the human's job", () => {
    const repo = tempRepo();
    const v = protectedPathsGuard(bash("npx --yes @bulkheadtools/cli init --force"), defaultPolicy(repo));
    expect(v.action).toBe("deny");
    expect(v.rule).toBe("bulkhead-self-install");
    expect(v.reason).toMatch(/human runs it from their own terminal/);
  });

  it("sh -c scripts get the ordinary shell-write check too", () => {
    expect(shellWriteTargets("bash -c 'echo {} > .claude/settings.json'")).toEqual([".claude/settings.json"]);
    expect(shellWriteTargets("sh -lc \"sed -i s/5/500/ bulkhead.yaml\"")).toEqual(["bulkhead.yaml"]);
  });
});
