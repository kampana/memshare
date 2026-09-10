import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../src/memory/store.js";
import type { MemoryBundle } from "../src/memory/types.js";
import { readBundleFile, writeBundleFile } from "../src/sharing/bundle.js";
import { buildExportBundle, selectForExport } from "../src/sharing/export.js";
import { applyImport, planImport, senderTag } from "../src/sharing/import.js";

let aliceDir: string;
let bobDir: string;
let alice: MemoryStore;
let bob: MemoryStore;

beforeEach(async () => {
  aliceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memshare-alice-"));
  bobDir = await fs.mkdtemp(path.join(os.tmpdir(), "memshare-bob-"));
  alice = new MemoryStore(aliceDir);
  bob = new MemoryStore(bobDir);
  await alice.init({ displayName: "alice" });
  await bob.init({ displayName: "bob" });
});

afterEach(async () => {
  await fs.rm(aliceDir, { recursive: true, force: true });
  await fs.rm(bobDir, { recursive: true, force: true });
});

/** Alice shares two project facts, the way the CLI would. */
async function aliceExports(): Promise<MemoryBundle> {
  await alice.add({
    content: "Project X uses PostgreSQL",
    tags: ["project-x", "db"],
    visibility: "shareable",
  });
  await alice.add({
    content: "Auth service uses JWT with 15min refresh",
    tags: ["project-x", "auth"],
    visibility: "shareable",
  });
  const selection = await selectForExport(alice, { tags: ["project-x"] });
  return buildExportBundle(
    selection.included.map((c) => c.item),
    { exportedBy: "alice", exportedFor: "bob" },
  );
}

describe("planImport", () => {
  it("marks everything new for an empty store", async () => {
    const plan = await planImport(bob, await aliceExports());
    expect(plan.counts).toMatchObject({ total: 2, new: 2, duplicate: 0, expired: 0 });
  });

  it("marks items bob already has as duplicates", async () => {
    const bundle = await aliceExports();
    await bob.add({ content: "project x uses postgresql" });

    const plan = await planImport(bob, bundle);
    expect(plan.counts.duplicate).toBe(1);
    expect(plan.counts.new).toBe(1);
    const dup = plan.entries.find((e) => e.status === "duplicate");
    expect(dup?.existingId).toBeTruthy();
  });

  it("flags an expired item in the bundle", async () => {
    await alice.add({
      content: "temporary access token rotation date",
      tags: ["project-x"],
      visibility: "shareable",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const selection = await selectForExport(alice, { tags: ["project-x"], scanForPii: false });
    const bundle = buildExportBundle(
      [
        ...selection.included.map((c) => c.item),
        {
          ...(await alice.all())[0]!,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        },
      ],
      { exportedBy: "alice" },
    );

    const plan = await planImport(bob, bundle);
    expect(plan.counts.expired).toBeGreaterThan(0);
  });

  it("surfaces PII the sender chose to include", async () => {
    await alice.add({
      content: "Alice can be reached at alice@email.com",
      tags: ["contact"],
      visibility: "shareable",
    });
    const items = await alice.list({ tags: ["contact"] });
    const bundle = buildExportBundle(items, { exportedBy: "alice" });
    const plan = await planImport(bob, bundle);
    expect(plan.entries[0]!.findings.map((f) => f.category)).toContain("email");
  });

  it("changes nothing in the store", async () => {
    await planImport(bob, await aliceExports());
    expect(await bob.all()).toHaveLength(0);
  });
});

describe("applyImport", () => {
  it("saves only what was accepted", async () => {
    const plan = await planImport(bob, await aliceExports());
    const first = plan.entries[0]!.item.id;

    const result = await applyImport(bob, plan, { acceptedIds: [first] });
    expect(result.imported).toHaveLength(1);
    expect(await bob.all()).toHaveLength(1);
  });

  it("marks imported items and records who sent them", async () => {
    const bundle = await aliceExports();
    const plan = await planImport(bob, bundle);
    await applyImport(bob, plan, { acceptedIds: plan.entries.map((e) => e.item.id) });

    const stored = await bob.all();
    expect(stored).toHaveLength(2);
    for (const item of stored) {
      expect(item.confidence).toBe("imported");
      expect(item.importedFrom?.exportedBy).toBe("alice");
      expect(item.importedFrom?.bundleId).toBe(bundle.metadata.bundleId);
    }
  });

  it("stores imported items as private, so re-sharing is a fresh decision", async () => {
    const plan = await planImport(bob, await aliceExports());
    await applyImport(bob, plan, { acceptedIds: plan.entries.map((e) => e.item.id) });
    expect((await bob.all()).every((i) => i.visibility === "private")).toBe(true);
  });

  it("gives each imported item a new local id", async () => {
    const plan = await planImport(bob, await aliceExports());
    const originals = plan.entries.map((e) => e.item.id);
    const result = await applyImport(bob, plan, { acceptedIds: originals });
    for (const item of result.imported) {
      expect(originals).not.toContain(item.id);
      expect(originals).toContain(item.importedFrom!.originalId);
    }
  });

  it("never overwrites what bob already had", async () => {
    const bundle = await aliceExports();
    const mine = await bob.add({ content: "Project X uses PostgreSQL", tags: ["mine"] });

    const plan = await planImport(bob, bundle);
    await applyImport(bob, plan, { acceptedIds: plan.entries.map((e) => e.item.id) });

    const untouched = await bob.get(mine.id);
    expect(untouched?.tags).toEqual(["mine"]);
    expect(untouched?.confidence).toBe("stated");
    expect(await bob.all()).toHaveLength(3);
  });

  it("can tag accepted items with the sender", async () => {
    const plan = await planImport(bob, await aliceExports());
    await applyImport(bob, plan, {
      acceptedIds: [plan.entries[0]!.item.id],
      addTags: [senderTag("Alice")],
    });
    expect((await bob.all())[0]!.tags).toContain("from-alice");
  });

  it("ignores ids that are not in the bundle", async () => {
    const plan = await planImport(bob, await aliceExports());
    const result = await applyImport(bob, plan, { acceptedIds: ["not-a-real-id"] });
    expect(result.imported).toHaveLength(0);
    expect(result.unknown).toEqual(["not-a-real-id"]);
  });
});

describe("the whole alice -> file -> bob round trip", () => {
  it("carries the memories across two independent stores", async () => {
    const bundle = await aliceExports();
    const file = await writeBundleFile(bundle, alice.bundlesDir);

    // Bob only ever sees the file.
    const validated = await readBundleFile(file);
    expect(validated.ok).toBe(true);

    const plan = await planImport(bob, validated.bundle!);
    await applyImport(bob, plan, {
      acceptedIds: plan.entries.map((e) => e.item.id),
      addTags: [senderTag(bundle.metadata.exportedBy)],
    });

    const contents = (await bob.all()).map((i) => i.content).sort();
    expect(contents).toEqual([
      "Auth service uses JWT with 15min refresh",
      "Project X uses PostgreSQL",
    ]);
    expect(await alice.all()).toHaveLength(2);
  });

  it("refuses a bundle edited in transit", async () => {
    const bundle = await aliceExports();
    const file = await writeBundleFile(bundle, alice.bundlesDir);

    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    raw.items[0].content = "Project X uses a database I control";
    await fs.writeFile(file, JSON.stringify(raw), "utf8");

    const validated = await readBundleFile(file);
    expect(validated.ok).toBe(false);
    expect(validated.errors.join(" ")).toMatch(/modified after export/i);
  });
});

describe("senderTag", () => {
  it("slugifies a display name", () => {
    expect(senderTag("Alice")).toBe("from-alice");
    expect(senderTag("Dana R. Cohen")).toBe("from-dana-r-cohen");
    expect(senderTag("!!!")).toBe("from-import");
  });
});
