import type { MemoryItem } from "./types.js";

/**
 * "Is it actually capturing?" as a data structure.
 *
 * Nothing in MCP can force a model to call a tool, so capture can quietly stop
 * and nobody would find out for weeks. Both adapters answer that question, and
 * they answer it from here: the CLI draws a sparkline, memory_stats returns
 * JSON, and neither owns the arithmetic.
 */

export interface DayCount {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  count: number;
}

export interface MemoryStats {
  /** How far back `recent` and `perDay` look. */
  days: number;
  total: number;
  /** Items created within the window. */
  recent: number;
  /** One entry per day in the window, oldest first, zeroes included. */
  perDay: DayCount[];
  /**
   * Every item falls in exactly one bucket. Anything that arrived in someone
   * else's bundle counts as imported first, whoever wrote it originally --
   * otherwise a store with imports reports more items than it holds.
   */
  bySource: { capturedByAssistant: number; addedByHand: number; imported: number };
  byVisibility: { shareable: number; private: number };
  /** Descending by count; adapters slice as they see fit. */
  tools: Array<{ tool: string; count: number }>;
  tags: Array<{ tag: string; count: number }>;
}

export interface StatsOptions {
  /** Window length in days. Default 14, floored at 1. */
  days?: number;
  /** Injectable clock, so the day buckets are testable. */
  now?: number;
}

const DAY_MS = 86_400_000;

export function computeStats(items: MemoryItem[], options: StatsOptions = {}): MemoryStats {
  const days = Math.max(1, Math.floor(options.days ?? 14));
  const now = options.now ?? Date.now();
  const since = now - days * DAY_MS;

  const recent = items.filter((i) => Date.parse(i.createdAt) >= since);

  const perDay = new Map<string, number>();
  for (let d = days - 1; d >= 0; d -= 1) {
    perDay.set(new Date(now - d * DAY_MS).toISOString().slice(0, 10), 0);
  }
  for (const item of recent) {
    const day = item.createdAt.slice(0, 10);
    if (perDay.has(day)) perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }

  const imported = items.filter((i) => i.confidence === "imported");
  const own = items.filter((i) => i.confidence !== "imported");

  return {
    days,
    total: items.length,
    recent: recent.length,
    perDay: [...perDay.entries()].map(([date, count]) => ({ date, count })),
    bySource: {
      capturedByAssistant: own.filter((i) => i.source.tool !== "cli").length,
      addedByHand: own.filter((i) => i.source.tool === "cli").length,
      imported: imported.length,
    },
    byVisibility: {
      shareable: items.filter((i) => i.visibility === "shareable").length,
      private: items.filter((i) => i.visibility === "private").length,
    },
    tools: tally(items, (i) => [i.source.tool]).map(([tool, count]) => ({ tool, count })),
    tags: tally(items, (i) => i.tags).map(([tag, count]) => ({ tag, count })),
  };
}

function tally(
  items: MemoryItem[],
  key: (item: MemoryItem) => string[],
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const k of key(item)) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
