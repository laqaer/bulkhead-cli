import { existsSync, readFileSync } from "node:fs";
import type { Decision, HookInput, ToolCall } from "./types.js";
import { atomicWrite } from "./fs-lock.js";
import { loadPolicy } from "./policy.js";
import { findRepoRoot, loopStatePath } from "./paths.js";
import {
  sessionCostFromTranscript,
  rollupDailySpend,
  buildCostBreakdown,
  localDateString,
} from "./cost.js";
import {
  loopCheck,
  emptyLoopState,
  signatureFor,
  type LoopState,
} from "./guards/loop.js";
import { evaluate } from "./engine.js";
import { appendLedger, readLedger } from "./ledger.js";
import { formatRefusal, formatAsk } from "./refusal.js";
import { classifyEvidence } from "./evidence.js";
import { assessStop, sessionEvidence } from "./verify.js";
import { assessRisk } from "./risk.js";

/**
 * The shape Claude Code reads back from a PreToolUse hook. We only ever emit a
 * decision when we intervene; on "allow" we return an empty object and let the
 * host's normal permission flow proceed (emitting "allow" would force-approve
 * the call and defeat the user's own settings).
 */
export interface PreToolUseOutput {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny" | "ask";
    permissionDecisionReason: string;
  };
  suppressOutput?: boolean;
}

export interface HookResult {
  /** JSON to print on stdout (may be empty). */
  output: unknown;
  /** Process exit code. */
  exitCode: number;
}

/** Full PreToolUse handling, minus stdin/stdout plumbing (that's in the CLI). */
export function handlePreToolUse(input: HookInput, now: Date = new Date()): HookResult {
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const repoRoot = findRepoRoot(cwd);
  const policy = loadPolicy(repoRoot);
  const sessionId = typeof input.session_id === "string" ? input.session_id : "unknown";

  const call: ToolCall = {
    toolName: typeof input.tool_name === "string" ? input.tool_name : "",
    toolInput:
      input.tool_input && typeof input.tool_input === "object"
        ? (input.tool_input as Record<string, unknown>)
        : {},
  };

  // Cost: recompute session total from the transcript, refresh the daily
  // rollup, read back today's aggregate. Deterministic sum, no estimation.
  const session = sessionCostFromTranscript(input.transcript_path, policy.budget.pricing);
  const today = localDateString(now);
  const dayUsd = rollupDailySpend(repoRoot, sessionId, session.totalUsd, today);
  const cost = buildCostBreakdown(session, dayUsd);

  // Loop: load persisted state, run the pure check, persist the next state.
  const state = readLoopState(repoRoot);
  const sig = signatureFor(call);
  const { verdict: loopVerdict, state: nextState } = loopCheck(
    state,
    sig,
    now.getTime(),
    policy.loop,
  );
  writeLoopState(repoRoot, nextState);

  // Risk is scored for every action; the guard only turns it into an `ask` in
  // `ask` mode. Recorded on the ledger regardless so `record` mode and the
  // inbox can rank it.
  const risk = assessRisk(call);
  const decision = evaluate(call, policy, cost, loopVerdict, risk);

  // Record every interception to the evidence ledger, decision included.
  appendLedger(repoRoot, {
    ts: now.toISOString(),
    sessionId,
    promptId: firstString(input.prompt_id),
    event: "pre",
    toolName: call.toolName,
    toolInput: call.toolInput,
    action: decision.action,
    guard: decision.deciding?.guard,
    rule: decision.deciding?.rule,
    reason: decision.reason,
    cost: { sessionUsd: cost.sessionUsd, dayUsd: cost.dayUsd },
    risk: risk.level ? risk : undefined,
  });

  return renderDecision(decision);
}

/** PostToolUse: refresh spend, classify + record what the completed action proved. */
export function handlePostToolUse(input: HookInput, now: Date = new Date()): HookResult {
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const repoRoot = findRepoRoot(cwd);
  const policy = loadPolicy(repoRoot);
  const sessionId = typeof input.session_id === "string" ? input.session_id : "unknown";

  const session = sessionCostFromTranscript(input.transcript_path, policy.budget.pricing);
  const today = localDateString(now);
  const dayUsd = rollupDailySpend(repoRoot, sessionId, session.totalUsd, today);

  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput =
    input.tool_input && typeof input.tool_input === "object"
      ? (input.tool_input as Record<string, unknown>)
      : {};
  const evidence = classifyEvidence(toolName, toolInput, input.tool_response);

  appendLedger(repoRoot, {
    ts: now.toISOString(),
    sessionId,
    promptId: firstString(input.prompt_id),
    event: "post",
    toolName: toolName || undefined,
    cost: { sessionUsd: session.totalUsd, dayUsd },
    evidence: evidence.length > 0 ? evidence : undefined,
    meta: { toolResponseDigest: digestOf(input.tool_response) },
  });

  return { output: { suppressOutput: true }, exitCode: 0 };
}

/**
 * Stop hook output. Blocking uses the top-level `decision: "block"` schema
 * (Stop hooks differ from PreToolUse's hookSpecificOutput contract): the reason
 * is fed back to Claude, which must keep working instead of finishing.
 */
export interface StopOutput {
  decision?: "block";
  reason?: string;
  suppressOutput?: boolean;
}

/**
 * Stop: completion verification. Compares checkable claims in the agent's final
 * message against the session's ledger evidence. `stop_hook_active` guards
 * against block loops: when the host says this stop already resulted from a
 * prior blocked stop, we never block again — verdicts are recorded only.
 */
export function handleStop(input: HookInput, now: Date = new Date()): HookResult {
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const repoRoot = findRepoRoot(cwd);
  const policy = loadPolicy(repoRoot);
  const sessionId = typeof input.session_id === "string" ? input.session_id : "unknown";

  // Snapshot spend even when verification is off: the stop fires AFTER the
  // turn's final model call, which no Pre/PostToolUse hook ever sees — without
  // this, that call's cost is dropped from the session total and daily rollup,
  // and would be misattributed to the NEXT prompt in per-prompt reports.
  const session = sessionCostFromTranscript(input.transcript_path, policy.budget.pricing);
  const dayUsd = rollupDailySpend(repoRoot, sessionId, session.totalUsd, localDateString(now));
  const cost = { sessionUsd: session.totalUsd, dayUsd };

  if (policy.verify.mode === "off") {
    return { output: { suppressOutput: true }, exitCode: 0 };
  }

  const finalMessage =
    firstString(input.last_assistant_message) ?? firstString(input.lastAssistantMessage) ?? "";
  const evidence = sessionEvidence(readLedger(repoRoot), sessionId);
  const assessment = assessStop(finalMessage, evidence, policy.verify);

  const stopHookActive = input.stop_hook_active === true;
  const blocking = assessment.shouldBlock && !stopHookActive;

  appendLedger(repoRoot, {
    ts: now.toISOString(),
    sessionId,
    promptId: firstString(input.prompt_id),
    event: "stop",
    action: blocking ? "deny" : "allow",
    guard: assessment.verdicts.length > 0 ? "verify" : undefined,
    reason: blocking ? assessment.blockReason : undefined,
    cost,
    meta: {
      verdicts: assessment.verdicts,
      stopHookActive,
      ...(assessment.shouldBlock && stopHookActive
        ? { note: "block suppressed: stop_hook_active (loop guard)" }
        : {}),
    },
  });

  if (blocking) {
    return {
      output: { decision: "block", reason: assessment.blockReason } satisfies StopOutput,
      exitCode: 0,
    };
  }
  return { output: { suppressOutput: true }, exitCode: 0 };
}

function firstString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function renderDecision(decision: Decision): HookResult {
  if (decision.action === "deny") {
    return {
      output: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: formatRefusal(
            decision.deciding ?? { action: "deny", guard: "bulkhead", reason: decision.reason },
          ),
        },
      } satisfies PreToolUseOutput,
      exitCode: 0,
    };
  }
  if (decision.action === "ask") {
    return {
      output: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: formatAsk(
            decision.deciding ?? { action: "ask", guard: "bulkhead", reason: decision.reason },
          ),
        },
      } satisfies PreToolUseOutput,
      exitCode: 0,
    };
  }
  // allow = abstain: emit nothing meaningful, let the host proceed normally.
  return { output: { suppressOutput: true }, exitCode: 0 };
}

function readLoopState(repoRoot: string): LoopState {
  const path = loopStatePath(repoRoot);
  if (!existsSync(path)) return emptyLoopState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LoopState;
    if (parsed && typeof parsed === "object" && parsed.hits) return parsed;
  } catch {
    // fall through to empty on corruption
  }
  return emptyLoopState();
}

function writeLoopState(repoRoot: string, state: LoopState): void {
  // atomicWrite uses a per-process-unique temp file, so concurrent hooks don't
  // collide on a shared `.tmp` name and ENOENT each other's rename.
  atomicWrite(loopStatePath(repoRoot), JSON.stringify(state));
}

function digestOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > 200 ? s.slice(0, 200) + `…(${s.length} chars)` : s;
}
