import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create an isolated temp repo root for a test. */
export function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "bulkhead-test-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

/** Write a Claude Code-style transcript JSONL with the given assistant usages. */
export function writeTranscript(
  path: string,
  messages: Array<{ model: string; usage: Record<string, unknown>; id?: string }>,
): void {
  const lines = messages.map((m, i) =>
    JSON.stringify({
      type: "assistant",
      message: { id: m.id ?? `msg_${i}`, model: m.model, usage: m.usage },
    }),
  );
  // Include a non-assistant line to exercise filtering.
  lines.unshift(JSON.stringify({ type: "user", message: { content: "hi" } }));
  writeFileSync(path, lines.join("\n") + "\n");
}
