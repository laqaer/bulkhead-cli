import type { CostBreakdown, Decision, GuardVerdict, RiskAssessment, ToolCall } from "./types.js";
import type { Policy } from "./policy.js";
import { protectedPathsGuard } from "./guards/protected-paths.js";
import { blockedCommandsGuard } from "./guards/blocked-commands.js";
import { budgetGuard } from "./guards/budget.js";
import { riskyGuard } from "./guards/risky.js";

/**
 * Combine guard verdicts into one decision. Precedence: deny > ask > allow.
 * `allow` is abstention — if every guard allows, the decision is allow and the
 * hook stays silent so Claude Code's own permission flow runs unchanged.
 */
export function combineVerdicts(verdicts: GuardVerdict[]): Decision {
  const deny = verdicts.find((v) => v.action === "deny");
  if (deny) {
    return { action: "deny", deciding: deny, verdicts, reason: deny.reason };
  }
  const ask = verdicts.find((v) => v.action === "ask");
  if (ask) {
    return { action: "ask", deciding: ask, verdicts, reason: ask.reason };
  }
  return { action: "allow", verdicts };
}

/**
 * Evaluate a tool call against every guard. Budget and loop verdicts are
 * computed by the caller (they need filesystem state) and passed in; the
 * path/command guards are pure and run here. Guard order sets which reason
 * surfaces when several fire: a paused (over-budget/looping) agent should hear
 * that first, so those come before the content guards.
 */
export function evaluate(
  call: ToolCall,
  policy: Policy,
  cost: CostBreakdown,
  loopVerdict: GuardVerdict,
  risk: RiskAssessment,
): Decision {
  const verdicts: GuardVerdict[] = [
    budgetGuard(cost, policy),
    loopVerdict,
    blockedCommandsGuard(call, policy),
    protectedPathsGuard(call, policy),
    riskyGuard(risk, policy),
  ];
  return combineVerdicts(verdicts);
}
