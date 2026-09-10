import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../src/memory/store.js";
import {
  bundleFileName,
  canonicalize,
  computeContentHash,
  readBundleFile,
  validateBundle,
  writeBundleFile,
} from "../src/sharing/bundle.js";
import { buildExportBundle, selectForExport } from "../src/sharing/export.js";

let dir: string;
let store: MemoryStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "memshare-export-"));
  store = new MemoryStore(dir);
  await store.init({ displayName: "alice" });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** The three items from the spec's Test 1. */
async function seed(): Promise<void> {
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
}

describe("selectForExport", () => {
  it("includes shareable items matching the tags and holds back the private one", async () => {
    await seed();
    const selection = await selectForExport(store, { tags: ["project-x", "preferences"] });

    expect(selection.included.map((c) => c.item.content).sort()).toEqual([
      "I prefer TypeScript over JavaScript",
      "Project X uses PostgreSQL",
    ]);
    expect(selection.included.some((c) => c.item.content.includes("salary"))).toBe(false);
  });

  it("never exports a private item by default, even when its tags match", async () => {
    await seed();
    const selection = await selectForExport(store, { tags: ["personal"] });
    expect(selection.included).toHaveLength(0);
    expect(selection.skipped.map((s) => s.reason)).toEqual(["private"]);
  });

  it("exports a private item only when explicitly asked", async () => {
    await seed();
    const selection = await selectForExport(store, {
      tags: ["personal"],
      includePrivate: true,
      scanForPii: false,
    });
    expect(selection.included).toHaveLength(1);
  });

  it("blocks a shareable item that contains PII", async () => {
    await store.add({
      content: "Contact me at alice@email.com or 054-1234567",
      tags: ["contact"],
      visibility: "shareable",
    });
    const selection = await selectForExport(store, { tags: ["contact"] });

    expect(selection.included).toHaveLength(0);
    expect(selection.blocked).toHaveLength(1);
    expect(selection.blocked[0]!.findings.map((f) => f.category).sort()).toEqual([
      "email",
      "phone",
    ]);
    expect(selection.blocked[0]!.redacted.content).not.toContain("alice@email.com");
  });

  it("can be told to skip the PII scan", async () => {
    await store.add({
      content: "Contact me at alice@email.com",
      tags: ["contact"],
      visibility: "shareable",
    });
    const selection = await selectForExport(store, { tags: ["contact"], scanForPii: false });
    expect(selection.blocked).toHaveLength(0);
    expect(selection.included).toHaveLength(1);
  });

  it("leaves out expired items", async () => {
    await store.add({
      content: "short-lived fact",
      tags: ["temp"],
      visibility: "shareable",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const selection = await selectForExport(store, { tags: ["temp"] });
    expect(selection.included).toHaveLength(0);
    expect(selection.skipped[0]!.reason).toBe("expired");
  });

  it("exports everything shareable when no tags are given", async () => {
    await seed();
    const selection = await selectForExport(store, {});
    expect(selection.included).toHaveLength(2);
  });

  it("filters by originating tool", async () => {
    await store.add({ content: "from gpt", visibility: "shareable", source: { tool: "chatgpt" } });
    await store.add({ content: "from claude", visibility: "shareable", source: { tool: "claude" } });
    const selection = await selectForExport(store, { tool: "chatgpt" });
    expect(selection.included.map((c) => c.item.content)).toEqual(["from gpt"]);
  });
});

describe("bundle", () => {
  it("hashes items independently of key order", () => {
    const a = { z: 1, a: { c: 3, b: [1, 2] } };
    const b = { a: { b: [1, 2], c: 3 }, z: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("carries metadata the recipient needs", async () => {
    await seed();
    const selection = await selectForExport(store, { tags: ["project-x"] });
    const bundle = buildExportBundle(
      selection.included.map((c) => c.item),
      { exportedBy: "alice", exportedFor: "bob", expiresAt: "2030-01-01T00:00:00.000Z" },
    );

    expect(bundle.metadata.exportedBy).toBe("alice");
    expect(bundle.metadata.exportedFor).toBe("bob");
    expect(bundle.metadata.schemaVersion).toBe("0.1.0");
    expect(bundle.metadata.contentHash).toHaveLength(64);
    expect(bundle.items).toHaveLength(1);
  });

  it("names the file after the bundle id", async () => {
    const bundle = buildExportBundle([], { exportedBy: "alice" });
    expect(bundleFileName(bundle)).toMatch(/^bundle-[0-9a-f]{8}\.memshare\.json$/);
  });

  it("round-trips through a file", async () => {
    await seed();
    const selection = await selectForExport(store, {});
    const bundle = buildExportBundle(
      selection.included.map((c) => c.item),
      { exportedBy: "alice" },
    );
    const file = await writeBundleFile(bundle, store.bundlesDir);
    expect(path.basename(file)).toBe(bundleFileName(bundle));

    const result = await readBundleFile(file);
    expect(result.ok).toBe(true);
    expect(result.bundle!.items).toHaveLength(2);
  });
});

describe("validateBundle", () => {
  const goodBundle = () => buildExportBundle([], { exportedBy: "alice" });

  it("rejects a tampered bundle", async () => {
    await seed();
    const selection = await selectForExport(store, {});
    const bundle = buildExportBundle(
      selection.included.map((c) => c.item),
      { exportedBy: "alice" },
    );
    bundle.items[0]!.content = "Project X uses MongoDB, actually";

    const result = validateBundle(bundle);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/hash mismatch/i);
  });

  it("rejects an expired bundle", () => {
    const bundle = buildExportBundle([], {
      exportedBy: "alice",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const result = validateBundle(bundle);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/expired/i);
  });

  it("rejects a bundle from a newer major schema", () => {
    const bundle = goodBundle();
    bundle.metadata.schemaVersion = "1.0.0";
    bundle.metadata.contentHash = computeContentHash(bundle.items);
    const result = validateBundle(bundle);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/schema/i);
  });

  it("rejects something that is not a bundle at all", () => {
    expect(validateBundle({ hello: "world" }).ok).toBe(false);
    expect(validateBundle(null).ok).toBe(false);
  });

  it("reports a missing file instead of throwing", async () => {
    const result = await readBundleFile(path.join(dir, "nope.json"));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/No such file/);
  });

  it("reports invalid JSON instead of throwing", async () => {
    const file = path.join(dir, "broken.memshare.json");
    await fs.writeFile(file, "{ not json", "utf8");
    const result = await readBundleFile(file);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/not valid JSON/);
  });

  it("warns, but accepts, an empty bundle", () => {
    const result = validateBundle(goodBundle());
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/no items/i);
  });
});
