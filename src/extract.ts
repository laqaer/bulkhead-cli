import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolCall } from "./types.js";

/**
 * File-writing / editing tools whose target path we can read structurally.
 * These are the tools where protected-path enforcement is reliable — the path
 * is a named field, not buried in a shell string.
 */
const FILE_WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

const BASH_TOOLS = new Set(["Bash", "BashOutput"]);

export function isFileWriteTool(toolName: string): boolean {
  return FILE_WRITE_TOOLS.has(toolName);
}

export function isBashTool(toolName: string): boolean {
  return BASH_TOOLS.has(toolName);
}

/**
 * Pull the target file path(s) from a structured file tool's input. Returns
 * absolute paths resolved against `cwd`. Unknown shapes yield an empty list —
 * we never guess.
 */
export function targetPaths(call: ToolCall, cwd: string): string[] {
  const input = call.toolInput ?? {};
  const raw: string[] = [];
  const fp = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path;
  if (typeof fp === "string") raw.push(fp);
  // Some tools accept a list of edits each with their own path.
  const edits = input.edits;
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (e && typeof e === "object") {
        const ep = (e as Record<string, unknown>).file_path;
        if (typeof ep === "string") raw.push(ep);
      }
    }
  }
  return raw.map((p) => (isAbsolute(p) ? resolve(p) : resolve(cwd, p)));
}

/** The Bash command string, or undefined if this isn't a command tool call. */
export function commandString(call: ToolCall): string | undefined {
  const c = call.toolInput?.command;
  return typeof c === "string" ? c : undefined;
}

/**
 * Extract candidate filesystem targets from an `rm` invocation for
 * workspace-boundary checking. This is a best-effort tokenizer, not a shell
 * parser — it handles the common shapes (`rm -rf foo bar`, quoted paths) and is
 * deliberately conservative: anything it can't classify as a flag is treated as
 * a target. It does NOT try to defeat obfuscation (that's a documented
 * limitation — hooks are containment, not a sandbox).
 */
export function rmTargets(command: string): string[] | null {
  // Only consider commands that actually call rm as a word.
  if (!/\brm\b/.test(command)) return null;
  const targets: string[] = [];
  // Split on shell separators to inspect each simple command segment.
  const segments = command.split(/(?:&&|\|\||;|\|)/);
  for (const seg of segments) {
    const tokens = tokenize(seg);
    const rmIdx = tokens.findIndex((t) => t === "rm" || t.endsWith("/rm"));
    if (rmIdx === -1) continue;
    for (const tok of tokens.slice(rmIdx + 1)) {
      if (tok.startsWith("-")) continue; // flag
      targets.push(tok);
    }
  }
  return targets;
}

/** `~`, `$HOME` or `${HOME}`, ending the token or followed by `/`. */
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;

/**
 * Expand a leading home-directory reference in an `rm` target the way the
 * shell does before `rm` ever sees it: `~`, `~/x`, `$HOME/x`, `${HOME}/x`.
 * Without this, `resolve(root, "~/backups")` treats `~` as a directory named
 * `~` inside the repo, and a delete of the user's home passes as local.
 *
 * rmTargets() has already stripped quotes, so `'$HOME/x'` (which the shell
 * would NOT expand) is expanded too. That only ever widens a deny.
 *
 * Returns the target unchanged when it has no home prefix, the expanded path
 * when it does, and null when it names a home that cannot be resolved —
 * another user's (`~alice/x`), the `~+`/`~-` forms, or no determinable home
 * directory at all. Callers treat null as deny (fail closed).
 */
export function expandHomePrefix(target: string): string | null {
  if (target.startsWith("~") && !/^~(?:\/|$)/.test(target)) return null;
  const m = HOME_PREFIX.exec(target);
  if (!m) return target;
  let home: string;
  try {
    home = homedir();
  } catch {
    return null;
  }
  if (!home) return null;
  return home + target.slice(m[0].length);
}

/**
 * Parse each `git push` in a command into its flags and positional args
 * (remote + refspecs), across `&&`/`||`/`;`/`|`-separated segments. Order-
 * independent, so it catches both `git push --force origin main` and
 * `git push origin main --force`. Best-effort tokenizer, not a shell parser.
 */
export function gitPushInvocations(
  command: string,
): Array<{ flags: string[]; positionals: string[] }> {
  const out: Array<{ flags: string[]; positionals: string[] }> = [];
  for (const seg of command.split(/(?:&&|\|\||;|\|)/)) {
    const tokens = tokenize(seg);
    const gi = tokens.findIndex(
      (t, i) => (t === "git" || t.endsWith("/git")) && tokens[i + 1] === "push",
    );
    if (gi === -1) continue;
    const rest = tokens.slice(gi + 2);
    out.push({
      flags: rest.filter((t) => t.startsWith("-")),
      positionals: rest.filter((t) => !t.startsWith("-")),
    });
  }
  return out;
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out.filter((t) => t.length > 0);
}

/** Commands that only run the next word, so the real command starts after them. */
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "nice", "nohup", "time", "exec", "builtin"]);
const DEV_SINKS = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

interface ShellWord {
  text: string;
  /** An unquoted redirection operator such as `>`, `>>`, `2>`, `&>`, `>|`, `<`. */
  redirect: boolean;
  /** True for input redirections (`<`, `<<`, `<<<`): their operand is read, not written. */
  input?: boolean;
}

/**
 * Split a command into simple-command segments of words, honouring quotes,
 * and emitting unquoted redirection operators as their own words. Separators
 * (`;`, `&&`, `||`, `|`, `&`, newline) end a segment. Best effort, not a shell
 * parser: the point is to see the obvious write, never to prove its absence.
 */
function shellSegments(cmd: string): ShellWord[][] {
  const segments: ShellWord[][] = [];
  let words: ShellWord[] = [];
  let cur = "";
  let has = false;
  const endWord = () => {
    if (has) words.push({ text: cur, redirect: false });
    cur = "";
    has = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i]!;
    if (c === "'" || c === '"') {
      const close = cmd.indexOf(c, i + 1);
      const end = close === -1 ? cmd.length : close;
      cur += cmd.slice(i + 1, end);
      has = true;
      i = end + 1;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) {
      cur += cmd[i + 1];
      has = true;
      i += 2;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      i++;
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || c === "&") {
      // `&>` / `>&` redirections are handled below; a bare & or | separates.
      if (c === "&" && cmd[i + 1] === ">") {
        endWord();
        let j = i + 2;
        if (cmd[j] === ">") j++;
        words.push({ text: cmd.slice(i, j), redirect: true });
        i = j;
        continue;
      }
      endSegment();
      i += (c === "&" || c === "|") && cmd[i + 1] === c ? 2 : 1;
      continue;
    }
    if (c === "<") {
      // Input redirection (`< file`, `<<< text`, `<<EOF`): the next word is
      // read, not written — drop the operator and its operand from the words.
      endWord();
      let j = i + 1;
      while (cmd[j] === "<") j++;
      words.push({ text: cmd.slice(i, j), redirect: true, input: true });
      i = j;
      continue;
    }
    if (c === ">") {
      // A leading fd number (`2>`) belongs to the operator, not the word.
      if (has && /^\d+$/.test(cur)) {
        cur = "";
        has = false;
      } else {
        endWord();
      }
      let j = i + 1;
      if (cmd[j] === ">" || cmd[j] === "|") j++;
      words.push({ text: cmd.slice(i, j), redirect: true });
      i = j;
      continue;
    }
    cur += c;
    has = true;
    i++;
  }
  endSegment();
  return segments;
}

/** Split flags from positional arguments; `takesValue` flags consume the next word. */
function splitArgs(args: string[], takesValue: Set<string>): { flags: string[]; positionals: string[]; values: string[] } {
  const flags: string[] = [];
  const positionals: string[] = [];
  const values: string[] = [];
  let endOfFlags = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!endOfFlags && a === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && a.startsWith("-") && a.length > 1) {
      flags.push(a);
      if (takesValue.has(a) && i + 1 < args.length) values.push(args[++i]!);
      continue;
    }
    positionals.push(a);
  }
  return { flags, positionals, values };
}

const basename = (w: string) => w.slice(w.lastIndexOf("/") + 1);

/**
 * `cp`, `install`, `mv` and `ln` all take `-t DIR` / `--target-directory DIR`:
 * every source is then written to `DIR/<its name>`, so the destination is no
 * positional word. Pulls the directory out of `args` (`-t DIR`, `-tDIR`, a
 * cluster ending in `t` such as `-ft DIR`, `--target-directory DIR` or `=DIR`,
 * and GNU's unambiguous long abbreviations such as `--target`) and returns the
 * other words, with any other letters of a cluster kept, in `rest`.
 */
function splitTargetDirectory(args: string[], takesValue: Set<string>): { dir: string | null; rest: string[] } {
  const rest: string[] = [];
  let dir: string | null = null;
  let endOfFlags = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (endOfFlags || !a.startsWith("-") || a.length < 2) {
      rest.push(a);
      continue;
    }
    if (a === "--") {
      endOfFlags = true;
      rest.push(a);
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      if (name.length >= 3 && "--target-directory".startsWith(name)) {
        if (eq !== -1) dir = a.slice(eq + 1);
        else if (i + 1 < args.length) dir = args[++i]!;
        continue;
      }
    } else if (/^-[A-Za-z]*t$/.test(a)) {
      if (i + 1 < args.length) dir = args[++i]!;
      if (a.length > 2) rest.push(a.slice(0, -1));
      continue;
    } else if (/^-t.+/.test(a)) {
      dir = a.slice(2);
      continue;
    }
    rest.push(a);
    if (takesValue.has(a) && i + 1 < args.length) rest.push(args[++i]!);
  }
  return { dir, rest };
}

/** Where each source lands when written into `dir` (`DIR/<name>`). */
function intoDirectory(dir: string, sources: string[]): string[] {
  const base = dir.replace(/\/+$/, "");
  return sources.flatMap((src) => {
    const name = basename(src.replace(/\/+$/, ""));
    return name === "" || name === "." || name === ".." ? [] : [`${base}/${name}`];
  });
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const CLI_SPEC = /^@bulkheadtools\/cli(?:@\S*)?$/;
/** Runner flags that consume the next word (npx/npm exec/pnpm/yarn/bunx). */
const RUNNER_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call", "--cache", "--registry", "--userconfig", "-w", "--workspace", "-C", "--dir", "--cwd"]);

/** The command words of one segment: redirections and their operands dropped, env assignments and wrappers skipped. */
function commandWords(seg: ShellWord[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < seg.length; i++) {
    if (seg[i]!.redirect) {
      i++;
      continue;
    }
    words.push(seg[i]!.text);
  }
  let k = 0;
  while (k < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]!) || WRAPPERS.has(basename(words[k]!)))) k++;
  return words.slice(k);
}

/** `sh -c '<script>'` and friends: the script, when there is one. */
function shellScript(words: string[]): string | null {
  if (!SHELLS.has(basename(words[0] ?? ""))) return null;
  const c = words.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
  return c > 0 && c + 1 < words.length ? words[c + 1]! : null;
}

/**
 * Bulkhead's own installer run through the shell — `bulkhead init`,
 * `npx @bulkheadtools/cli init --force`, `pnpm dlx … uninstall` — returns the
 * subcommand. Both rewrite the policy and the hook wiring, so an agent that
 * could run them could reset its own rules or unhook itself; a human runs them
 * from their own terminal instead. Best effort, like shellWriteTargets.
 */
export function bulkheadSelfCommand(command: string): "init" | "uninstall" | null {
  for (const seg of shellSegments(command)) {
    const words = commandWords(seg);
    const script = shellScript(words);
    if (script !== null) {
      const inner = bulkheadSelfCommand(script);
      if (inner) return inner;
      continue;
    }
    const exe = basename(words[0] ?? "");
    let rest: string[] | null = null;
    if (exe === "bulkhead") {
      rest = words.slice(1);
    } else if (exe === "node" || exe === "npx" || exe === "bunx" || exe === "npm" || exe === "pnpm" || exe === "yarn" || exe === "bun") {
      const { positionals } = splitArgs(words.slice(1), RUNNER_VALUE_FLAGS);
      let i = 0;
      if ((exe === "npm" || exe === "pnpm" || exe === "yarn" || exe === "bun") && ["exec", "x", "dlx"].includes(positionals[0] ?? "")) i = 1;
      const spec = positionals[i] ?? "";
      // node: the published package path, or a built CLI in a checkout/clone
      // (`…/bulkhead/packages/core/dist/cli.js`, `…/bulkhead-cli/dist/cli.js`) —
      // the form `init --command "node <path> hook"` wires in.
      const isCli =
        exe === "node"
          ? spec.includes("@bulkheadtools/cli") || (/bulkhead/i.test(spec) && /(^|\/)cli\.[cm]?js$/.test(spec))
          : CLI_SPEC.test(spec) || basename(spec) === "bulkhead";
      if (isCli) rest = positionals.slice(i + 1);
    }
    if (!rest || rest.includes("--help")) continue;
    const { positionals } = splitArgs(rest, new Set(["--command", "--preset"]));
    if (positionals[0] === "init" || positionals[0] === "uninstall") return positionals[0];
  }
  return null;
}

/**
 * Files an obvious shell command writes, overwrites, moves or truncates:
 * redirections (`>`, `>>`, `&>`, `2>`), `tee`, in-place `sed`/`perl`/`ruby`,
 * `cp`/`install` destinations, both sides of `mv`, `truncate`, `dd of=`,
 * `ln -f` link names, and the same inside `sh -c '…'`. Used to extend protected-path checks from the file tools
 * to the obvious Bash forms — `sed -i … bulkhead.yaml`, `echo … > .env`.
 *
 * Containment, not proof: a script, an interpreter or an alias writes
 * files this cannot see, which is why Bulkhead is not a sandbox.
 */
export function shellWriteTargets(command: string): string[] {
  const out: string[] = [];
  for (const seg of shellSegments(command)) {
    // Redirection targets, wherever they appear in the segment.
    for (let i = 0; i < seg.length; i++) {
      if (!seg[i]!.redirect || seg[i]!.input) continue;
      const next = seg[i + 1];
      if (next && !next.redirect && !next.text.startsWith("&") && !DEV_SINKS.test(next.text)) out.push(next.text);
    }
    // The command words, with redirections and their targets removed.
    const words = commandWords(seg);
    const exe = words[0] ? basename(words[0]) : "";
    const args = words.slice(1);

    const script = shellScript(words);
    if (script !== null) {
      out.push(...shellWriteTargets(script));
    } else if (exe === "tee") {
      out.push(...splitArgs(args, new Set()).positionals);
    } else if (exe === "sed" || exe === "perl" || exe === "ruby") {
      const { flags, positionals } = splitArgs(args, new Set(["-e", "-f", "--expression", "--file"]));
      const inPlace = flags.some((f) => f === "--in-place" || f.startsWith("--in-place=") || /^-[a-zA-Z]*i/.test(f));
      if (!inPlace) continue;
      const scriptByFlag = flags.some((f) => ["-e", "-f", "--expression", "--file"].includes(f) || f.startsWith("--expression=") || /^-[a-zA-Z]*e$/.test(f));
      // BSD `sed -i '' …` passes an empty backup suffix as its own word.
      const files = positionals.filter((p) => p !== "");
      out.push(...(scriptByFlag ? files : files.slice(1)));
    } else if (exe === "cp" || exe === "install") {
      const valueFlags = new Set(["-m", "--mode", "-o", "-g", "-S", "--suffix"]);
      const { dir, rest } = splitTargetDirectory(args, valueFlags);
      const { positionals } = splitArgs(rest, valueFlags);
      if (dir !== null) out.push(...intoDirectory(dir, positionals));
      else if (positionals.length >= 2) out.push(positionals[positionals.length - 1]!);
    } else if (exe === "mv") {
      const valueFlags = new Set(["-S", "--suffix"]);
      const { dir, rest } = splitTargetDirectory(args, valueFlags);
      const { positionals } = splitArgs(rest, valueFlags);
      if (dir !== null) out.push(...positionals, ...intoDirectory(dir, positionals));
      else if (positionals.length >= 2) out.push(...positionals);
    } else if (exe === "truncate") {
      out.push(...splitArgs(args, new Set(["-s", "--size", "-r", "--reference"])).positionals);
    } else if (exe === "dd") {
      for (const a of args) if (a.startsWith("of=")) out.push(a.slice(3));
    } else if (exe === "ln") {
      const valueFlags = new Set(["-S", "--suffix"]);
      const { dir, rest } = splitTargetDirectory(args, valueFlags);
      const { flags, positionals } = splitArgs(rest, valueFlags);
      if (flags.some((f) => f === "--force" || /^-[a-zA-Z]*f/.test(f))) {
        if (dir !== null) out.push(...intoDirectory(dir, positionals));
        else if (positionals.length >= 2) out.push(positionals[positionals.length - 1]!);
      }
    }
  }
  return out.filter((t) => t.length > 0 && !DEV_SINKS.test(t));
}

/** Commands that print, transform or copy the contents of the files they are given. */
const READERS = new Set([
  "cat", "bat", "batcat", "less", "more", "head", "tail", "nl", "tac", "strings",
  "xxd", "od", "hexdump", "base64", "grep", "egrep", "fgrep", "rg", "awk", "sed",
  "cut", "cp", "tar", "zip",
]);

/**
 * Words an obvious shell command reads or copies: the operands of the print
 * and copy commands above (`cat`, `head`, `base64`, `grep`, `cp`, `tar`, ...),
 * the source of a `<` redirection, and the same inside `sh -c '…'`. The
 * operands include flag values and patterns (`grep password ~/.pgpass`), so
 * callers must match them against something specific, never act on them as
 * paths.
 *
 * Containment, not proof, like shellWriteTargets: a script, an interpreter, a
 * symlink or a glob over a directory reads files this cannot see.
 */
export function shellReadTargets(command: string): string[] {
  const out: string[] = [];
  for (const seg of shellSegments(command)) {
    for (let i = 0; i < seg.length; i++) {
      if (!seg[i]!.redirect || seg[i]!.text !== "<") continue;
      const next = seg[i + 1];
      if (next && !next.redirect) out.push(next.text);
    }
    const words = commandWords(seg);
    const script = shellScript(words);
    if (script !== null) {
      out.push(...shellReadTargets(script));
    } else if (READERS.has(basename(words[0] ?? ""))) {
      out.push(...splitArgs(words.slice(1), new Set()).positionals);
    }
  }
  return out.filter((t) => t.length > 0);
}

/**
 * Files that exist to hold secrets, as paths under the home directory. Narrow
 * on purpose: each one is a credential store by design, not a config file that
 * may happen to carry a token. A private key is `id_*` without `.pub`.
 */
const CREDENTIAL_STORES: ReadonlyArray<RegExp> = [
  /^\.pgpass$/,
  /^\.netrc$/,
  /^\.git-credentials$/,
  /^\.aws\/credentials$/,
  /^\.config\/gcloud\/application_default_credentials\.json$/,
  /^\.ssh\/id_(?!.*\.pub$)[^/]+$/,
];

/**
 * Whether a command word names one of the well-known credential stores in the
 * user's home directory (`~/.pgpass`, `$HOME/.aws/credentials`, an absolute
 * path into the home). A relative path never matches — the shell's own
 * directory is not known here. A home that cannot be resolved matches nothing:
 * this feeds an approval signal, not a deny.
 */
export function isCredentialStorePath(target: string): boolean {
  const expanded = expandHomePrefix(target);
  if (expanded === null || !isAbsolute(expanded)) return false;
  let home: string;
  try {
    home = homedir();
  } catch {
    return false;
  }
  if (!home) return false;
  const rel = relative(home, resolve(expanded));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  const posix = rel.split(sep).join("/");
  return CREDENTIAL_STORES.some((re) => re.test(posix));
}
