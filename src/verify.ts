import type { Evidence, LedgerEntry } from "./types.js";
import type { VerifyConfig, VerifyRule } from "./policy.js";

/**
 * Completion verification: when the agent's final message makes a checkable
 * claim ("tests pass", "opened a PR", "committed"), compare it against the
 * evidence the ledger actually recorded during the session.
 *
 * Deterministic by construction: regex claim detection + a lookup over typed
 * evidence, no model judging anything. Three verdicts per matched claim:
 *
 * - supported     — the latest relevant evidence backs the claim.
 * - contradicted  — the latest relevant evidence REFUTES it (claims tests pass,
 *                   the last test run failed). This is the Replit case: work
 *                   reported as done that demonstrably isn't.
 * - unsupported   — the claim matched but the session produced no relevant
 *                   evidence either way. Noted, not blocked, by default —
 *                   agents legitimately summarize work from earlier sessions.
 */
export type VerdictStatus = "supported" | "contradicted" | "unsupported";

export interface Verdict {
  ruleId: string;
  status: VerdictStatus;
  /** The claim text that matched, for the ledger/report. */
  claimExcerpt: string;
  /** The evidence that decided it (absent for unsupported). */
  evidence?: Evidence;
}

export interface StopAssessment {
  verdicts: Verdict[];
  /** True when policy says this stop must be refused. */
  shouldBlock: boolean;
  /** Agent-facing reason when blocking. */
  blockReason?: string;
}

/** Evidence from this session's ledger entries, in append (seq) order. */
export function sessionEvidence(entries: LedgerEntry[], sessionId: string): Evidence[] {
  const out: Evidence[] = [];
  for (const e of entries) {
    if (e.sessionId !== sessionId) continue;
    for (const ev of e.evidence ?? []) out.push(ev);
  }
  return out;
}

export function assessStop(
  finalMessage: string,
  evidence: Evidence[],
  config: VerifyConfig,
): StopAssessment {
  if (config.mode === "off" || !finalMessage) {
    return { verdicts: [], shouldBlock: false };
  }

  const verdicts: Verdict[] = [];
  for (const rule of config.rules) {
    const verdict = judgeRule(rule, finalMessage, evidence);
    if (verdict) verdicts.push(verdict);
  }

  const contradicted = verdicts.filter((v) => v.status === "contradicted");
  const unsupported = verdicts.filter((v) => v.status === "unsupported");

  let shouldBlock = false;
  const reasons: string[] = [];
  if (config.mode === "block") {
    if (contradicted.length > 0) {
      shouldBlock = true;
      for (const v of contradicted) {
        reasons.push(
          `You stated "${v.claimExcerpt}" but the evidence ledger disagrees — the latest relevant evidence is: ${v.evidence?.type}: ${v.evidence?.detail}. Re-run the check and show its real output, or correct your statement to match what actually happened.`,
        );
      }
    }
    if (config.blockOnMissing && unsupported.length > 0) {
      shouldBlock = true;
      for (const v of unsupported) {
        reasons.push(
          `You stated "${v.claimExcerpt}" but no supporting evidence was recorded this session (expected: ${expectedFor(v.ruleId, config)}). Perform the action so it can be verified, or correct your statement.`,
        );
      }
    }
  }

  return {
    verdicts,
    shouldBlock,
    blockReason: shouldBlock
      ? ["⛔ Bulkhead completion check failed.", ...reasons, "This is a deterministic claim-vs-evidence check (bulkhead.yaml: verify)."].join("\n")
      : undefined,
  };
}

/**
 * Words that mark a sentence as hedged, negated, aspirational, or conditional
 * rather than an assertion of fact. "Once the tests pass…", "I could not make
 * the tests pass", "None of the tests pass yet" are not claims — blocking them
 * would punish honest reporting, the exact opposite of the product's job. The
 * guard deliberately prefers false NEGATIVES (a missed claim) over false
 * blocks; claim detection is best-effort accountability, not NLU.
 */
const NON_ASSERTIVE =
  /\b(once|until|after|unless|if|whether|when|before|make|makes|making|made|get|getting|gets|will|would|should|could|cannot|can't|couldn't|won't|wouldn't|shouldn't|do|does|did|don't|doesn't|didn't|not|no|none|nothing|never|haven't|hasn't|hadn't|isn't|aren't|wasn't|weren't|need|needs|needed|want|wants|wanted|try|tries|trying|hope|hoping|goal|ensure|ensuring|still\s+working)\b/i;

/** A failure mention after the claim in the same sentence ("…, 2 failed"). */
const TRAILING_FAILURE = /\bfail(s|ed|ing|ures?)?\b|\bstill\s+red\b|\bbroken\b/i;

/** The sentence containing `index`, plus the match's offset within it. */
function sentenceAt(text: string, index: number): { sentence: string; offset: number } {
  let start = 0;
  let end = text.length;
  const re = /[.!?\n]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index < index) start = m.index + 1;
    else {
      end = m.index + 1;
      break;
    }
  }
  return { sentence: text.slice(start, end), offset: index - start };
}

/** True when the matched claim is a plain assertion, not a hedge/negation. */
export function isAssertive(message: string, matchIndex: number, matchLength: number): boolean {
  const { sentence, offset } = sentenceAt(message, matchIndex);
  const before = sentence.slice(0, offset);
  const after = sentence.slice(offset + matchLength);
  if (NON_ASSERTIVE.test(before)) return false;
  if (/\?\s*$/.test(sentence)) return false; // "Do the tests pass now?"
  if (TRAILING_FAILURE.test(after)) return false; // "10 tests passed, 2 failed"
  return true;
}

function judgeRule(rule: VerifyRule, message: string, evidence: Evidence[]): Verdict | null {
  let re: RegExp;
  try {
    re = new RegExp(rule.claim, "i");
  } catch {
    return null; // a malformed user rule must never crash the stop hook
  }
  const match = re.exec(message);
  if (!match) return null;
  if (!isAssertive(message, match.index, match[0].length)) return null;

  const claimExcerpt = match[0].slice(0, 120);
  const supports = new Set(rule.evidence);
  const contradicts = new Set(rule.contradictedBy ?? []);

  // The LATEST relevant evidence wins: a failed run followed by a passing
  // re-run supports the claim; a pass followed by a newly-failing run refutes it.
  let latest: { kind: "support" | "contradict"; ev: Evidence } | undefined;
  for (const ev of evidence) {
    if (supports.has(ev.type)) latest = { kind: "support", ev };
    else if (contradicts.has(ev.type)) latest = { kind: "contradict", ev };
  }

  if (!latest) return { ruleId: rule.id, status: "unsupported", claimExcerpt };
  if (latest.kind === "contradict") {
    return { ruleId: rule.id, status: "contradicted", claimExcerpt, evidence: latest.ev };
  }
  return { ruleId: rule.id, status: "supported", claimExcerpt, evidence: latest.ev };
}

function expectedFor(ruleId: string, config: VerifyConfig): string {
  const rule = config.rules.find((r) => r.id === ruleId);
  return rule ? rule.evidence.join(" or ") : "evidence";
}
