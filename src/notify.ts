import type { Inbox } from "./inbox.js";
import type { RiskLevel } from "./types.js";

/**
 * Notification seam for the approval inbox. The hosted tier (Telegram bot,
 * Slack app, hosted dashboard) plugs in here. The OSS core ships two channels:
 * `console` (print) and `webhook` (POST a Slack-compatible card to a URL the
 * user configured in bulkhead.yaml). Bulkhead never creates bot tokens or
 * accounts — a webhook URL is a value the user provides, and pushes only fire
 * from an explicit `bulkhead notify`, never from the enforcement hot path.
 */

export interface NotifyChannel {
  id: string;
  send(card: BatchCard): Promise<void>;
}

export interface BatchCard {
  title: string;
  /** Plain-text body (console). */
  text: string;
  counts: Record<RiskLevel, number>;
  /** The top few items, already ranked. */
  top: Array<{ level: RiskLevel; score: number; summary: string; reasons: string[] }>;
}

/** Build a risk-ranked batch card from an inbox — the thing you review. */
export function formatBatchCard(inbox: Inbox, opts: { maxItems?: number; label?: string } = {}): BatchCard {
  const max = opts.maxItems ?? 10;
  const top = inbox.items.slice(0, max).map((it) => ({
    level: it.level,
    score: it.score,
    summary: it.summary,
    reasons: it.reasons,
  }));
  const label = opts.label ? `${opts.label} — ` : "";
  const title = `${label}Bulkhead: ${inbox.counts.high} high · ${inbox.counts.medium} medium · ${inbox.counts.low} low risk action(s)`;
  const lines = [title, ""];
  for (const it of top) {
    lines.push(`• [${it.level} ${it.score}] ${it.summary}`);
    lines.push(`    ${it.reasons.join("; ")}`);
  }
  if (inbox.items.length > top.length) {
    lines.push(`…and ${inbox.items.length - top.length} more.`);
  }
  return { title, text: lines.join("\n"), counts: inbox.counts, top };
}

export class ConsoleChannel implements NotifyChannel {
  id = "console";
  constructor(private write: (s: string) => void = (s) => process.stdout.write(s)) {}
  async send(card: BatchCard): Promise<void> {
    this.write(card.text + "\n");
  }
}

/**
 * POST a Slack-compatible Block Kit payload to a webhook URL. Works with Slack
 * incoming webhooks and any endpoint that accepts `{text, blocks}` JSON. The
 * `text` field is the required Slack fallback for notification previews.
 */
export class WebhookChannel implements NotifyChannel {
  id = "webhook";
  constructor(private url: string, private fetchImpl: typeof fetch = fetch) {}

  async send(card: BatchCard): Promise<void> {
    const blocks: unknown[] = [
      { type: "header", text: { type: "plain_text", text: card.title.slice(0, 150), emoji: true } },
    ];
    for (const it of card.top) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*[${it.level} ${it.score}]* ${slackEscape(it.summary)}\n${slackEscape(it.reasons.join("; "))}` },
      });
    }
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: card.title, blocks }),
    });
    if (!res.ok) {
      throw new Error(`webhook POST failed (${res.status}): ${await safeText(res)}`);
    }
  }
}

export function channelFor(target: string, url?: string): NotifyChannel {
  if (target === "webhook") {
    if (!url) throw new Error("webhook channel requires a URL (bulkhead notify --url <url>)");
    return new WebhookChannel(url);
  }
  return new ConsoleChannel();
}

function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
