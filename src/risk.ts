import type { RiskAssessment, RiskLevel, RiskSignal, ToolCall } from "./types.js";
import { commandSegments } from "./evidence.js";

export type { RiskAssessment, RiskLevel, RiskSignal } from "./types.js";

/**
 * Deterministic risk scoring for the approval gate.
 *
 * This decides which actions are "risky but allowed" — the ones worth a human's
 * eyes even though they aren't outright denied. The point of scoring (rather
 * than a flat allow/deny) is the anti-rubber-stamp property: when 100 actions
 * happen overnight, you want the 3 that touch production at the top, not 100
 * undifferentiated approvals. Same rules as the rest of Bulkhead: a pure
 * function of the tool call, no model in the loop.
 *
 * Detection reuses the command-position parser, so a runner/verb appearing
 * inside a quoted argument or file path is never mistaken for the real action.
 */

const LEVEL_RANK: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3 };
const LEVEL_POINTS: Record<RiskLevel, number> = { low: 10, medium: 25, high: 40 };

export function rankOf(level: RiskLevel): number {
  return LEVEL_RANK[level];
}

const CLOUD_CLIS = new Set(["aws", "gcloud", "az", "kubectl", "terraform", "pulumi", "helm", "doctl", "flyctl", "fly", "heroku", "vercel", "netlify"]);

/** Read-only verbs shared across cloud CLIs. */
const CLOUD_READ =
  /^(get|list|describe|show|read|head|ls|cat|log|logs|top|status|history|version|help|explain|config|diff|wait|watch|view|output|plan|validate|fmt|init|whoami|auth|current-context|api-resources|api-versions|cluster-info)$/i;

/**
 * Whether a cloud/infra CLI invocation MUTATES resources. The verb lives in a
 * different position per CLI, so we can't just scan every token — doing that
 * flagged `kubectl get deploy` (deploy is a resource alias) as a mutation.
 */
function isCloudMutation(bin: string, positional: string[]): boolean {
  const sub = positional[0] ?? "";
  if (bin === "terraform" || bin === "pulumi") {
    return /^(apply|destroy|import|taint|untaint|state|up|refresh)$/i.test(sub);
  }
  if (bin === "helm") {
    return /^(install|upgrade|uninstall|delete|rollback)$/i.test(sub);
  }
  if (bin === "kubectl") {
    // rollout status/history are read; restart/undo/pause/resume mutate.
    if (sub === "rollout") return /^(restart|undo|pause|resume)$/i.test(positional[1] ?? "");
    return /^(apply|delete|create|replace|patch|scale|edit|annotate|label|set|expose|run|drain|cordon|uncordon|taint|autoscale|attach)$/i.test(sub);
  }
  if (bin === "aws") {
    // aws <service> <operation>; the operation is hyphenated (delete-stack).
    const op = positional[1] ?? "";
    if (/^(get|list|describe|head|ls|wait|help|version)(-|$)/i.test(op)) return false;
    if (/^(rm|mv|cp|sync|mb|rb)$/i.test(op)) return true; // s3 mutating verbs
    return /^(create|delete|destroy|terminate|update|modify|put|remove|reboot|stop|start|run|deploy|apply|attach|detach|associate|disassociate|register|deregister|set|add|purge|drain|scale|import|restore|revoke|authorize|enable|disable|replace|cancel|abort|reset|rotate|publish|invoke|execute|promote|tag|untag)(-|$)/i.test(op);
  }
  // gcloud / az / doctl / fly / heroku / vercel / netlify: the verb appears
  // among the positionals (position varies), so flag when a mutating verb is
  // present and no read verb is. The mutating set excludes resource-y nouns.
  const MUT =
    /^(create|delete|destroy|deploy|apply|update|remove|add|set|import|enable|disable|reset|restart|stop|start|scale|promote|rollback|patch|replace|migrate|run|submit|execute|cancel|abort|purge|attach|detach|drain|provision|teardown)$/i;
  const hasRead = positional.some((p) => CLOUD_READ.test(p));
  const hasMut = positional.some((p) => MUT.test(p));
  return hasMut && !hasRead;
}

const GH_WRITE_VERB =
  /^(create|edit|delete|merge|close|reopen|ready|comment|rename|archive|transfer|run|enable|disable|set|remove|upload|sync|fork|clone|develop|lock|unlock|pin|unpin|restore)$/i;

/** gh <noun> <verb>: only a WRITE verb after the noun mutates a remote resource. */
function isGhMutation(noun: string | undefined, verb: string | undefined): boolean {
  if (!noun || !["pr", "release", "repo", "workflow", "secret", "issue", "gist", "label", "variable"].includes(noun)) return false;
  return GH_WRITE_VERB.test(verb ?? "");
}
const PKG_ADDERS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "pipx", "poetry", "gem", "cargo", "go", "brew", "apt", "apt-get", "yum", "dnf", "apk", "composer"]);

export function assessRisk(call: ToolCall): RiskAssessment {
  const signals: RiskSignal[] = [];

  if (call.toolName === "Bash") {
    const command = typeof call.toolInput.command === "string" ? call.toolInput.command : "";
    if (command) collectBashSignals(command, signals);
  } else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(call.toolName)) {
    collectWriteSignals(call, signals);
  } else if (isNetworkTool(call.toolName)) {
    signals.push({ id: "network-tool", level: "medium", reason: `${call.toolName} performs a network request` });
  }

  return summarize(signals);
}

function summarize(signals: RiskSignal[]): RiskAssessment {
  if (signals.length === 0) return { level: undefined, score: 0, signals: [] };
  let level: RiskLevel = "low";
  let score = 0;
  for (const s of signals) {
    if (LEVEL_RANK[s.level] > LEVEL_RANK[level]) level = s.level;
    score += LEVEL_POINTS[s.level];
  }
  return { level, score: Math.min(100, score), signals };
}

function isNetworkTool(toolName: string): boolean {
  return toolName === "WebFetch" || toolName === "WebSearch";
}

function collectBashSignals(command: string, signals: RiskSignal[]): void {
  // Privilege: sudo/doas is stripped from segments (so the underlying command
  // is still classified), so detect it from the quote-stripped raw command at a
  // command position. Quote-stripping avoids matching `echo "sudo ..."`.
  const noQuotes = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, " ");
  if (/(^|[|&;\n]\s*)(sudo|doas)\b/.test(noQuotes)) {
    signals.push({ id: "privilege", level: "high", reason: "runs with elevated privileges (sudo/doas)" });
  }

  const segments = commandSegments(command);
  for (const seg of segments) {
    const positional = seg.args.filter((a) => !a.startsWith("-"));
    const sub = positional[0];

    // --- Egress / external side effects (high) ---
    if (seg.bin === "git" && sub === "push") {
      signals.push({ id: "git-push", level: "high", reason: "pushes commits to a remote" });
    }
    if (seg.bin === "gh" && isGhMutation(sub, positional[1])) {
      signals.push({ id: "gh-mutate", level: "high", reason: `gh ${sub} ${positional[1] ?? ""} changes a remote GitHub resource` });
    }
    if (PKG_ADDERS.has(seg.bin) && /^(publish)$/.test(sub ?? "")) {
      signals.push({ id: "publish", level: "high", reason: `${seg.bin} publish releases a package publicly` });
    }
    if (seg.bin === "docker" && (sub === "push" || sub === "login")) {
      signals.push({ id: "docker-push", level: "high", reason: `docker ${sub} touches a remote registry` });
    }
    if (CLOUD_CLIS.has(seg.bin) && isCloudMutation(seg.bin, positional)) {
      signals.push({ id: "cloud-mutate", level: "high", reason: `${seg.bin} ${positional.slice(0, 2).join(" ")} mutates cloud/infra resources` });
    }
    if (["ssh", "scp", "rsync", "sftp"].includes(seg.bin)) {
      signals.push({ id: "remote-transfer", level: "high", reason: `${seg.bin} connects to or transfers to a remote host` });
    }
    if ((seg.bin === "curl" || seg.bin === "wget") && hasWriteHttpMethod(seg.args)) {
      signals.push({ id: "http-mutate", level: "high", reason: `${seg.bin} sends data to a remote endpoint` });
    }
    if (["sendmail", "mail", "mailx"].includes(seg.bin)) {
      signals.push({ id: "send-mail", level: "high", reason: `${seg.bin} sends email` });
    }

    // --- Privilege: chmod world-writable (high) ---
    if (seg.bin === "chmod" && seg.args.some((a) => /777|a\+rwx/.test(a))) {
      signals.push({ id: "chmod-world", level: "medium", reason: "chmod grants world-writable permissions" });
    }

    // --- Dependency changes (medium) ---
    if (PKG_ADDERS.has(seg.bin) && isDependencyAdd(seg.bin, positional)) {
      signals.push({ id: "dependency-add", level: "medium", reason: `${seg.bin} ${sub ?? "install"} adds a dependency (supply-chain surface)` });
    }

    // --- History rewrite (medium) ---
    if (seg.bin === "git" && sub === "reset" && seg.args.includes("--hard")) {
      signals.push({ id: "git-reset-hard", level: "medium", reason: "git reset --hard discards uncommitted work" });
    }
    if (seg.bin === "git" && sub === "clean" && seg.args.some((a) => /^-\w*f/.test(a) || a === "--force")) {
      signals.push({ id: "git-clean", level: "medium", reason: "git clean -f deletes untracked files" });
    }
    if (seg.bin === "git" && (sub === "filter-branch" || sub === "filter-repo")) {
      signals.push({ id: "git-history-rewrite", level: "high", reason: `git ${sub} rewrites repository history` });
    }
  }
}

function hasWriteHttpMethod(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if ((a === "-X" || a === "--request") && /^(POST|PUT|DELETE|PATCH)$/i.test(args[i + 1] ?? "")) return true;
    if (/^-X(POST|PUT|DELETE|PATCH)$/i.test(a)) return true;
    if (a === "-d" || a === "--data" || a === "--data-binary" || a === "--data-raw" || a === "-F" || a === "--form" || a === "-T" || a === "--upload-file") return true;
    if (a === "--method" && /^(POST|PUT|DELETE|PATCH)$/i.test(args[i + 1] ?? "")) return true; // wget
    if (a === "--post-data" || a === "--post-file") return true; // wget
  }
  return false;
}

function isDependencyAdd(bin: string, positional: string[]): boolean {
  const sub = positional[0] ?? "";
  // A bare `npm install` (no package) just restores the lockfile — not risky.
  const hasTarget = positional.length > 1;
  if (["npm", "pnpm", "yarn", "bun"].includes(bin)) {
    if (sub === "add") return true;
    if ((sub === "install" || sub === "i") && hasTarget) return true;
  }
  if ((bin === "pip" || bin === "pip3" || bin === "pipx") && sub === "install") return true;
  if (bin === "poetry" && sub === "add") return true;
  if (bin === "gem" && sub === "install") return true;
  if (bin === "cargo" && (sub === "add" || sub === "install")) return true;
  if (bin === "go" && sub === "get" && hasTarget) return true;
  // `composer install` restores the lockfile (like bare `npm install`); only
  // `composer require <pkg>` adds a dependency.
  if (bin === "composer" && sub === "require") return true;
  if (["brew", "apt", "apt-get", "yum", "dnf", "apk"].includes(bin) && (sub === "install" || sub === "add")) return true;
  return false;
}

/** File paths whose modification is worth a look (not protected — just notable). */
const SENSITIVE_PATH =
  /(^|\/)\.github\/workflows\/|(^|\/)\.gitlab-ci\.yml$|(^|\/)\.circleci\/|(^|\/)Dockerfile$|(^|\/)docker-compose\.ya?ml$|(^|\/)(vercel\.json|netlify\.toml|fly\.toml|Procfile)$|\.tf$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock)$/;

function collectWriteSignals(call: ToolCall, signals: RiskSignal[]): void {
  const raw: string[] = [];
  const fp = call.toolInput.file_path ?? call.toolInput.filePath ?? call.toolInput.path ?? call.toolInput.notebook_path;
  if (typeof fp === "string") raw.push(fp);
  const edits = call.toolInput.edits;
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (e && typeof e === "object") {
        const ep = (e as Record<string, unknown>).file_path;
        if (typeof ep === "string") raw.push(ep);
      }
    }
  }
  for (const p of raw) {
    const norm = p.split("\\").join("/");
    if (SENSITIVE_PATH.test(norm)) {
      signals.push({ id: "sensitive-write", level: "medium", reason: `writes to a CI/build/deploy/lockfile path: ${p}` });
      return; // one signal per action is enough
    }
  }
}
