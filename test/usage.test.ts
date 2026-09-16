import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeUsageStats,
  logUsage,
  readUsageLog,
  usageLogPath,
  type UsageEvent,
} from "../src/memory/usage.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-16T12:00:00.000Z");

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    tool: "memory_get",
    ts: new Date(NOW).toISOString(),
    client: "claude-code",
    ...overrides,
  };
}

describe("usage log I/O", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memshare-usage-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads an empty result when the file does not exist", async () => {
    expect(await readUsageLog(tmpDir)).toEqual([]);
  });

  it("appends and reads events", async () => {
    await logUsage(tmpDir, event({ tool: "memory_get", hits: 5 }));
    await logUsage(tmpDir, event({ tool: "memory_set", saved: true }));
    const events = await readUsageLog(tmpDir);
    expect(events).toHaveLength(2);
    expect(events[0]!.tool).toBe("memory_get");
    expect(events[0]!.hits).toBe(5);
    expect(events[1]!.tool).toBe("memory_set");
    expect(events[1]!.saved).toBe(true);
  });

  it("skips malformed lines", async () => {
    const logFile = usageLogPath(tmpDir);
    await fs.writeFile(logFile, '{"tool":"memory_get","ts":"x","client":"c","hits":1}\ngarbage\n{"tool":"memory_set","ts":"x","client":"c","saved":true}\n');
    const events = await readUsageLog(tmpDir);
    expect(events).toHaveLength(2);
  });
});

describe("computeUsageStats", () => {
  it("answers on an empty log", () => {
    const stats = computeUsageStats([], { now: NOW });
    expect(stats.totalCalls).toBe(0);
    expect(stats.tools).toEqual({});
    expect(stats.perDay).toHaveLength(14);
    expect(stats.clients).toEqual([]);
  });

  it("windows to the requested number of days", () => {
    const events = [
      event({ ts: new Date(NOW).toISOString() }),
      event({ ts: new Date(NOW - 20 * DAY).toISOString() }),
    ];
    const stats = computeUsageStats(events, { now: NOW, days: 14 });
    expect(stats.totalCalls).toBe(1); // Only the recent one
    expect(stats.perDay).toHaveLength(14);
  });

  it("counts memory_get successes when hits > 0", () => {
    const events = [
      event({ tool: "memory_get", hits: 5 }),
      event({ tool: "memory_get", hits: 0 }),
      event({ tool: "memory_get", hits: 3 }),
    ];
    const stats = computeUsageStats(events, { now: NOW });
    expect(stats.tools.memory_get).toEqual({
      calls: 3,
      successes: 2,
      avgHits: 4, // (5+3)/2
    });
  });

  it("counts memory_set successes when saved is true", () => {
    const events = [
      event({ tool: "memory_set", saved: true }),
      event({ tool: "memory_set", saved: false }),
      event({ tool: "memory_set", saved: true }),
    ];
    const stats = computeUsageStats(events, { now: NOW });
    expect(stats.tools.memory_set).toEqual({
      calls: 3,
      successes: 2,
    });
  });

  it("buckets calls per day with zeroes for quiet days", () => {
    const events = [
      event({ ts: new Date(NOW).toISOString() }),
      event({ ts: new Date(NOW).toISOString() }),
      event({ ts: new Date(NOW - 2 * DAY).toISOString() }),
    ];
    const stats = computeUsageStats(events, { now: NOW, days: 3 });
    expect(stats.perDay).toEqual([
      { date: "2026-09-14", calls: 1 },
      { date: "2026-09-15", calls: 0 },
      { date: "2026-09-16", calls: 2 },
    ]);
  });

  it("ranks clients by call count", () => {
    const events = [
      event({ client: "claude-code" }),
      event({ client: "claude-code" }),
      event({ client: "cursor-vscode" }),
    ];
    const stats = computeUsageStats(events, { now: NOW });
    expect(stats.clients).toEqual([
      { client: "claude-code", calls: 2 },
      { client: "cursor-vscode", calls: 1 },
    ]);
  });

  it("floors days at 1", () => {
    expect(computeUsageStats([], { now: NOW, days: 0 }).days).toBe(1);
    expect(computeUsageStats([], { now: NOW, days: -5 }).days).toBe(1);
  });
});
