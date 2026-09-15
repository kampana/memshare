import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/mcp/server.js";
import { MemoryStore } from "../src/memory/store.js";

/**
 * These drive the real server over a real MCP transport, because the value of
 * memory_export and memory_import is in the handshake -- that a first call
 * changes nothing -- and that only shows up end to end.
 */

let dir: string;
let store: MemoryStore;
let client: Client;

/** Connects a client to a server backed by `store`. */
async function connect(target: MemoryStore): Promise<Client> {
  const server = await createServer(target);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([c.connect(clientSide), server.connect(serverSide)]);
  return c;
}

/** The text a tool call came back with. */
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await c.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
  };
  return result.content.map((p) => p.text ?? "").join("\n");
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "memshare-mcp-"));
  store = new MemoryStore(dir);
  await store.init({ displayName: "alice", mode: "auto" });
  client = await connect(store);
});

afterEach(async () => {
  await client.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("the tool surface", () => {
  it("exposes every tool an assistant needs to run the whole flow", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "memory_export",
      "memory_forget",
      "memory_get",
      "memory_import",
      "memory_list_tags",
      "memory_preview",
      "memory_set",
      "memory_set_visibility",
      "memory_stats",
      "memory_suggest",
    ]);
  });

  it("requires a visibility decision on every save", async () => {
    const { tools } = await client.listTools();
    const set = tools.find((t) => t.name === "memory_set")!;
    expect((set.inputSchema as { required?: string[] }).required).toContain("visibility");
  });

  it("marks the only destructive tool as destructive, and the read-only ones as read-only", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations ?? {}]));
    expect(byName.get("memory_forget")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    for (const name of ["memory_get", "memory_stats", "memory_list_tags", "memory_preview"]) {
      expect(byName.get(name)).toMatchObject({ readOnlyHint: true });
    }
  });

  it("tells the model not to skip a save it has already made elsewhere", async () => {
    const { tools } = await client.listTools();
    const set = tools.find((t) => t.name === "memory_set")!;
    expect(set.description).toMatch(/already (?:captured|saved) (?:in|elsewhere)/i);
    expect(set.description).toMatch(/not a reason to skip/i);
  });
});

describe("memory_forget", () => {
  it("deletes by full id and by the short id `list` prints", async () => {
    const a = await store.add({ content: "Uses pnpm, not npm", visibility: "shareable" });
    const b = await store.add({ content: "Deploys on Fridays", visibility: "private" });
    const keep = await store.add({ content: "Keep this one", visibility: "private" });

    const out = await call(client, "memory_forget", {
      ids: [a.id, b.id.replace(/-/g, "").slice(0, 8)],
    });
    expect(out).toMatch(/deleted 2 memory\(s\)/i);
    expect(out).toContain("Uses pnpm, not npm");

    const left = await store.all();
    expect(left.map((i) => i.id)).toEqual([keep.id]);
  });

  it("reports an id it could not find instead of failing the call", async () => {
    const kept = await store.add({ content: "Still here", visibility: "private" });
    const out = await call(client, "memory_forget", { ids: ["nope"] });
    expect(out).toMatch(/nothing deleted/i);
    expect(out).toMatch(/no memory matched: nope/i);
    expect(await store.all()).toHaveLength(1);
    expect((await store.all())[0]!.id).toBe(kept.id);
  });

  it("deletes the ones it found and names the ones it did not", async () => {
    const a = await store.add({ content: "Real memory", visibility: "private" });
    const out = await call(client, "memory_forget", { ids: [a.id, "ffffffff"] });
    expect(out).toMatch(/deleted 1 memory\(s\)/i);
    expect(out).toMatch(/no memory matched: ffffffff/i);
    expect(await store.all()).toHaveLength(0);
  });

  it("says only the user may ask for a deletion, because there is no undo", async () => {
    const { tools } = await client.listTools();
    const forget = tools.find((t) => t.name === "memory_forget")!;
    expect(forget.description).toMatch(/only call this when the user explicitly asks/i);
    expect(forget.description).toMatch(/never on your own initiative/i);
    expect(forget.description).toMatch(/no undo/i);
  });
});

describe("memory_get filters", () => {
  beforeEach(async () => {
    await store.add({
      content: "Team chose Postgres",
      tags: ["db"],
      visibility: "shareable",
      source: { tool: "claude-code" },
    });
    await store.add({
      content: "I dislike dark mode",
      tags: ["prefs"],
      visibility: "private",
      source: { tool: "cursor-vscode" },
    });
    await store.add({
      content: "Typed this one myself",
      tags: ["prefs"],
      visibility: "private",
      source: { tool: "cli" },
    });
  });

  it("lists by visibility", async () => {
    const out = await call(client, "memory_get", { visibility: "shareable" });
    expect(out).toContain("Team chose Postgres");
    expect(out).not.toContain("dark mode");
  });

  it("lists by the tool that wrote it", async () => {
    const out = await call(client, "memory_get", { from: "cursor-vscode" });
    expect(out).toContain("dark mode");
    expect(out).not.toContain("Team chose Postgres");
  });

  it("combines filters rather than picking one", async () => {
    const out = await call(client, "memory_get", { tags: ["prefs"], from: "cli" });
    expect(out).toContain("Typed this one myself");
    expect(out).not.toContain("dark mode");
  });

  // memory_get is how a query actually arrives -- an assistant searching by
  // topic, several words at once. It used to match the whole string as one
  // substring and so returned nothing at all.
  it("matches any word of a multi-word query", async () => {
    const out = await call(client, "memory_get", { query: "postgres redis kafka" });
    expect(out).toContain("Team chose Postgres");
  });

  it("unions the matches across the words of a query", async () => {
    const out = await call(client, "memory_get", { query: "postgres prefs" });
    expect(out).toContain("Team chose Postgres");
    expect(out).toContain("dark mode");
    expect(out).toContain("Typed this one myself");
  });

  it("still says nothing matched when no word hits", async () => {
    const out = await call(client, "memory_get", { query: "redis kafka" });
    expect(out).toContain("No memories matched.");
  });
});

describe("memory_stats", () => {
  /** The JSON a memory_stats call came back with. */
  async function stats(c: Client, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const result = (await c.callTool({ name: "memory_stats", arguments: args })) as {
      structuredContent?: Record<string, unknown>;
      content: Array<{ type: string; text?: string }>;
    };
    return (result.structuredContent ?? JSON.parse(result.content[0]!.text!)) as Record<string, any>;
  }

  it("counts the store, and splits it by where each memory came from", async () => {
    await store.add({ content: "From an assistant", source: { tool: "claude-code" }, visibility: "shareable" });
    await store.add({ content: "Typed by hand", source: { tool: "cli" }, visibility: "private" });
    await store.add({
      content: "Came from Dana",
      source: { tool: "claude-code" },
      confidence: "imported",
      visibility: "private",
    });

    const s = await stats(client);
    expect(s.total).toBe(3);
    expect(s.days).toBe(14);
    expect(s.bySource).toEqual({ capturedByAssistant: 1, addedByHand: 1, imported: 1 });
    expect(s.byVisibility).toEqual({ shareable: 1, private: 2 });
  });

  it("returns one per-day bucket for the window, oldest first", async () => {
    const s = await stats(client, { days: 3 });
    expect(s.days).toBe(3);
    expect(s.perDay).toHaveLength(3);
    expect(s.perDay[0]!.date < s.perDay[2]!.date).toBe(true);
    expect(s.perDay.at(-1)!.date).toBe(new Date().toISOString().slice(0, 10));
  });

  it("counts today's saves as recent, and shows the tools and tags behind them", async () => {
    await store.add({ content: "One", tags: ["auth"], source: { tool: "claude-code" }, visibility: "private" });
    await store.add({ content: "Two", tags: ["auth"], source: { tool: "claude-code" }, visibility: "private" });

    const s = await stats(client);
    expect(s.recent).toBe(2);
    expect(s.perDay.at(-1)!.count).toBe(2);
    expect(s.topTools[0]).toEqual({ tool: "claude-code", count: 2 });
    expect(s.topTags[0]).toEqual({ tag: "auth", count: 2 });
  });

  it("answers on an empty store rather than erroring", async () => {
    const s = await stats(client);
    expect(s.total).toBe(0);
    expect(s.recent).toBe(0);
    expect(s.topTools).toEqual([]);
    expect(s.pendingSuggestions).toBe(0);
  });

  it("counts what is still waiting in the approval queue", async () => {
    await store.addSuggestions([{ content: "Pending one" }], { tool: "claude-code" });
    expect((await stats(client)).pendingSuggestions).toBe(1);
  });
});

describe("memory_export", () => {
  beforeEach(async () => {
    await store.add({ content: "Team chose Postgres for JSONB", tags: ["px"], visibility: "shareable" });
    await store.add({ content: "Migrations run via scripts/migrate.ts", tags: ["px"], visibility: "shareable" });
    await store.add({ content: "Reach me at alice@corp.com", tags: ["px"], visibility: "shareable" });
    await store.add({ content: "My salary is 50000", tags: ["personal"], visibility: "private" });
  });

  it("writes nothing without confirmation", async () => {
    const out = await call(client, "memory_export", { tags: ["px"], for: "sam" });
    expect(out).toMatch(/nothing written yet/i);
    await expect(fs.readdir(store.bundlesDir)).resolves.toEqual([]);
  });

  it("shows what would go, and what is being held back and why", async () => {
    const out = await call(client, "memory_export", { tags: ["px"] });
    expect(out).toContain("Team chose Postgres for JSONB");
    expect(out).toMatch(/held back/i);
    expect(out).toMatch(/email address/i);
  });

  it("writes the bundle once confirmed, without the flagged item", async () => {
    await call(client, "memory_export", { tags: ["px"], for: "sam", confirmed: true });
    const files = await fs.readdir(store.bundlesDir);
    expect(files).toHaveLength(1);

    const raw = await fs.readFile(path.join(store.bundlesDir, files[0]!), "utf8");
    expect(raw).toContain("Team chose Postgres for JSONB");
    expect(raw).not.toContain("alice@corp.com");
    expect(raw).not.toContain("salary");
  });

  it("never includes a private memory, even when its tags match", async () => {
    const out = await call(client, "memory_export", { tags: ["personal"] });
    expect(out).toMatch(/nothing to export/i);
    expect(out).toMatch(/marked private/i);
  });

  it("carries the recipient and the expiry through to the bundle", async () => {
    await call(client, "memory_export", { tags: ["px"], for: "sam", expires: "30d", confirmed: true });
    const files = await fs.readdir(store.bundlesDir);
    const bundle = JSON.parse(await fs.readFile(path.join(store.bundlesDir, files[0]!), "utf8"));
    expect(bundle.metadata.exportedFor).toBe("sam");
    expect(Date.parse(bundle.metadata.expiresAt)).toBeGreaterThan(Date.now());
  });
});

describe("memory_import", () => {
  let bobDir: string;
  let bob: MemoryStore;
  let bobClient: Client;
  let bundleFile: string;

  beforeEach(async () => {
    await store.add({ content: "Team chose Postgres for JSONB", tags: ["px"], visibility: "shareable" });
    await store.add({ content: "Migrations run via scripts/migrate.ts", tags: ["px"], visibility: "shareable" });
    await call(client, "memory_export", { tags: ["px"], for: "bob", confirmed: true });
    const [file] = await fs.readdir(store.bundlesDir);
    bundleFile = path.join(store.bundlesDir, file!);

    bobDir = await fs.mkdtemp(path.join(os.tmpdir(), "memshare-bob-"));
    bob = new MemoryStore(bobDir);
    await bob.init({ displayName: "bob", mode: "auto" });
    bobClient = await connect(bob);
  });

  afterEach(async () => {
    await bobClient.close();
    await fs.rm(bobDir, { recursive: true, force: true });
  });

  it("imports nothing without confirmation", async () => {
    const out = await call(bobClient, "memory_import", { file: bundleFile });
    expect(out).toMatch(/nothing imported yet/i);
    expect(await bob.all()).toHaveLength(0);
  });

  it("names the sender and lists what arrived", async () => {
    const out = await call(bobClient, "memory_import", { file: bundleFile });
    expect(out).toContain("alice");
    expect(out).toContain("Team chose Postgres for JSONB");
  });

  it("takes everything new once confirmed, stored private and attributed", async () => {
    await call(bobClient, "memory_import", { file: bundleFile, confirmed: true });
    const stored = await bob.all();
    expect(stored).toHaveLength(2);
    for (const item of stored) {
      expect(item.visibility).toBe("private");
      expect(item.confidence).toBe("imported");
      expect(item.tags).toContain("from-alice");
    }
  });

  it("takes only the items named in accept", async () => {
    const preview = await call(bobClient, "memory_import", { file: bundleFile });
    const id = preview.match(/id: ([0-9a-f-]{36})/)![1]!;
    await call(bobClient, "memory_import", { file: bundleFile, confirmed: true, accept: [id] });
    expect(await bob.all()).toHaveLength(1);
  });

  it("flags what the recipient already knows instead of duplicating silently", async () => {
    await bob.add({ content: "Team chose Postgres for JSONB", visibility: "private" });
    const out = await call(bobClient, "memory_import", { file: bundleFile });
    expect(out).toMatch(/already known/i);
  });

  it("refuses a bundle that was edited in transit", async () => {
    const raw = JSON.parse(await fs.readFile(bundleFile, "utf8"));
    raw.items[0].content = "Team chose a database I control";
    await fs.writeFile(bundleFile, JSON.stringify(raw), "utf8");

    const out = await call(bobClient, "memory_import", { file: bundleFile });
    expect(out).toMatch(/cannot use this bundle/i);
    expect(out).toMatch(/modified after export/i);
    expect(await bob.all()).toHaveLength(0);
  });

  it("reports a missing file instead of failing the call", async () => {
    const out = await call(bobClient, "memory_import", { file: path.join(bobDir, "nope.json") });
    expect(out).toMatch(/no such file/i);
  });

  it("hands back what arrived, so the assistant can mirror it into its own memory", async () => {
    const out = await call(bobClient, "memory_import", { file: bundleFile, confirmed: true });

    // The count alone is not actionable -- the assistant needs the text.
    expect(out).toContain("Team chose Postgres for JSONB");
    expect(out).toContain("Migrations run via scripts/migrate.ts");
    expect(out).toMatch(/every save is a save here too/i);
    expect(out).toMatch(/both directions/i);
  });

  it("says nothing about mirroring when the import was a no-op", async () => {
    await call(bobClient, "memory_import", { file: bundleFile, confirmed: true });
    const again = await call(bobClient, "memory_import", { file: bundleFile, confirmed: true });
    expect(again).toMatch(/nothing new to import/i);
    expect(again).not.toMatch(/every save is a save here too/i);
  });
});

describe("memory_preview", () => {
  let bobDir: string;
  let bob: MemoryStore;
  let bobClient: Client;
  let bundleFile: string;

  beforeEach(async () => {
    await store.add({ content: "Team chose Postgres for JSONB", tags: ["px"], visibility: "shareable" });
    await store.add({ content: "Migrations run via scripts/migrate.ts", tags: ["px"], visibility: "shareable" });
    await call(client, "memory_export", {
      tags: ["px"],
      for: "bob",
      note: "the two you asked about",
      confirmed: true,
    });
    const [file] = await fs.readdir(store.bundlesDir);
    bundleFile = path.join(store.bundlesDir, file!);

    bobDir = await fs.mkdtemp(path.join(os.tmpdir(), "memshare-bob-preview-"));
    bob = new MemoryStore(bobDir);
    await bob.init({ displayName: "bob", mode: "auto" });
    bobClient = await connect(bob);
  });

  afterEach(async () => {
    await bobClient.close();
    await fs.rm(bobDir, { recursive: true, force: true });
  });

  it("shows the sender and every item, and stores none of them", async () => {
    const out = await call(bobClient, "memory_preview", { file: bundleFile });
    expect(out).toContain("alice");
    expect(out).toContain("Team chose Postgres for JSONB");
    expect(out).toContain("Migrations run via scripts/migrate.ts");
    expect(await bob.all()).toHaveLength(0);
  });

  it("passes the sender's note along", async () => {
    const out = await call(bobClient, "memory_preview", { file: bundleFile });
    expect(out).toContain("the two you asked about");
  });

  it("has no argument that could make it write", async () => {
    const { tools } = await bobClient.listTools();
    const preview = tools.find((t) => t.name === "memory_preview")!;
    const schema = preview.inputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {})).toEqual(["file"]);
  });

  it("flags what the recipient already knows, exactly as the import preview does", async () => {
    await bob.add({ content: "Team chose Postgres for JSONB", visibility: "private" });

    const preview = await call(bobClient, "memory_preview", { file: bundleFile });
    const importPreview = await call(bobClient, "memory_import", { file: bundleFile });

    expect(preview).toMatch(/already known/i);
    // One plan, one renderer: the item lines must not drift apart.
    for (const line of ["Team chose Postgres for JSONB  (already known)"]) {
      expect(preview).toContain(line);
      expect(importPreview).toContain(line);
    }
  });

  it("refuses a bundle that was edited in transit, without importing anything", async () => {
    const raw = JSON.parse(await fs.readFile(bundleFile, "utf8"));
    raw.items[0].content = "Team chose a database I control";
    await fs.writeFile(bundleFile, JSON.stringify(raw), "utf8");

    const out = await call(bobClient, "memory_preview", { file: bundleFile });
    expect(out).toMatch(/cannot use this bundle/i);
    expect(out).toMatch(/modified after export/i);
    expect(await bob.all()).toHaveLength(0);
  });

  it("reports a missing file instead of failing the call", async () => {
    const out = await call(bobClient, "memory_preview", { file: path.join(bobDir, "nope.json") });
    expect(out).toMatch(/no such file/i);
  });
});

describe("memory_set_visibility", () => {
  it("promotes by tag and leaves everything else alone", async () => {
    await store.add({ content: "Team chose Postgres", tags: ["px"], visibility: "private" });
    await store.add({ content: "My salary is 50000", tags: ["personal"], visibility: "private" });

    const out = await call(client, "memory_set_visibility", { visibility: "shareable", tags: ["px"] });
    expect(out).toMatch(/now shareable/i);

    const items = await store.all();
    expect(items.find((i) => i.tags.includes("px"))!.visibility).toBe("shareable");
    expect(items.find((i) => i.tags.includes("personal"))!.visibility).toBe("private");
  });

  it("refuses to act on everything at once", async () => {
    await store.add({ content: "something", visibility: "private" });
    const out = await call(client, "memory_set_visibility", { visibility: "shareable" });
    expect(out).toMatch(/nothing selected/i);
    expect((await store.all())[0]!.visibility).toBe("private");
  });
});

describe("memory_set in suggest mode", () => {
  it("queues rather than saving, so the consent step cannot be skipped", async () => {
    const suggestDir = await fs.mkdtemp(path.join(os.tmpdir(), "memshare-suggest-"));
    const suggestStore = new MemoryStore(suggestDir);
    await suggestStore.init({ displayName: "alice", mode: "suggest" });
    const c = await connect(suggestStore);

    const out = await call(c, "memory_set", {
      content: "Team uses trunk-based development",
      tags: ["team"],
      visibility: "shareable",
    });
    expect(out).toMatch(/queued/i);
    expect(await suggestStore.all()).toHaveLength(0);
    expect(await suggestStore.readSuggestions()).toHaveLength(1);

    await c.close();
    await fs.rm(suggestDir, { recursive: true, force: true });
  });
});
