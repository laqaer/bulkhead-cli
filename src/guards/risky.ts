import type { GuardVerdict, RiskAssessment } from "../types.js";
import type { Policy } from "../policy.js";
import { rankOf } from "../risk.js";

const GUARD = "risky";

/**
 * The approval gate. A risky-but-allowed action (one that isn't denied outright
 * but is worth a human's eyes — a push, a deploy, a dependency add) becomes an
 * `ask` when policy says so. `ask` is weaker than `deny` in the engine, so an
 * action that is both over-budget and risky is still denied; only otherwise-
 * allowed actions are escalated.
 *
 * In `off`/`record` modes this abstains — the risk is still SCORED and recorded
 * on the ledger by the hook, so `bulkhead inbox` can rank it; the action just
 * isn't paused.
 */
export function riskyGuard(assessment: RiskAssessment, policy: Policy): GuardVerdict {
  const cfg = policy.risky;
  if (cfg.mode !== "ask") return { action: "allow", guard: GUARD };
  if (!assessment.level) return { action: "allow", guard: GUARD };
  if (rankOf(assessment.level) < rankOf(cfg.minLevel)) {
    return { action: "allow", guard: GUARD };
  }
  const reasons = assessment.signals.map((s) => s.reason).join("; ");
  return {
    action: "ask",
    guard: GUARD,
    rule: `${assessment.level}-risk`,
    reason: `${assessment.level.toUpperCase()} risk (${assessment.score}/100): ${reasons}. A human should approve this before it runs.`,
  };
}
