import { realpathSync } from "node:fs";
import { homedir } from "node:os";

/**
 * Redaction for text that can leave the machine: a receipt pasted into a PR,
 * the one-line notice Claude Code shows the user, summary lines in the CLI.
 * The ledger itself keeps the raw record (it is local and gitignored), so
 * redaction applies to the views and never to the evidence.
 *
 * Masking is pattern-based, like every other string check in Bulkhead. It
 * catches the standard token shapes, credential assignments and URL
 * passwords. It will not catch every secret. The bias is to mask a long
 * random-looking string rather than leak it, while leaving ordinary words,
 * paths, commit SHAs and UUIDs readable. A receipt nobody can read is not
 * worth pasting.
 *
 * Every pattern here runs on agent-controlled text inside the PreToolUse
 * hook, where a hook that times out lets the tool call THROUGH. So each
 * pattern is linear: starts are anchored to word boundaries and repeated
 * parts are length-bounded. test/redact.test.ts pins that with a timing
 * check on pathological input.
 */

export const REDACTED = "[REDACTED]";

export interface RedactOptions {
  /** Absolute repo root: paths under it are printed repo-relative. */
  repoRoot?: string;
  /** Home directory printed as `~`. Defaults to os.homedir(); "" disables. */
  homeDir?: string;
}

/** Repo-relative paths plus secret masking: the default for anything shared. */
export function redact(text: string, opts: RedactOptions = {}): string {
  return redactSecrets(relativizePaths(text, opts));
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Print paths under the repo root as repo-relative (`/home/me/app/src/a.ts` →
 * `src/a.ts`, the root itself → `.`) and the home directory as `~`. A
 * receipt names the repo by basename only; the absolute path says who and
 * where, and nothing a reviewer needs.
 */
export function relativizePaths(text: string, opts: RedactOptions = {}): string {
  let out = text;
  if (opts.repoRoot) {
    for (const root of spellingsOf(opts.repoRoot)) out = replaceRoot(out, root, ".", "");
  }
  const home = opts.homeDir ?? safeHomedir();
  if (home && home !== "/") {
    for (const h of spellingsOf(home)) out = replaceRoot(out, h, "~", "~/");
  }
  return out;
}

/** The path as given plus its realpath (macOS /var → /private/var), longest first. */
function spellingsOf(path: string): string[] {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const out = new Set([trimmed]);
  try {
    out.add(realpathSync(trimmed));
  } catch {
    // Not on disk (a ledger from another machine): the literal form is enough.
  }
  return [...out].filter((p) => p.length > 1).sort((a, b) => b.length - a.length);
}

function replaceRoot(text: string, root: string, bare: string, prefix: string): string {
  const esc = escapeRegExp(root);
  // `<root>/child` → `<prefix>child`; a bare `<root>` (end of token) → `<bare>`.
  // The (?<![\w.-]) guard stops `/home/me` from matching inside `/x/home/me`.
  return text
    .replace(new RegExp(`(?<![\\w.~-])${esc}/(?=[^\\s/"'\`])`, "g"), prefix)
    .replace(new RegExp(`(?<![\\w.~-])${esc}(?![\\w.-]|/[^\\s"'\`])`, "g"), bare);
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** Mask credentials in free text. Idempotent: redacting twice changes nothing. */
export function redactSecrets(text: string): string {
  let out = text;

  // PEM private keys, whole block.
  out = out.replace(
    /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g,
    REDACTED,
  );

  // URL userinfo: postgres://user:pass@host keeps the user, masks the
  // password. A lone long userinfo (https://<token>@github.com) is a token.
  out = out.replace(
    /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/@:"'`]{1,256})(?::([^\s/@"'`]{0,256}))?@/gi,
    (m, scheme: string, user: string, pass: string | undefined) => {
      if (pass !== undefined && pass.length > 0 && pass !== REDACTED) return `${scheme}${user}:${REDACTED}@`;
      if (pass === undefined && user.length >= 16 && user !== REDACTED) return `${scheme}${REDACTED}@`;
      return m;
    },
  );

  // Vendor token shapes. The recognisable prefix stays so a reader can tell
  // what kind of credential was there; the secret part goes.
  out = out.replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/g, `sk-ant-${REDACTED}`);
  out = out.replace(/\bsk-(?!ant-)(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, `sk-${REDACTED}`);
  out = out.replace(/\b([rs]k_(?:live|test))_[A-Za-z0-9]{10,}/g, `$1_${REDACTED}`);
  out = out.replace(/\b(gh[pousr])_[A-Za-z0-9]{16,}/g, `$1_${REDACTED}`);
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, `github_pat_${REDACTED}`);
  out = out.replace(/\b(AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, `$1${REDACTED}`);
  out = out.replace(/\b(xox[abposr])-[A-Za-z0-9-]{8,}/g, `$1-${REDACTED}`);
  out = out.replace(/(?<![\w-])eyJ[\w-]{5,}\.eyJ[\w-]{5,}\.[\w-]{5,}/g, REDACTED);

  // Authorization headers. `Bearer $TOKEN` is a reference, not a value, and
  // stays; prose like "Bearer authentication" has no digit and stays too.
  out = out.replace(/\b(Bearer)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi, (m, word: string, sp: string, v: string) =>
    looksLikeCredential(v) ? `${word}${sp}${REDACTED}` : m,
  );
  out = out.replace(
    /\b(Authorization:\s*(?:Basic|token))(\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    (_m, head: string, sp: string) => `${head}${sp}${REDACTED}`,
  );

  // NAME=value where NAME names a credential (API_KEY=…, PGPASSWORD=…,
  // --password=…). `$VAR` references and already-masked values stay.
  out = out.replace(
    /(?<![A-Za-z0-9_.-])(-{0,2})([A-Za-z_][A-Za-z0-9_.-]{0,63})=("[^"]*"|'[^']*'|[^\s"'`;&|)]+)/g,
    (m, dashes: string, name: string, value: string) =>
      isSecretName(name) && isMaskableValue(value) ? `${dashes}${name}=${REDACTED}` : m,
  );

  // "api_key": "value" / password: 'value' (JSON or YAML with a quoted value).
  out = out.replace(
    /(?<![A-Za-z0-9_.-])(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,63})\1([ \t]{0,8}:[ \t]{0,8})("[^"]*"|'[^']*')/g,
    (m, q: string, name: string, colon: string, value: string) =>
      isSecretName(name) && isMaskableValue(value) ? `${q}${name}${q}${colon}"${REDACTED}"` : m,
  );

  // --token value / --password value (flag, space, value).
  out = out.replace(
    /(?<![A-Za-z0-9_-])(--(?:[a-z0-9]{1,20}-){0,4}(?:token|password|passwd|secret|api-key|apikey))(\s+)(?!-)("[^"]*"|'[^']*'|[^\s"'`;&|)]+)/gi,
    (m, flag: string, sp: string, value: string) =>
      isMaskableValue(value) ? `${flag}${sp}${REDACTED}` : m,
  );

  // Anything else long and random-looking.
  out = out.replace(/[A-Za-z0-9+/_=-]{32,}/g, (m) => (isHighEntropyToken(m) ? REDACTED : m));

  return out;
}

const SECRET_WORDS = new Set([
  "token", "secret", "key", "password", "passwd", "pass", "pwd", "apikey", "credential", "credentials",
]);
/** Suffixes that make a fused word a credential name: PGPASSWORD, GITHUBTOKEN. */
const SECRET_SUFFIXES = ["token", "secret", "password", "passwd", "apikey"];

/**
 * Does this variable/field name denote a credential? Word-based, so
 * `API_KEY`, `apiKey`, `db-password` and `PGPASSWORD` match while `keyboard`,
 * `monkey`, `bypass` and `passes` do not.
 */
export function isSecretName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[_.-]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  for (const w of words) {
    if (SECRET_WORDS.has(w)) return true;
    if (SECRET_SUFFIXES.some((s) => w.length > s.length && w.endsWith(s))) return true;
  }
  return false;
}

function isMaskableValue(value: string): boolean {
  const bare = value.replace(/^["']|["']$/g, "");
  if (bare.length === 0) return false;
  if (bare.startsWith("$")) return false; // a reference ($TOKEN, $(cat f)), not the value
  if (bare === REDACTED || bare.startsWith(REDACTED)) return false;
  return true;
}

function looksLikeCredential(v: string): boolean {
  return /\d/.test(v) || v.length >= 24;
}

/**
 * A long token that looks random: upper, lower and digits all present, high
 * per-character entropy, not hex (commit SHAs, content hashes, UUIDs are
 * identifiers a reviewer needs), not a path made of words.
 */
export function isHighEntropyToken(token: string): boolean {
  if (token.length < 32) return false;
  if (/^[0-9a-f-]+$/i.test(token)) return false; // SHA / hash / UUID
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/\d/.test(token)) return false;
  // Identifiers are made of words: most of their letters sit in lowercase
  // runs of 4+ (getUser2FactorAuthentication...). Random tokens rarely do.
  const wordish = (token.match(/[a-z]{4,}/g) ?? []).reduce((n, m) => n + m.length, 0);
  if (wordish / token.length >= 0.5) return false;
  if (token.includes("/")) {
    // Paths: any word-like segment (`src`, `components`) means a path.
    if (token.split("/").some((seg) => /^[a-z]{3,}$/.test(seg) || /^[A-Z]?[a-z]{3,}(?:[A-Z][a-z]*)?$/.test(seg))) {
      return false;
    }
  }
  return shannonEntropy(token) >= 4.0;
}

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
