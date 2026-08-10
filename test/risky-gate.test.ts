import { describe, it, expect } from "vitest";
import { riskyGuard } from "../src/guards/risky.js";
import { evaluate } from "../src/engine.js";
import { defaultPolicy } from "../src/policy.js";
import { assessRisk } from "../src/risk.js";
import { buildInbox, renderInbox } from "../src/inbox.js";
import { formatBatchCard, ConsoleChannel, WebhookChannel } from "../src/notify.js";
import type { CostBreakdown, LedgerEntry, ToolCall } from "../src/types.js";

const zeroCost: CostBreakdown = { sessionUsd: 0, dayUsd: 0, byModel: {}, unpricedModels: [] };
const allowLoop = { action: "allow" as const, guard: "loop" };
const push: ToolCall = { toolName: "Bash", toolInput: { command: "git push origin main" } };

describe("riskyGuard", () => {
  it("abstains in mode=off", () => {
    const p = defaultPolicy("/repo"); // default mode off
    expect(riskyGuard(assessRisk(push), p).action).toBe("allow");
  });
  it("abstains in mode=record (recorded, not paused)", () => {
    const p = defaultPolicy("/repo");
    p.risky.mode = "record";
    expect(riskyGuard(assessRisk(push), p).action).toBe("allow");
  });
  it("asks in mode=ask for an action at/above min_level", () => {
    const p = defaultPolicy("/repo");
    p.risky.mode = "ask";
    const v = riskyGuard(assessRisk(push), p);
    expect(v.action).toBe("ask");
    expect(v.reason).toContain("HIGH risk");
  });
  it("abstains for an action below min_level", () => {
    const p = defaultPolicy("/repo");
    p.risky.mode = "ask";
    p.risky.minLevel = "high";
    // dependency add is medium < high
    const dep: ToolCall = { toolName: "Bash", toolInput: { command: "npm install foo" } };
    expect(riskyGuard(assessRisk(dep), p).action).toBe("allow");
  });
  it("abstains for a non-risky action", () => {
    const p = defaultPolicy("/repo");
    p.risky.mode = "ask";
    const safe: ToolCall = { toolName: "Bash", toolInput: { command: "npm test" } };
    expect(riskyGuard(assessRisk(safe), p).action).toBe("allow");
  });
});

describe("engine integration — ask is weaker than deny", () => {
  it("a risky action becomes ask when otherwise allowed", () => {
    const p = defaultPolicy("/repo");
    p.risky.mode = "ask";
    expect(evaluate(push, p, zeroCost, allowLoop, assessRisk(push)).action).toBe("ask");
  });
  it("a risky action that is ALSO over budget is denied, not asked", () => {
    const p = defaultPolicy("/repo");
    p.risky.mode = "ask";
    const over: CostBreakdown = { sessionUsd: 99, dayUsd: 99, byModel: {}, unpricedModels: [] };
    const d = evaluate(push, p, over, allowLoop, assessRisk(push));
    expect(d.action).toBe("deny");
    expect(d.deciding?.guard).toBe("budget");
  });
});

describe("inbox ranking", () => {
  const mk = (seq: number, level: "low" | "medium" | "high", score: number, command: string, action = "allow"): LedgerEntry => ({
    seq, ts: `t${seq}`, sessionId: "s", event: "pre", action,
    toolName: "Bash", toolInput: { command },
    risk: { level, score, signals: [{ id: "x", level, reason: `${level} thing` }] },
    prevHash: "p", hash: "h",
  });

  it("ranks high → low, then by score", () => {
    const entries = [
      mk(0, "low", 10, "npm install a"),
      mk(1, "high", 40, "git push origin main"),
      mk(2, "medium", 25, "pip install b"),
      mk(3, "high", 80, "sudo deploy"),
    ];
    const inbox = buildInbox(entries);
    expect(inbox.items.map((i) => i.seq)).toEqual([3, 1, 2, 0]);
    expect(inbox.counts).toEqual({ high: 2, medium: 1, low: 1 });
  });

  it("min filter drops lower levels", () => {
    const entries = [mk(0, "low", 10, "x"), mk(1, "high", 40, "y")];
    expect(buildInbox(entries, "high").items).toHaveLength(1);
  });

  it("ignores non-pre and unscored entries", () => {
    const entries: LedgerEntry[] = [
      { seq: 0, ts: "t", sessionId: "s", event: "post", prevHash: "p", hash: "h" },
      mk(1, "high", 40, "git push"),
    ];
    expect(buildInbox(entries).items).toHaveLength(1);
  });

  it("renders empty and populated", () => {
    expect(renderInbox(buildInbox([]))).toContain("empty");
    expect(renderInbox(buildInbox([mk(0, "high", 40, "git push origin main")]))).toContain("git push");
  });
});

describe("notify", () => {
  const inbox = buildInbox([
    { seq: 0, ts: "t", sessionId: "s", event: "pre", action: "ask", toolName: "Bash", toolInput: { command: "git push origin main" }, risk: { level: "high", score: 40, signals: [{ id: "git-push", level: "high", reason: "pushes commits to a remote" }] }, prevHash: "p", hash: "h" },
  ]);

  it("formats a batch card with counts and ranked items", () => {
    const card = formatBatchCard(inbox, { label: "overnight" });
    expect(card.title).toContain("1 high");
    expect(card.text).toContain("git push origin main");
    expect(card.top).toHaveLength(1);
  });

  it("console channel writes the card text", async () => {
    let out = "";
    await new ConsoleChannel((s) => { out += s; }).send(formatBatchCard(inbox));
    expect(out).toContain("git push");
  });

  it("webhook channel POSTs Slack-compatible JSON and throws on non-ok", async () => {
    const calls: any[] = [];
    const fakeFetch = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => "" } as any;
    }) as unknown as typeof fetch;
    await new WebhookChannel("https://hooks.example.com/x", fakeFetch).send(formatBatchCard(inbox));
    expect(calls[0].url).toBe("https://hooks.example.com/x");
    expect(calls[0].body.text).toContain("high");
    expect(calls[0].body.blocks[0].type).toBe("header");

    const failFetch = (async () => ({ ok: false, status: 500, text: async () => "boom" } as any)) as unknown as typeof fetch;
    await expect(new WebhookChannel("https://x", failFetch).send(formatBatchCard(inbox))).rejects.toThrow("500");
  });
});
