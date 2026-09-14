import { describe, expect, it } from "vitest";

import { computeStats } from "../src/memory/stats.js";
import type { Confidence, MemoryItem, Visibility } from "../src/memory/types.js";

/**
 * `memshare stats` and memory_stats both answer "is it actually capturing?".
 * They render differently -- a sparkline and JSON -- but the arithmetic is
 * here, once, so the two ends cannot disagree.
 */

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-14T12:00:00.000Z");

function item(overrides: Partial<MemoryItem> & { createdAt?: string } = {}): MemoryItem {
  const createdAt = overrides.createdAt ?? new Date(NOW).toISOString();
  return {
    id: `id-${Math.random()}`,
    content: "something",
    tags: [],
    source: { tool: "cli", timestamp: createdAt },
    confidence: "stated" as Confidence,
    visibility: "private" as Visibility,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe("computeStats", () => {
  it("answers on an empty store", () => {
    const stats = computeStats([], { now: NOW });
    expect(stats.total).toBe(0);
    expect(stats.recent).toBe(0);
    expect(stats.perDay).toHaveLength(14);
    expect(stats.tools).toEqual([]);
    expect(stats.tags).toEqual([]);
  });

  it("defaults to a 14-day window and floors it at one day", () => {
    expect(computeStats([], { now: NOW }).days).toBe(14);
    expect(computeStats([], { now: NOW, days: 0 }).days).toBe(1);
    expect(computeStats([], { now: NOW, days: -5 }).days).toBe(1);
  });

  it("buckets by UTC day, oldest first, keeping the empty days", () => {
    const stats = computeStats(
      [
        item({ createdAt: new Date(NOW).toISOString() }),
        item({ createdAt: new Date(NOW).toISOString() }),
        item({ createdAt: new Date(NOW - 2 * DAY).toISOString() }),
      ],
      { now: NOW, days: 3 },
    );

    expect(stats.perDay).toEqual([
      { date: "2026-09-12", count: 1 },
      { date: "2026-09-13", count: 0 },
      { date: "2026-09-14", count: 2 },
    ]);
    expect(stats.recent).toBe(3);
  });

  it("counts older items in the total but not as recent", () => {
    const stats = computeStats(
      [item({ createdAt: new Date(NOW - 40 * DAY).toISOString() }), item()],
      { now: NOW, days: 14 },
    );
    expect(stats.total).toBe(2);
    expect(stats.recent).toBe(1);
  });

  it("puts every item in exactly one source bucket", () => {
    const items = [
      item({ source: { tool: "claude-code", timestamp: new Date(NOW).toISOString() } }),
      item({ source: { tool: "cursor-vscode", timestamp: new Date(NOW).toISOString() } }),
      item(),
      // Imported items keep the sender's tool; they must not also be counted
      // as captured, which used to make "added by hand" go negative.
      item({
        confidence: "imported",
        source: { tool: "claude-code", timestamp: new Date(NOW).toISOString() },
      }),
    ];
    const { bySource, total } = computeStats(items, { now: NOW });

    expect(bySource).toEqual({ capturedByAssistant: 2, addedByHand: 1, imported: 1 });
    expect(bySource.capturedByAssistant + bySource.addedByHand + bySource.imported).toBe(total);
  });

  it("splits visibility, and the two halves add up", () => {
    const items = [
      item({ visibility: "shareable" }),
      item({ visibility: "shareable" }),
      item({ visibility: "private" }),
    ];
    const { byVisibility, total } = computeStats(items, { now: NOW });
    expect(byVisibility).toEqual({ shareable: 2, private: 1 });
    expect(byVisibility.shareable + byVisibility.private).toBe(total);
  });

  it("ranks tools and tags by count, breaking ties by name", () => {
    const items = [
      item({ tags: ["auth", "deploy"], source: { tool: "claude-code", timestamp: "x" } }),
      item({ tags: ["auth"], source: { tool: "claude-code", timestamp: "x" } }),
      item({ tags: ["zzz"], source: { tool: "cursor-vscode", timestamp: "x" } }),
      item({ tags: ["deploy"], source: { tool: "cursor-vscode", timestamp: "x" } }),
    ];
    const stats = computeStats(items, { now: NOW });

    expect(stats.tools).toEqual([
      { tool: "claude-code", count: 2 },
      { tool: "cursor-vscode", count: 2 },
    ]);
    expect(stats.tags).toEqual([
      { tag: "auth", count: 2 },
      { tag: "deploy", count: 2 },
      { tag: "zzz", count: 1 },
    ]);
  });
});
