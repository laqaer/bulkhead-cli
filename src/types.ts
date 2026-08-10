/**
 * Core types for Bulkhead — the deterministic guardrail + evidence layer.
 *
 * Design rule: enforcement is deterministic. No LLM ever runs in the decision
 * path. A guard looks at a tool call and returns a verdict; the engine combines
 * verdicts; the hook adapter translates the combined decision into the wire
 * format Claude Code expects. Every step is reproducible from inputs alone.
 */

/** What Bulkhead wants to happen to a tool call. */
export type Action = "allow" | "deny" | "ask";

/**
 * One guard's opinion about a single tool call.
 *
 * `allow` means "no objection" (not "force-approve") — the engine treats it as
 * abstention so Claude Code's own permission flow still runs. Only `deny` and
 * `ask` cause Bulkhead to intervene.
 */
export interface GuardVerdict {
  action: Action;
  /** Stable guard id, e.g. "protected-paths". */
  guard: string;
  /** Which configured rule fired, if any (glob, regex, cap). */
  rule?: string;
  /** Human- and agent-readable explanation. */
  reason?: string;
}

/** The tool call as Claude Code presents it to a PreToolUse hook. */
export interface ToolCall {
  toolName: string;
  toolInput: Record<string, unknown>;
}

/**
 * The raw JSON a Claude Code hook receives on stdin. Fields are optional
 * because the set differs by event and can drift across CLI versions; the
 * adapter reads defensively and never assumes a field is present.
 */
export interface HookInput {
  session_id?: string;
  prompt_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  /** Stop/SubagentStop: the agent's final message, per the hooks docs. */
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  [key: string]: unknown;
}

/** A resolved decision for one tool call, after combining all guard verdicts. */
export interface Decision {
  action: Action;
  /** The verdict that determined the outcome (the strongest one). */
  deciding?: GuardVerdict;
  /** Every verdict, for the evidence ledger. */
  verdicts: GuardVerdict[];
  reason?: string;
}

/** Per-1M-token prices for one model, in USD. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Token usage as reported in a Claude Code transcript assistant message. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /**
   * When present, splits cache-creation tokens by TTL so they can be priced
   * exactly (5-minute writes are 1.25× input, 1-hour writes are 2×). Falls
   * back to `cache_creation_input_tokens` at 1.25× when absent.
   */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

export interface CostBreakdown {
  /** USD spent in this session (from its transcript). */
  sessionUsd: number;
  /** USD spent across all sessions today (local date). */
  dayUsd: number;
  /** Per-model session totals, for reporting. */
  byModel: Record<string, number>;
  /** Models seen in the transcript with no known price (billed at fallback). */
  unpricedModels: string[];
}

/**
 * What a completed tool call proves happened. Classified deterministically from
 * the tool name, input, and response — exit codes preferred over output regexes.
 */
export type EvidenceType =
  | "file_created"
  | "file_modified"
  | "test_passed"
  | "test_failed"
  | "test_run" // a test command ran but pass/fail could not be determined
  | "commit_created"
  | "pr_created";

export interface Evidence {
  type: EvidenceType;
  /** Human-readable specifics (path, PR URL, test summary tail). Truncated. */
  detail: string;
}

/** How risky an allowed-but-notable action is (for the approval inbox). */
export type RiskLevel = "low" | "medium" | "high";

export interface RiskSignal {
  id: string;
  level: RiskLevel;
  reason: string;
}

export interface RiskAssessment {
  /** Highest signal level, or undefined when nothing matched. */
  level?: RiskLevel;
  /** 0–100, for ranking WITHIN a level. */
  score: number;
  signals: RiskSignal[];
}

/** One immutable, hash-chained ledger record. */
export interface LedgerEntry {
  seq: number;
  ts: string;
  sessionId: string;
  /** The user prompt this activity belongs to (for per-task cost attribution). */
  promptId?: string;
  /** Event kind: a pre/post tool interception, or a synthetic note. */
  event: "pre" | "post" | "stop" | "note";
  toolName?: string;
  /** Full tool input, kept locally for evidence (ledger dir is gitignored). */
  toolInput?: unknown;
  action?: Action;
  guard?: string;
  rule?: string;
  reason?: string;
  cost?: { sessionUsd: number; dayUsd: number };
  /** Risk assessment of an attempted action (pre events with matched signals). */
  risk?: RiskAssessment;
  /** What this completed action proved (post events). */
  evidence?: Evidence[];
  /** Freeform payload for post/stop events (verification results, etc.). */
  meta?: Record<string, unknown>;
  /** sha256 of the previous entry's `hash`, or "GENESIS" for seq 0. */
  prevHash: string;
  /** sha256 over the canonical entry with `hash` omitted. */
  hash: string;
}
