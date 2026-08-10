import type { CostBreakdown, GuardVerdict } from "../types.js";
import type { Policy } from "../policy.js";

const GUARD = "budget";

/**
 * Pause the agent when spend crosses a hard cap. "Pause" is implemented as a
 * deny of every subsequent tool call with a clear reason: the agent physically
 * cannot keep spending because every action it attempts is refused. The human
 * un-pauses by raising the cap in bulkhead.yaml (or waiting for the daily
 * rollover). Cost is a deterministic sum over the transcript — no estimation
 * model in the path.
 */
export function budgetGuard(cost: CostBreakdown, policy: Policy): GuardVerdict {
  const { sessionUsd, dailyUsd } = policy.budget;

  if (sessionUsd > 0 && cost.sessionUsd >= sessionUsd) {
    return {
      action: "deny",
      guard: GUARD,
      rule: `session_usd=${sessionUsd}`,
      reason: `Session spend $${cost.sessionUsd.toFixed(2)} has reached the per-session cap of $${sessionUsd.toFixed(2)}. Agent paused. Raise budget.session_usd in bulkhead.yaml to continue.`,
    };
  }

  if (dailyUsd > 0 && cost.dayUsd >= dailyUsd) {
    return {
      action: "deny",
      guard: GUARD,
      rule: `daily_usd=${dailyUsd}`,
      reason: `Today's spend $${cost.dayUsd.toFixed(2)} has reached the daily cap of $${dailyUsd.toFixed(2)}. Agent paused. Raise budget.daily_usd in bulkhead.yaml or wait for daily reset.`,
    };
  }

  return { action: "allow", guard: GUARD };
}
