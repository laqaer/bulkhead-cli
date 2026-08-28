import type { GuardVerdict } from "./types.js";

/**
 * A structured refusal the agent can read but cannot argue past. It is emitted
 * verbatim as the hook's decision reason. The wording deliberately makes clear
 * the check is deterministic and lives outside the model, so the agent doesn't
 * waste turns trying to negotiate — there is nothing to negotiate with.
 */
export function formatRefusal(verdict: GuardVerdict): string {
  const lines = [
    "⛔ Bulkhead blocked this action.",
    `Guard: ${verdict.guard}`,
  ];
  if (verdict.rule) lines.push(`Rule: ${verdict.rule}`);
  if (verdict.reason) lines.push(`Why: ${verdict.reason}`);
  lines.push(
    "This is a deterministic policy check that runs outside the model and cannot be overridden by reasoning.",
  );
  // The generic footer tells the reader to change bulkhead.yaml — the right
  // remedy for a policy guard, and the WRONG one for the state-dir guard: no
  // policy edit restores an unavailable .bulkhead/, only restoring its
  // filesystem access or capacity does. The state-dir Why line names the exact
  // fix; the footer must not contradict it.
  lines.push(
    verdict.guard === "state-dir"
      ? "To proceed, a human must restore .bulkhead state storage using the fix above — editing bulkhead.yaml will not help."
      : "To proceed, a human must change bulkhead.yaml or perform this action manually.",
  );
  return lines.join("\n");
}

/** Reason text for an `ask` verdict routed to the (paid) approval inbox. */
export function formatAsk(verdict: GuardVerdict): string {
  const lines = ["⏸️ Bulkhead paused this action for human approval."];
  if (verdict.rule) lines.push(`Rule: ${verdict.rule}`);
  if (verdict.reason) lines.push(`Why: ${verdict.reason}`);
  return lines.join("\n");
}
