import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MemoryStore,
  contentKey,
  parseDuration,
  parseTagList,
  isExpired,
} from "../src/memory/store.js";

let dir: string;
let store: MemoryStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "memshare-store-"));
  store = new MemoryStore(dir);
  await store.init({ displayName: "alice" });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("init", () => {
  it("creates the directory layout and a config file", async () => {
    expect(store.exists()).toBe(true);
    const config = await store.readConfig();
    expect(config.displayName).toBe("alice");
    expect(config.mode).toBe("auto"); // capture is automatic; sharing never is
    expect(config.defaultVisibility).toBe("private");
    expect(config.autoRedactPII).toBe(true);
    await expect(fs.stat(path.join(dir, "memories"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(dir, "bundles"))).resolves.toBeTruthy();
  });

  it("is safe to run twice and keeps existing settings", async () => {
    await store.init({ mode: "auto" });
    const config = await store.init();
    expect(config.displayName).toBe("alice");
    expect(config.mode).toBe("auto");
  });
});

describe("add", () => {
  it("stores one file per item and defaults to private", async () => {
    const item = await store.add({ content: "Project X uses PostgreSQL", tags: ["project-x"] });
    expect(item.visibility).toBe("private");
    expect(item.confidence).toBe("stated");
    expect(item.source.tool).toBe("cli");

    const onDisk = JSON.parse(
      await fs.readFile(path.join(dir, "memories", `mem_${item.id}.json`), "utf8"),
    );
    expect(onDisk.content).toBe("Project X uses PostgreSQL");
  });

  it("lowercases and dedupes tags", async () => {
    const item = await store.add({ content: "x", tags: [" Auth ", "auth", "AUTH", ""] });
    expect(item.tags).toEqual(["auth"]);
  });

  it("honours the configured default visibility", async () => {
    await store.init({ defaultVisibility: "shareable" });
    const item = await store.add({ content: "team prefers trunk-based dev" });
    expect(item.visibility).toBe("shareable");
  });
});

describe("list", () => {
  beforeEach(async () => {
    await store.add({
      content: "I prefer TypeScript over JavaScript",
      tags: ["preferences"],
      visibility: "shareable",
    });
    await store.add({
      content: "Project X uses PostgreSQL",
      tags: ["project-x", "db"],
      visibility: "shareable",
    });
    await store.add({
      content: "My salary is 50000",
      tags: ["personal", "financial"],
      visibility: "private",
    });
  });

  it("returns everything by default", async () => {
    expect(await store.list()).toHaveLength(3);
  });

  it("filters by tag", async () => {
    const items = await store.list({ tags: ["project-x"] });
    expect(items).toHaveLength(1);
    expect(items[0]!.content).toBe("Project X uses PostgreSQL");
  });

  it("matches any of several tags", async () => {
    expect(await store.list({ tags: ["project-x", "preferences"] })).toHaveLength(2);
  });

  it("filters by visibility", async () => {
    expect(await store.list({ visibility: "shareable" })).toHaveLength(2);
    expect(await store.list({ visibility: "private" })).toHaveLength(1);
  });

  it("matches free text in content and tags", async () => {
    expect(await store.list({ query: "postgres" })).toHaveLength(1);
    expect(await store.list({ query: "financial" })).toHaveLength(1);
  });

  it("applies the limit", async () => {
    expect(await store.list({ limit: 2 })).toHaveLength(2);
  });

  it("hides expired items unless asked", async () => {
    await store.add({
      content: "temporary note",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await store.list({ query: "temporary" })).toHaveLength(0);
    expect(await store.list({ query: "temporary", includeExpired: true })).toHaveLength(1);
  });
});

describe("update, remove and prune", () => {
  it("updates content and bumps updatedAt", async () => {
    const item = await store.add({ content: "old" });
    await new Promise((r) => setTimeout(r, 5));
    const updated = await store.update(item.id, { content: "new", visibility: "shareable" });
    expect(updated?.content).toBe("new");
    expect(updated?.visibility).toBe("shareable");
    expect(updated?.createdAt).toBe(item.createdAt);
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(item.updatedAt));
  });

  it("reports a miss instead of throwing", async () => {
    expect(await store.update("nope", { content: "x" })).toBeUndefined();
    expect(await store.remove("nope")).toBe(false);
    expect(await store.get("nope")).toBeUndefined();
  });

  it("prunes only what has expired", async () => {
    await store.add({ content: "keep" });
    await store.add({ content: "drop", expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await store.pruneExpired()).toBe(1);
    expect(await store.all()).toHaveLength(1);
  });
});

describe("tags and resilience", () => {
  it("lists unique sorted tags", async () => {
    await store.add({ content: "a", tags: ["zeta", "alpha"] });
    await store.add({ content: "b", tags: ["alpha", "mid"] });
    expect(await store.listTags()).toEqual(["alpha", "mid", "zeta"]);
  });

  it("skips a corrupt file instead of failing the whole read", async () => {
    await store.add({ content: "good" });
    await fs.writeFile(path.join(dir, "memories", "mem_broken.json"), "{ not json", "utf8");
    const items = await store.all();
    expect(items).toHaveLength(1);
    expect(items[0]!.content).toBe("good");
  });

  it("returns an empty list when nothing has been stored yet", async () => {
    const empty = new MemoryStore(path.join(dir, "unused"));
    expect(await empty.all()).toEqual([]);
    expect(await empty.listTags()).toEqual([]);
  });
});

describe("suggestions", () => {
  it("queues suggestions without saving them", async () => {
    const added = await store.addSuggestions([{ content: "Team chose Postgres", tags: ["db"] }]);
    expect(added).toHaveLength(1);
    expect(await store.all()).toHaveLength(0);
    expect(await store.readSuggestions()).toHaveLength(1);
  });

  it("does not re-propose something already pending or already saved", async () => {
    await store.addSuggestions([{ content: "Team chose Postgres" }]);
    expect(await store.addSuggestions([{ content: "  team CHOSE postgres " }])).toHaveLength(0);

    await store.add({ content: "Auth uses JWT" });
    expect(await store.addSuggestions([{ content: "Auth uses JWT" }])).toHaveLength(0);
  });

  it("removes reviewed suggestions", async () => {
    const [first] = await store.addSuggestions([{ content: "one" }, { content: "two" }]);
    await store.removeSuggestions([first!.id]);
    const left = await store.readSuggestions();
    expect(left).toHaveLength(1);
    expect(left[0]!.content).toBe("two");
  });
});

describe("helpers", () => {
  it("treats whitespace and case as the same memory", () => {
    expect(contentKey("Auth  uses JWT")).toBe(contentKey("auth uses jwt"));
    expect(contentKey("a")).not.toBe(contentKey("b"));
  });

  it("parses repeated and comma-joined tag flags", () => {
    expect(parseTagList(["project-x,auth", "DB"])).toEqual(["project-x", "auth", "db"]);
    expect(parseTagList(undefined)).toEqual([]);
  });

  it("turns durations into absolute timestamps", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    expect(parseDuration("7d", from)).toBe("2026-01-08T00:00:00.000Z");
    expect(parseDuration("12h", from)).toBe("2026-01-01T12:00:00.000Z");
    expect(parseDuration("2026-03-01T00:00:00.000Z", from)).toBe("2026-03-01T00:00:00.000Z");
    expect(() => parseDuration("soon")).toThrow(/duration/);
  });

  it("knows when an item has expired", () => {
    const base = {
      id: "1",
      content: "x",
      tags: [],
      source: { tool: "cli", timestamp: new Date().toISOString() },
      confidence: "stated" as const,
      visibility: "private" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(isExpired(base)).toBe(false);
    expect(isExpired({ ...base, expiresAt: new Date(Date.now() - 1).toISOString() })).toBe(true);
    expect(isExpired({ ...base, expiresAt: new Date(Date.now() + 60_000).toISOString() })).toBe(
      false,
    );
  });
});
