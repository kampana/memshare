import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Usage log — one line per MCP tool call, appended to `usage.jsonl` in the
 * store directory.
 *
 * The store-item stats already answer "how many memories exist?" but they
 * cannot tell you whether `memory_get` is actually firing and returning
 * results, or whether `memory_set` calls are landing. This log can.
 *
 * The file is append-only JSONL so a crash can lose at most one line, and
 * concurrent writers (two MCP sessions) produce valid output without locking.
 */

export interface UsageEvent {
  /** Which MCP tool was called. */
  tool: string;
  /** ISO-8601 timestamp. */
  ts: string;
  /** MCP client name from the handshake ("claude-code", "cursor-vscode", …). */
  client: string;
  /** For memory_get: how many items were returned. */
  hits?: number;
  /** For memory_set / memory_suggest: true if something was persisted or queued. */
  saved?: boolean;
}

export interface UsageStats {
  /** How far back the window looks, in days. */
  days: number;
  /** Total logged events in the window. */
  totalCalls: number;
  /** Per-tool breakdown. */
  tools: Record<
    string,
    {
      calls: number;
      /** memory_get: calls that returned ≥1 item. memory_set: calls that saved. */
      successes: number;
      /** memory_get only: average items per call that returned something. */
      avgHits?: number;
    }
  >;
  /** Per-day call counts, oldest first, zeroes included. */
  perDay: Array<{ date: string; calls: number }>;
  /** Per-client breakdown. */
  clients: Array<{ client: string; calls: number }>;
}

const DAY_MS = 86_400_000;

export function usageLogPath(storeRoot: string): string {
  return path.join(storeRoot, "usage.jsonl");
}

/** Append one event. Fire-and-forget — a failed write must not break a tool call. */
export async function logUsage(storeRoot: string, event: UsageEvent): Promise<void> {
  try {
    const line = JSON.stringify(event) + "\n";
    await fs.appendFile(usageLogPath(storeRoot), line, "utf8");
  } catch {
    // Best effort. The MCP server logs to stderr if it needs to.
  }
}

/** Read every event from the log. Malformed lines are silently skipped. */
export async function readUsageLog(storeRoot: string): Promise<UsageEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(usageLogPath(storeRoot), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const events: UsageEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as UsageEvent);
    } catch {
      continue;
    }
  }
  return events;
}

export interface UsageStatsOptions {
  days?: number;
  now?: number;
}

export function computeUsageStats(
  events: UsageEvent[],
  options: UsageStatsOptions = {},
): UsageStats {
  const days = Math.max(1, Math.floor(options.days ?? 14));
  const now = options.now ?? Date.now();
  const since = now - days * DAY_MS;

  const recent = events.filter((e) => Date.parse(e.ts) >= since);

  // Per-day buckets, oldest first, zeroes included.
  const perDay = new Map<string, number>();
  for (let d = days - 1; d >= 0; d -= 1) {
    perDay.set(new Date(now - d * DAY_MS).toISOString().slice(0, 10), 0);
  }
  for (const e of recent) {
    const day = e.ts.slice(0, 10);
    if (perDay.has(day)) perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }

  // Per-tool breakdown.
  const toolMap = new Map<string, { calls: number; successes: number; totalHits: number; hitCalls: number }>();
  for (const e of recent) {
    let entry = toolMap.get(e.tool);
    if (!entry) {
      entry = { calls: 0, successes: 0, totalHits: 0, hitCalls: 0 };
      toolMap.set(e.tool, entry);
    }
    entry.calls += 1;
    if (e.hits !== undefined && e.hits > 0) {
      entry.successes += 1;
      entry.totalHits += e.hits;
      entry.hitCalls += 1;
    } else if (e.saved === true) {
      entry.successes += 1;
    }
  }
  const tools: UsageStats["tools"] = {};
  for (const [name, entry] of toolMap) {
    tools[name] = {
      calls: entry.calls,
      successes: entry.successes,
      ...(entry.hitCalls > 0
        ? { avgHits: Math.round((entry.totalHits / entry.hitCalls) * 10) / 10 }
        : {}),
    };
  }

  // Per-client breakdown.
  const clientMap = new Map<string, number>();
  for (const e of recent) {
    clientMap.set(e.client, (clientMap.get(e.client) ?? 0) + 1);
  }
  const clients = [...clientMap.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([client, calls]) => ({ client, calls }));

  return {
    days,
    totalCalls: recent.length,
    tools,
    perDay: [...perDay.entries()].map(([date, calls]) => ({ date, calls })),
    clients,
  };
}
