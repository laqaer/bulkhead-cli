#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { HookInput } from "./types.js";
import { handlePreToolUse, handlePostToolUse, handleStop } from "./hook.js";
import { findRepoRoot } from "./paths.js";
import { runInit } from "./init.js";
import { readLedger, readLedgerWithStats, verifyLedger } from "./ledger.js";
import { loadPolicy } from "./policy.js";
import { readDailySpend, localDateString, listSpendDates } from "./cost.js";
import { buildSessionReport, renderSessionReport, sessionIds } from "./report.js";
import { buildInbox, renderInbox } from "./inbox.js";
import { formatBatchCard, channelFor } from "./notify.js";
import type { RiskLevel } from "./types.js";

function version(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const HELP = `bulkhead — deterministic guardrails + evidence ledger for AI coding agents

Usage:
  bulkhead init [--command "<hook cmd>"] [--force]
      Install PreToolUse/PostToolUse hooks into .claude/settings.json and write
      a default bulkhead.yaml. Idempotent.

  bulkhead hook pre | post | stop
      Hook entrypoints. Read a Claude Code hook payload on stdin, enforce the
      policy, and emit the decision. You normally don't run these by hand.
      (stop = completion verification: claims vs recorded evidence)

  bulkhead ledger verify
      Verify the evidence ledger's hash chain.

  bulkhead ledger tail [n]
      Show the last n ledger entries (default 20).

  bulkhead report [n]
      Per-session report: cost by prompt, denials, evidence, completion checks.
      Shows the last n sessions (default 3).

  bulkhead inbox [--min low|medium|high]
      Risk-ranked review of risky actions the agent took (highest first).

  bulkhead notify [--to console|webhook] [--url <url>] [--min level]
      Push the current risk-ranked inbox to a channel (console, or a Slack-
      compatible webhook URL you provide). For overnight/summary reports.

  bulkhead status
      Show session/daily spend, recent denials, and ledger integrity.

  bulkhead --version | --help

Containment and evidence — not a firewall. Hooks are bypassable; see the README.
`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseFlags(argv);
  const cmd = positional[0];

  if (flags.version || flags.v || cmd === "version") {
    process.stdout.write(version() + "\n");
    return 0;
  }
  if (!cmd || flags.help || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  switch (cmd) {
    case "init":
      return cmdInit(flags);
    case "hook":
      return cmdHook(positional[1]);
    case "ledger":
      return cmdLedger(positional[1], positional[2]);
    case "report":
      return cmdReport(positional[1]);
    case "inbox":
      return cmdInbox(flags);
    case "notify":
      return cmdNotify(flags);
    case "status":
      return cmdStatus();
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

function cmdInit(flags: Record<string, string | boolean>): number {
  const repoRoot = findRepoRoot(process.cwd());
  let result;
  try {
    result = runInit(repoRoot, {
      hookCommand: typeof flags.command === "string" ? flags.command : undefined,
      force: flags.force === true,
    });
  } catch (err) {
    process.stderr.write(`bulkhead init failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  process.stdout.write(
    [
      `✅ Bulkhead installed in ${result.repoRoot}`,
      `   • bulkhead.yaml: ${result.policyCreated ? "created" : "kept existing"}`,
      `   • hooks: merged into ${result.settingsPath}`,
      `   • .gitignore: ${result.gitignoreUpdated ? "added .bulkhead/" : "already ignored"}`,
      ``,
      `Enforcement runs on every tool call. Review bulkhead.yaml, then start`,
      `Claude Code as usual. Blocked actions land in .bulkhead/ledger.jsonl.`,
      ``,
      `Reminder: this is containment + evidence, not a firewall. Hooks are`,
      `bypassable — see the README for what it does and does not stop.`,
      ``,
    ].join("\n"),
  );
  return 0;
}

async function cmdHook(kind: string | undefined): Promise<number> {
  let input: HookInput = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw) as HookInput;
  } catch (err) {
    // Malformed payload: fail open (allow) so we never brick the host, but say so.
    process.stderr.write(`bulkhead: could not parse hook input: ${String(err)}\n`);
    return 0;
  }

  try {
    const result =
      kind === "post"
        ? handlePostToolUse(input)
        : kind === "stop"
          ? handleStop(input)
          : handlePreToolUse(input);
    if (result.output && Object.keys(result.output as object).length > 0) {
      process.stdout.write(JSON.stringify(result.output));
    }
    return result.exitCode;
  } catch (err) {
    // Any internal error fails OPEN: a bug in Bulkhead must not break the user's
    // agent. The failure is loud (stderr) so it's noticed.
    process.stderr.write(`bulkhead: hook error (failing open): ${String(err)}\n`);
    return 0;
  }
}

function cmdLedger(sub: string | undefined, arg: string | undefined): number {
  const repoRoot = findRepoRoot(process.cwd());
  const { entries, skippedLines } = readLedgerWithStats(repoRoot);
  if (sub === "verify") {
    const result = verifyLedger(entries);
    if (result.ok) {
      process.stdout.write(`✅ Ledger intact — ${result.count} entries, hash chain verified.\n`);
      if (skippedLines > 0) {
        process.stdout.write(
          `⚠️  ${skippedLines} unparseable line(s) skipped — torn write or corruption; not part of the verified chain.\n`,
        );
      }
      process.stdout.write(
        `   Scope: detects edits and deletions within the chain. Removal of trailing\n` +
          `   entries is not detectable locally — proving the tail needs an external anchor.\n`,
      );
      return 0;
    }
    process.stdout.write(
      `❌ Ledger integrity FAILED at entry ${result.brokenAt}/${result.count}: ${result.reason}\n`,
    );
    return 1;
  }
  if (sub === "tail" || sub === undefined) {
    const n = arg ? Number(arg) : 20;
    const tail = entries.slice(-Math.max(1, n));
    for (const e of tail) {
      const mark = e.action === "deny" ? "⛔" : e.action === "ask" ? "⏸️ " : "  ";
      const parts = [
        `#${e.seq}`,
        e.ts,
        `${mark}${e.event}`,
        e.toolName ?? "",
        e.action ?? "",
        e.guard ? `[${e.guard}]` : "",
      ];
      process.stdout.write(parts.filter(Boolean).join(" ") + "\n");
    }
    return 0;
  }
  process.stderr.write(`Unknown ledger subcommand: ${sub}\n`);
  return 1;
}

function cmdReport(arg: string | undefined): number {
  const repoRoot = findRepoRoot(process.cwd());
  const entries = readLedger(repoRoot);
  if (entries.length === 0) {
    process.stdout.write("No ledger entries yet — nothing to report.\n");
    return 0;
  }
  const n = arg ? Math.max(1, Number(arg) || 3) : 3;
  const ids = sessionIds(entries).slice(-n);
  const blocks = ids.map((id) => renderSessionReport(buildSessionReport(entries, id)));
  process.stdout.write(blocks.join("\n\n") + "\n");
  return 0;
}

function asMinLevel(v: string | boolean | undefined): RiskLevel {
  return v === "low" || v === "medium" || v === "high" ? v : "low";
}

function cmdInbox(flags: Record<string, string | boolean>): number {
  const repoRoot = findRepoRoot(process.cwd());
  const inbox = buildInbox(readLedger(repoRoot), asMinLevel(flags.min));
  process.stdout.write(renderInbox(inbox) + "\n");
  return 0;
}

async function cmdNotify(flags: Record<string, string | boolean>): Promise<number> {
  const repoRoot = findRepoRoot(process.cwd());
  const inbox = buildInbox(readLedger(repoRoot), asMinLevel(flags.min));
  const card = formatBatchCard(inbox, { label: "overnight" });
  const to = typeof flags.to === "string" ? flags.to : "console";
  try {
    const channel = channelFor(to, typeof flags.url === "string" ? flags.url : undefined);
    await channel.send(card);
    if (to !== "console") process.stdout.write(`Sent ${inbox.items.length} item(s) to ${to}.\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`bulkhead notify failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function cmdStatus(): number {
  const repoRoot = findRepoRoot(process.cwd());
  const policy = loadPolicy(repoRoot);
  const entries = readLedger(repoRoot);
  const today = localDateString();
  const dayUsd = readDailySpend(repoRoot, today);
  const denials = entries.filter((e) => e.action === "deny");
  const integrity = verifyLedger(entries);

  process.stdout.write(
    [
      `Bulkhead status — ${repoRoot}`,
      ``,
      `Spend today:      $${dayUsd.toFixed(2)} / $${policy.budget.dailyUsd.toFixed(2)} daily cap`,
      `Session cap:      $${policy.budget.sessionUsd.toFixed(2)}`,
      `Ledger entries:   ${entries.length} (${integrity.ok ? "chain intact" : "⚠️ INTEGRITY FAILED"})`,
      `Denied actions:   ${denials.length}`,
      `Spend history:    ${listSpendDates(repoRoot).join(", ") || "none"}`,
      ``,
      denials.length > 0 ? "Recent denials:" : "",
      ...denials.slice(-5).map((e) => `  ⛔ #${e.seq} ${e.toolName ?? ""} [${e.guard}] ${e.rule ?? ""}`),
      ``,
    ]
      .filter((l) => l !== "")
      .join("\n") + "\n",
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`bulkhead: fatal: ${String(err)}\n`);
    process.exit(1);
  },
);
