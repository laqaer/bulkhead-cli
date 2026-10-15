import { describe, expect, it, vi } from "vitest";
import { assessRisk } from "../src/risk.js";
import { riskyGuard } from "../src/guards/risky.js";
import { blockedCommandsGuard } from "../src/guards/blocked-commands.js";
import { defaultPolicy } from "../src/policy.js";
import { isCredentialStorePath, shellReadTargets } from "../src/extract.js";
import type { ToolCall } from "../src/types.js";

// A fixed home, so the tests do not depend on where the machine keeps its own.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/home/dev" };
});

function bash(command: string): ToolCall {
  return { toolName: "Bash", toolInput: { command } };
}

const signalIds = (command: string) => assessRisk(bash(command)).signals.map((s) => s.id);

describe("credential-read signal: well-known credential stores", () => {
  it.each([
    "cat ~/.pgpass 2>/dev/null",
    "cat ~/.aws/credentials",
    "cat ~/.ssh/id_ed25519",
    "cat ~/.ssh/id_rsa",
    "cat ~/.netrc",
    "cat ~/.git-credentials",
    "cat ~/.config/gcloud/application_default_credentials.json",
    // The same files, however the path is spelled.
    'cat "$HOME/.aws/credentials"',
    "cat '${HOME}/.ssh/id_ed25519'",
    "head -n 1 /home/dev/.netrc",
    "cat ~/.ssh/id_*",
    // Print and copy commands other than cat, and an input redirection.
    "grep password ~/.pgpass",
    "base64 < ~/.ssh/id_rsa",
    "cp ~/.aws/credentials /tmp/c",
    "tar czf /tmp/k.tgz ~/.ssh/id_rsa",
    "xxd ~/.ssh/id_ed25519",
    // Wrapped, chained, inside a subshell string, or on a later line.
    "sudo cat ~/.git-credentials",
    "echo ok && cat ~/.pgpass",
    "sh -c 'cat ~/.pgpass'",
    "ls\ncat ~/.aws/credentials",
  ])("flags %s", (command) => {
    expect(signalIds(command)).toContain("credential-read");
  });

  it("reports the file that was read, and is high level", () => {
    const a = assessRisk(bash("cat ~/.pgpass"));
    expect(a.level).toBe("high");
    expect(a.signals).toContainEqual({
      id: "credential-read",
      level: "high",
      reason: "reads a credential file (~/.pgpass)",
    });
  });

  it("raises one signal per command, however many files it names", () => {
    const ids = signalIds("cat ~/.pgpass ~/.netrc ~/.aws/credentials");
    expect(ids.filter((id) => id === "credential-read")).toHaveLength(1);
  });
});

describe("credential-read signal: ordinary work is not flagged", () => {
  it.each([
    // A public key, and files that configure rather than hold secrets.
    "cat ~/.ssh/id_ed25519.pub",
    "cat ~/.ssh/config",
    "cat ~/.ssh/known_hosts",
    "cat ~/.aws/config",
    "cat ~/.profile",
    "cat ~/.gitconfig",
    // Not under the home directory, or not the home's own file.
    "cat .pgpass",
    "cat ./.netrc",
    "cat ~/code/project/.netrc",
    "cat /etc/hosts",
    "cat /home/dev-other/.pgpass",
    "cat ~alice/.pgpass",
    // Commands that do not print or copy contents, and text that only names a file.
    "ls -l ~/.aws/credentials",
    "test -f ~/.pgpass && echo present",
    'echo "see ~/.pgpass"',
    'git commit -m "document how ~/.aws/credentials is loaded"',
    "psql service=staging -c 'select 1'",
    "aws sts get-caller-identity",
    "npm test",
  ])("does not flag %s", (command) => {
    expect(signalIds(command)).not.toContain("credential-read");
  });
});

describe("credential-read signal: the approval gate", () => {
  const read = bash("cat ~/.pgpass");

  it("asks under risky.mode = ask", () => {
    const p = defaultPolicy("/repo");
    p.risky.mode = "ask";
    const v = riskyGuard(assessRisk(read), p);
    expect(v.action).toBe("ask");
    expect(v.reason).toContain("reads a credential file (~/.pgpass)");
  });

  it("still asks when only high-risk actions pause", () => {
    const p = defaultPolicy("/repo");
    p.risky.mode = "ask";
    p.risky.minLevel = "high";
    expect(riskyGuard(assessRisk(read), p).action).toBe("ask");
  });

  it("changes nothing at the default policy: scored and recorded, not paused or denied", () => {
    const p = defaultPolicy("/repo");
    expect(p.risky.mode).toBe("off");
    expect(riskyGuard(assessRisk(read), p).action).toBe("allow");
    expect(blockedCommandsGuard(read, p).action).toBe("allow");
  });
});

describe("shellReadTargets", () => {
  it("returns the operands of print and copy commands and the source of <", () => {
    expect(shellReadTargets("cat a.txt b.txt")).toEqual(["a.txt", "b.txt"]);
    expect(shellReadTargets("base64 < key.pem")).toEqual(["key.pem"]);
    expect(shellReadTargets('cat "my file"')).toEqual(["my file"]);
  });

  it("reads inside sh -c and past wrappers", () => {
    expect(shellReadTargets("sh -c 'cat ~/.netrc'")).toEqual(["~/.netrc"]);
    expect(shellReadTargets("sudo cat /x")).toEqual(["/x"]);
  });

  it("ignores commands that do not print or copy contents, and here-strings", () => {
    expect(shellReadTargets("ls -l ~/.pgpass")).toEqual([]);
    expect(shellReadTargets("echo ~/.pgpass")).toEqual([]);
    expect(shellReadTargets("cat <<< ~/.pgpass")).toEqual([]);
  });
});

describe("isCredentialStorePath", () => {
  it("resolves ~, $HOME and absolute paths against the home directory", () => {
    expect(isCredentialStorePath("~/.pgpass")).toBe(true);
    expect(isCredentialStorePath("$HOME/.pgpass")).toBe(true);
    expect(isCredentialStorePath("/home/dev/.pgpass")).toBe(true);
    expect(isCredentialStorePath("/home/dev/sub/../.pgpass")).toBe(true);
  });

  it("matches nothing outside the home directory or off the list", () => {
    expect(isCredentialStorePath("/home/other/.pgpass")).toBe(false);
    expect(isCredentialStorePath("/home/dev/projects/.pgpass")).toBe(false);
    expect(isCredentialStorePath("~/.ssh/id_rsa.pub")).toBe(false);
    expect(isCredentialStorePath("~/.ssh/")).toBe(false);
    expect(isCredentialStorePath("~")).toBe(false);
    expect(isCredentialStorePath("")).toBe(false);
  });
});
