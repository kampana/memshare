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
      "memory_get",
      "memory_import",
      "memory_list_tags",
      "memory_set",
      "memory_set_visibility",
      "memory_suggest",
    ]);
  });

  it("requires a visibility decision on every save", async () => {
    const { tools } = await client.listTools();
    const set = tools.find((t) => t.name === "memory_set")!;
    expect((set.inputSchema as { required?: string[] }).required).toContain("visibility");
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
