import { createHash } from "node:crypto";
import type { GuardVerdict, ToolCall } from "../types.js";
import type { LoopConfig } from "../policy.js";

const GUARD = "loop";

/** Per-signature timestamps (epoch ms), persisted between hook invocations. */
export interface LoopState {
  /** signature -> recent call timestamps within the window. */
  hits: Record<string, number[]>;
}

export function emptyLoopState(): LoopState {
  return { hits: {} };
}

/**
 * A stable signature for "the same action again": tool name + a hash of the
 * canonicalized tool input. Identical retries produce identical signatures;
 * a changed argument produces a new one, so legitimate iteration isn't frozen.
 */
export function signatureFor(call: ToolCall): string {
  const canonical = stableStringify(call.toolInput ?? {});
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `${call.toolName}:${digest}`;
}

/**
 * Pure loop check. Records `now` for the signature, prunes timestamps outside
 * the window, and freezes when the count reaches maxRepeats. Returns the next
 * state so the caller can persist it. Deterministic given (state, signature,
 * now, config).
 */
export function loopCheck(
  state: LoopState,
  signature: string,
  now: number,
  config: LoopConfig,
): { verdict: GuardVerdict; state: LoopState } {
  const windowMs = config.windowSeconds * 1000;
  const prior = state.hits[signature] ?? [];
  const recent = prior.filter((t) => now - t < windowMs);
  recent.push(now);

  const nextHits: Record<string, number[]> = { ...state.hits, [signature]: recent };
  // Opportunistically drop stale signatures so the file doesn't grow unbounded.
  for (const [sig, times] of Object.entries(nextHits)) {
    const kept = times.filter((t) => now - t < windowMs);
    if (kept.length === 0) delete nextHits[sig];
    else nextHits[sig] = kept;
  }
  const nextState: LoopState = { hits: nextHits };

  if (config.maxRepeats > 0 && recent.length >= config.maxRepeats) {
    return {
      verdict: {
        action: "deny",
        guard: GUARD,
        rule: `max_repeats=${config.maxRepeats}`,
        reason: `The same action repeated ${recent.length} times within ${config.windowSeconds}s — frozen as a suspected loop. Change the approach or raise loop.max_repeats in bulkhead.yaml.`,
      },
      state: nextState,
    };
  }

  return { verdict: { action: "allow", guard: GUARD }, state: nextState };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
