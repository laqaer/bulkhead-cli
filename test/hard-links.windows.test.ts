import { beforeEach, describe, expect, it, vi } from "vitest";
import picomatch from "picomatch";
import { scanHardLinks } from "../src/guards/hard-links.js";

// Exercise Windows path planning on every CI host. Directory names remain
// case-sensitive in this fixture so literal prefix traversal cannot pass.
const fixture = vi.hoisted(() => ({
  dirs: new Map<string, string[]>(),
  files: new Map<string, bigint>(),
  unreadable: new Set<string>(),
  reads: [] as string[],
}));

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, ...actual.win32 };
});

vi.mock("node:fs", () => {
  const missing = (path: string): never => {
    throw Object.assign(new Error(`Missing fixture path: ${path}`), { code: "ENOENT" });
  };
  const stat = (path: string) => {
    const directory = fixture.dirs.has(path);
    const ino = fixture.files.get(path);
    if (!directory && ino === undefined) return missing(path);
    return {
      dev: 1n,
      ino: ino ?? 0n,
      nlink: 2n,
      isDirectory: () => directory,
    };
  };
  return {
    statSync: stat,
    lstatSync: stat,
    realpathSync: (path: string) => {
      if (!fixture.files.has(path) && !fixture.dirs.has(path)) return missing(path);
      return path;
    },
    readdirSync: (path: string) => {
      fixture.reads.push(path);
      if (fixture.unreadable.has(path)) {
        throw Object.assign(new Error(`Unreadable fixture path: ${path}`), { code: "EACCES" });
      }
      const names = fixture.dirs.get(path);
      if (!names) return missing(path);
      return names.map((name) => ({
        name,
        isDirectory: () => fixture.dirs.has(`${path}${path.endsWith("\\") ? "" : "\\"}${name}`),
        isSymbolicLink: () => false,
      }));
    },
  };
});

const target = "C:\\workspace\\copy.txt";
const protectedName = "C:\\host\\secrets\\key.pem";

function scan(pattern: string, limit = 100) {
  const match = picomatch(pattern, { dot: true, nocase: true });
  return scanHardLinks(target, {
    root: "C:\\workspace",
    rootReal: "C:\\workspace",
    patterns: [pattern],
    classify: (path) => match(path.split("\\").join("/"))
      ? { action: "deny", guard: "protected-paths", rule: pattern }
      : null,
    limit,
  });
}

describe("hard-link scan: Windows drive-absolute patterns", () => {
  beforeEach(() => {
    fixture.dirs.clear();
    fixture.files.clear();
    fixture.unreadable.clear();
    fixture.reads.length = 0;
    fixture.dirs.set("C:\\", ["workspace", "host"]);
    fixture.dirs.set("C:\\workspace", ["copy.txt"]);
    fixture.dirs.set("C:\\host", ["secrets"]);
    fixture.dirs.set("C:\\host\\secrets", ["key.pem"]);
    fixture.files.set(target, 42n);
    fixture.files.set(protectedName, 42n);
  });

  it.each([
    "C:/host/secrets/**",
    "C:/host/secrets/key.pem",
    "C:/HOST/SECRETS/**",
    "C:/**",
  ])("finds a protected alias for %s from the drive root", (pattern) => {
    expect(scan(pattern)).toMatchObject({
      kind: "alias",
      path: protectedName,
      verdict: { action: "deny", rule: pattern },
    });
    expect(fixture.reads).toContain("C:\\");
  });

  it("leaves an unprotected multiply-linked file clear", () => {
    expect(scan("C:/host/other-secrets/**").kind).toBe("clear");
  });

  it("fails closed when drive-root prefix enumeration exhausts the budget", () => {
    expect(scan("C:/host/secrets/**", 0)).toMatchObject({
      kind: "unverifiable",
      detail: "scan stopped after 0 directory entries",
    });
  });

  it("fails closed when a matching anchored prefix is unreadable", () => {
    fixture.unreadable.add("C:\\host");
    expect(scan("C:/HOST/secrets/**")).toMatchObject({
      kind: "unverifiable",
      detail: "cannot read `C:\\host` (EACCES)",
    });
  });

  it("does not scan a drive root alone, which cannot be a file alias", () => {
    expect(scan("C:/", 0).kind).toBe("clear");
    expect(fixture.reads).toEqual([]);
  });
});
