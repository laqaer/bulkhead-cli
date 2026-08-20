import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `package.json` is a published contract, not implementation source: npm
 * ships it verbatim and renders `repository`, `homepage` and `bugs` as the
 * links on the package listing.
 *
 * `0.1.1` shipped all three naming `laqaer/bulkhead`, which is PRIVATE, so
 * every link 404'd for every anonymous visitor. The publish gate stayed green
 * through it because nothing asserted on these fields. `prepublishOnly` runs
 * this suite, so this file is what makes the gate refuse that release.
 *
 * Substring trap: `laqaer/bulkhead` IS a prefix of `laqaer/bulkhead-cli`, so
 * a containment check passes on the wrong repo. Two complementary checks:
 * PRIVATE_REPO_RE rejects the private repo on the name boundary, and each URL
 * is parsed into host plus owner/repo path segments and compared
 * segment-whole against the public one.
 */
const PUBLIC_REPO = { host: "github.com", owner: "laqaer", repo: "bulkhead-cli" };

/* Copied VERBATIM from PR #13 — the shared definition now lives in the repo
   root at test-guards/repoLinks.ts, used by apps/status and apps/site. This
   package cannot import it: packages/core is mirrored byte-identical into the
   standalone laqaer/bulkhead-cli repo, where a path outside packages/core does
   not resolve. Keep this literal character-for-character identical to the
   shared one; two independently-authored patterns for one rule is the same
   drift failure as two copies of the check. */
const PRIVATE_REPO_RE = /laqaer\/bulkhead(?:\.git)?(?![\w.-])/;

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(PACKAGE_DIR, "package.json");

interface Manifest {
  repository?: { url?: unknown };
  homepage?: unknown;
  bugs?: { url?: unknown };
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;

/** The three fields npm renders as links on the package listing. */
const LINK_FIELDS: Array<[string, unknown]> = [
  ["repository.url", manifest.repository?.url],
  ["homepage", manifest.homepage],
  ["bugs.url", manifest.bugs?.url],
];

interface RepoRef {
  host: string;
  owner: string;
  repo: string;
}

/* npm accepts the clone form `git+https://…/<repo>.git` for `repository.url`.
   `git+` is a protocol prefix and `.git` a clone-url suffix — neither is part
   of the repo name — so both are shed before the name is compared. */
function repoRef(raw: unknown): RepoRef | string {
  if (typeof raw !== "string") return `not a URL string: ${JSON.stringify(raw)}`;
  let url: URL;
  try {
    url = new URL(raw.replace(/^git\+/, ""));
  } catch {
    return `unparseable URL: ${raw}`;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  return {
    host: url.host,
    owner: segments[0] ?? "",
    repo: (segments[1] ?? "").replace(/\.git$/, ""),
  };
}

interface ShippedFile {
  rel: string;
  content: string;
}

/* Derived, never hand-listed: npm resolves the `files` field itself, so this
   is exactly the set that lands in the tarball — README.md included, and
   anything a later edit adds to `files` picked up for free. `--ignore-scripts`
   keeps the mirror's git-install `prepare` from running a build in here. */
function packedPaths(): string[] {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [tarball] = JSON.parse(stdout) as Array<{ files?: Array<{ path?: unknown }> }>;
  return (tarball?.files ?? [])
    .map((file) => file.path)
    .filter((rel): rel is string => typeof rel === "string");
}

/* dist/ is absent unless a build ran first; `files` resolution simply omits it
   then, so nothing here throws — prepublishOnly and `npm test` both build. */
function shippedTextFiles(): ShippedFile[] {
  return packedPaths()
    .map((rel) => ({ rel, content: readFileSync(path.join(PACKAGE_DIR, rel), "utf8") }))
    .filter(({ content }) => !content.includes("\u0000"));
}

describe("published package metadata", () => {
  it("names the public mirror repo in every link field npm renders", () => {
    const refs = Object.fromEntries(LINK_FIELDS.map(([field, raw]) => [field, repoRef(raw)]));

    expect(refs).toEqual({
      "repository.url": PUBLIC_REPO,
      homepage: PUBLIC_REPO,
      "bugs.url": PUBLIC_REPO,
    });
  });

  it("names the private laqaer/bulkhead repo in no link field", () => {
    const offenders = LINK_FIELDS.filter(
      ([, raw]) => typeof raw === "string" && PRIVATE_REPO_RE.test(raw),
    ).map(([field]) => field);

    expect(offenders).toEqual([]);
  });

  it("names the private repo in no file npm actually ships", () => {
    const shipped = shippedTextFiles();
    const names = shipped.map((file) => file.rel);

    // Non-vacuity: an empty or truncated derivation must fail rather than
    // sweep nothing. README.md is the npm listing body — the most-read
    // surface on the package page — and package.json carries the links.
    expect(names).toContain("package.json");
    expect(names).toContain("README.md");

    const offenders = shipped
      .filter((file) => PRIVATE_REPO_RE.test(file.content))
      .map((file) => file.rel);

    expect(offenders).toEqual([]);
  }, 30_000);

  it("distinguishes the private repo from the public one on the name boundary", () => {
    for (const naming of [
      "https://github.com/laqaer/bulkhead",
      "https://github.com/laqaer/bulkhead#readme",
      "https://github.com/laqaer/bulkhead/issues",
      "git+https://github.com/laqaer/bulkhead.git",
    ]) {
      expect(PRIVATE_REPO_RE.test(naming), naming).toBe(true);
      expect(repoRef(naming), naming).not.toEqual(PUBLIC_REPO);
    }

    for (const naming of [
      "https://github.com/laqaer/bulkhead-cli",
      "https://github.com/laqaer/bulkhead-cli#readme",
      "https://github.com/laqaer/bulkhead-cli/issues",
      "git+https://github.com/laqaer/bulkhead-cli.git",
    ]) {
      expect(PRIVATE_REPO_RE.test(naming), naming).toBe(false);
      expect(repoRef(naming), naming).toEqual(PUBLIC_REPO);
    }
  });

  it("reports a missing or malformed link field instead of passing it", () => {
    expect(repoRef(undefined)).toBe("not a URL string: undefined");
    expect(repoRef({ url: "https://github.com/laqaer/bulkhead-cli" })).toBe(
      'not a URL string: {"url":"https://github.com/laqaer/bulkhead-cli"}',
    );
    expect(repoRef("laqaer/bulkhead-cli")).toBe("unparseable URL: laqaer/bulkhead-cli");
  });
});
