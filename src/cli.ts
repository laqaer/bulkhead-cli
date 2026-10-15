#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve } from "node:path";
import type { HookInput } from "./types.js";
import { handlePreToolUse, handlePostToolUse, handleStop } from "./hook.js";
import { findRepoRoot } from "./paths.js";
import { POLICY_PRESETS, isPolicyPreset, runInit, runUninstall } from "./init.js";
import { readLedger, readLedgerWithStats, verifyLedger } from "./ledger.js";
import { loadPolicy } from "./policy.js";
import { readDailySpend, localDateString, listSpendDates } from "./cost.js";
import { buildSessionReport, renderSessionReport, sessionIds } from "./report.js";
import { buildInbox, renderInbox } from "./inbox.js";
import { formatBatchCard, channelFor } from "./notify.js";
import { denialLine, entrySummary } from "./describe.js";
import { DEMO_PRESETS, isDemoPreset, renderDemo, runDemo, shouldColor } from "./demo.js";
import {
  RECEIPT_FORMATS,
  buildReceipt,
  renderReceipt,
  resolveSession,
  type ReceiptFormat,
} from "./receipt.js";
import type { RiskLevel } from "./types.js";

const BADGE_MARKDOWN =
  "[![Guarded by Bulkhead](https://bulkhead.tools/badge.svg)](https://bulkhead.tools)";

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
  bulkhead init [--preset default|strict] [--command "<hook cmd>"] [--force]
      Install PreToolUse, PostToolUse and Stop hooks into
      .claude/settings.json and write bulkhead.yaml. Your other hooks and
      settings are kept. Idempotent: an existing bulkhead.yaml is kept unless
      --force is given (which replaces it, edits included).
      --preset default   conservative; blocks only unambiguous destruction
      --preset strict    also blocks routine-but-destructive commands
                         (git reset --hard, git clean -f, any force-push
                         without lease, prisma migrate reset, docker volume
                         rm...) for unattended runs

  bulkhead uninstall
      Remove Bulkhead's hooks from .claude/settings.json; every other hook
      and setting stays. Keeps bulkhead.yaml and .bulkhead/ (the ledger) —
      delete those yourself if you want them gone.

  bulkhead demo [--json] [--preset <name>] [--keep]
      See it work without touching your repo: replays the incident corpus
      through the real hook in a throwaway repo, then a false "tests pass"
      claim and a blown budget. Exits non-zero if any result differs from the
      corpus expectation. --keep leaves the demo repo on disk for a receipt.

  bulkhead receipt [--session <id> | --last] [--format md|txt|html]
                   [--out <file>] [--no-redact]
      One session on one page, for a PR description: blocks and why, risky
      actions, spend vs cap, each completion claim and its evidence, ledger
      head. Default: the most recent session, markdown, redacted (repo-relative
      paths; secrets in common token shapes masked — pattern-based, so read
      it before posting it anywhere public).

  bulkhead badge
      Print a "Guarded by Bulkhead" README badge snippet. Writes no files.

  bulkhead hook pre | post | stop
      Hook entrypoints. Read a Claude Code hook payload on stdin, enforce the
      policy, and emit the decision. You normally don't run these by hand.
      (stop = completion verification: claims vs recorded evidence)

  bulkhead ledger verify
      Verify the evidence ledger's hash chain.

  bulkhead ledger tail [n]
      Show the last n ledger entries (default 20), one line each.

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
      // --key=value, so `--preset=strict` is read as the preset rather than
      // as an unknown boolean flag that silently leaves the default in place.
      const eq = key.indexOf("=");
      if (eq > 0) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
        continue;
      }
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
    case "uninstall":
      return cmdUninstall();
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
    case "demo":
      return cmdDemo(flags);
    case "receipt":
      return cmdReceipt(flags);
    case "badge":
      return cmdBadge();
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

function cmdUninstall(): number {
  const repoRoot = findRepoRoot(process.cwd());
  let r;
  try {
    r = runUninstall(repoRoot);
  } catch (err) {
    process.stderr.write(`bulkhead uninstall failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const kept = [r.policyKept ? "bulkhead.yaml" : null, r.stateKept ? ".bulkhead/" : null].filter((x): x is string => x !== null);
  process.stdout.write(
    [
      r.hooksRemoved > 0
        ? `✅ Bulkhead unhooked in ${r.repoRoot}\n   • hooks: removed ${r.hooksRemoved} from ${r.settingsPath} (everything else kept)`
        : `No Bulkhead hooks found in ${r.settingsPath} — nothing to remove.`,
      ...(kept.length > 0
        ? [
            `   • kept: ${kept.join(" and ")} — your policy and the ledger are yours.`,
            `     To remove them too:  rm -rf ${kept.join(" ")}`,
          ]
        : []),
      ``,
    ].join("\n"),
  );
  return 0;
}

function cmdInit(flags: Record<string, string | boolean>): number {
  // Validate the preset before touching anything, so a typo never installs
  // hooks under a policy the user did not ask for.
  const presetFlag = flags.preset;
  if (presetFlag !== undefined && !isPolicyPreset(presetFlag)) {
    const given = presetFlag === true ? "(no value)" : JSON.stringify(presetFlag);
    process.stderr.write(
      `bulkhead init: unknown --preset ${given}. Expected one of: ${POLICY_PRESETS.join(", ")}.\n`,
    );
    return 1;
  }
  const repoRoot = findRepoRoot(process.cwd());
  let result;
  try {
    result = runInit(repoRoot, {
      hookCommand: typeof flags.command === "string" ? flags.command : undefined,
      force: flags.force === true,
      preset: presetFlag,
    });
  } catch (err) {
    process.stderr.write(`bulkhead init failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  // An explicit --preset that did not reach an existing file must say so: a
  // user who asked for strict and silently kept default would believe the
  // stricter rules are running.
  const policyLine = result.policyCreated
    ? `created (preset: ${result.preset})`
    : presetFlag !== undefined
      ? `kept existing — --preset ${result.preset} was NOT applied. Re-run with --force to replace the file (your edits to it are lost).`
      : "kept existing";
  process.stdout.write(
    [
      `✅ Bulkhead installed in ${result.repoRoot}`,
      `   • bulkhead.yaml: ${policyLine}`,
      `   • hooks: merged into ${result.settingsPath}`,
      `   • .gitignore: ${result.gitignoreUpdated ? "added .bulkhead/" : "already ignored"}`,
      ``,
      `Every tool call is now checked; blocks land in .bulkhead/ledger.jsonl.`,
      `Containment + evidence, not a firewall: hooks are bypassable (see README).`,
      ``,
      `Next:`,
      `   See it work:  npx @bulkheadtools/cli demo`,
      `   Add a badge:  npx @bulkheadtools/cli badge`,
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
    failOpenNotice(kind, "could not parse the hook input");
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
    // Any internal error fails OPEN: a bug in Bulkhead must not break the
    // user's agent. The failure is said out loud: stderr for the debug log,
    // and a systemMessage, because Claude Code shows exit-0 stderr to no one.
    // (The exceptions — an unwritable .bulkhead/ state dir, F2 — never reach
    // this handler: handlePreToolUse converts StateDirUnavailableError into a
    // deny verdict, and handleStop converts it into the Stop hook's blocking
    // shape (F2b). Both are gate decisions; see hook.ts.)
    process.stderr.write(`bulkhead: hook error (failing open): ${String(err)}\n`);
    failOpenNotice(kind, String(err));
    return 0;
  }
}

/**
 * Tell the human a call went through unchecked. A systemMessage is the one
 * channel Claude Code shows the user for an exit-0 hook; it carries no
 * decision, so the tool call proceeds exactly as it would have.
 */
function failOpenNotice(kind: string | undefined, why: string): void {
  const what = kind === "stop" ? "the completion check did not run" : "this tool call was NOT checked";
  process.stdout.write(
    JSON.stringify({ systemMessage: `🛡 Bulkhead hook error — ${what} (failing open): ${why.slice(0, 200)}` }),
  );
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
      const summary = entrySummary(e, { repoRoot, max: 80 });
      const parts = [
        `#${e.seq}`,
        e.ts,
        `${mark}${e.event}`,
        e.toolName ?? "",
        e.action ?? "",
        e.guard ? `[${e.guard}]` : "",
        summary ? `· ${summary}` : "",
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
  const blocks = ids.map((id) => renderSessionReport(buildSessionReport(entries, id, { repoRoot })));
  process.stdout.write(blocks.join("\n\n") + "\n");
  return 0;
}

function asMinLevel(v: string | boolean | undefined): RiskLevel {
  return v === "low" || v === "medium" || v === "high" ? v : "low";
}

function cmdInbox(flags: Record<string, string | boolean>): number {
  const repoRoot = findRepoRoot(process.cwd());
  const inbox = buildInbox(readLedger(repoRoot), asMinLevel(flags.min), { repoRoot });
  process.stdout.write(renderInbox(inbox) + "\n");
  return 0;
}

async function cmdNotify(flags: Record<string, string | boolean>): Promise<number> {
  const repoRoot = findRepoRoot(process.cwd());
  const inbox = buildInbox(readLedger(repoRoot), asMinLevel(flags.min), { repoRoot });
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
      ...denials.slice(-5).map((e) => `  ${denialLine(e)}`),
      ``,
    ]
      .filter((l) => l !== "")
      .join("\n") + "\n",
  );
  return 0;
}

function cmdDemo(flags: Record<string, string | boolean>): number {
  if (flags.preset === true) {
    process.stderr.write(`bulkhead demo: --preset needs a name (${DEMO_PRESETS.join(", ")})\n`);
    return 1;
  }
  const preset = typeof flags.preset === "string" ? flags.preset : undefined;
  if (preset !== undefined && !isDemoPreset(preset)) {
    process.stderr.write(`bulkhead demo: unknown preset "${preset}" (known: ${DEMO_PRESETS.join(", ")})\n`);
    return 1;
  }
  let result;
  try {
    result = runDemo({ version: version(), preset, keep: flags.keep === true });
  } catch (err) {
    process.stderr.write(`bulkhead demo failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (flags.json === true) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(renderDemo(result, { color: shouldColor(process.stdout) }));
  }
  // A result that differs from the corpus expectation is a failure, never a
  // footnote: scripts and CI that run the demo must see it.
  return result.ok ? 0 : 1;
}

function receiptFormat(flags: Record<string, string | boolean>): string {
  if (typeof flags.format === "string") return flags.format;
  if (typeof flags.out === "string") {
    const ext = extname(flags.out).toLowerCase();
    if (ext === ".htm" || ext === ".html") return "html";
    if (ext === ".txt") return "txt";
  }
  return "md";
}

function cmdReceipt(flags: Record<string, string | boolean>): number {
  const format = receiptFormat(flags);
  if (!(RECEIPT_FORMATS as readonly string[]).includes(format)) {
    process.stderr.write(`bulkhead receipt: unknown --format "${format}" (md, txt, html)\n`);
    return 1;
  }
  if (flags.session === true) {
    process.stderr.write("bulkhead receipt: --session needs an id (or use --last)\n");
    return 1;
  }
  if (flags.out === true) {
    process.stderr.write("bulkhead receipt: --out needs a file path\n");
    return 1;
  }
  const repoRoot = findRepoRoot(process.cwd());
  const entries = readLedger(repoRoot);
  if (entries.length === 0) {
    process.stderr.write(
      "No ledger entries yet — nothing to put on a receipt.\n" +
        "Run a Claude Code session with Bulkhead installed, or try: npx @bulkheadtools/cli demo --keep\n",
    );
    return 1;
  }
  const picked = resolveSession(entries, typeof flags.session === "string" ? flags.session : undefined);
  if ("error" in picked) {
    process.stderr.write(`bulkhead receipt: ${picked.error}\n`);
    return 1;
  }
  let sessionCapUsd: number | undefined;
  try {
    sessionCapUsd = loadPolicy(repoRoot).budget.sessionUsd;
  } catch {
    sessionCapUsd = undefined; // an unreadable policy still gets a receipt, minus the cap
  }
  const receipt = buildReceipt(entries, {
    repoRoot,
    sessionId: picked.sessionId,
    redact: flags["no-redact"] !== true,
    sessionCapUsd,
  });
  const text = renderReceipt(receipt, format as ReceiptFormat);
  if (typeof flags.out === "string") {
    const path = resolve(process.cwd(), flags.out);
    try {
      writeFileSync(path, text);
    } catch (err) {
      process.stderr.write(
        `bulkhead receipt: could not write ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
    process.stdout.write(`Wrote ${format} receipt for session ${picked.sessionId} to ${path}\n`);
    return 0;
  }
  process.stdout.write(text);
  return 0;
}

function cmdBadge(): number {
  // The snippet alone on stdout (pipe-clean); the hint only for a human.
  if (process.stdout.isTTY) process.stderr.write("Paste into your README:\n\n");
  process.stdout.write(BADGE_MARKDOWN + "\n");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`bulkhead: fatal: ${String(err)}\n`);
    process.exit(1);
  },
);
