import { scanForPII, type PiiFinding } from "../memory/redact.js";
import { contentKey, isExpired, type MemoryStore } from "../memory/store.js";
import type {
  ImportProvenance,
  MemoryBundle,
  MemoryItem,
  Visibility,
} from "../memory/types.js";

export type EntryStatus = "new" | "duplicate" | "expired";

export interface ImportEntry {
  /** The item exactly as it arrived in the bundle. */
  item: MemoryItem;
  status: EntryStatus;
  /** Set when `status` is "duplicate": the local item that already says this. */
  existingId?: string;
  /** Anything PII-shaped the sender let through. Shown, never auto-dropped. */
  findings: PiiFinding[];
}

export interface ImportPlan {
  bundle: MemoryBundle;
  entries: ImportEntry[];
  counts: { total: number; new: number; duplicate: number; expired: number };
}

/**
 * Works out what importing would do -- without touching the store. `memshare
 * preview` shows exactly this, and `memshare import` acts on the same plan.
 */
export async function planImport(
  store: MemoryStore,
  bundle: MemoryBundle,
): Promise<ImportPlan> {
  const existing = await store.all();
  const byKey = new Map<string, MemoryItem>();
  for (const item of existing) {
    const key = contentKey(item.content);
    if (!byKey.has(key)) byKey.set(key, item);
  }

  const entries: ImportEntry[] = bundle.items.map((item) => {
    if (isExpired(item)) {
      return { item, status: "expired" as const, findings: scanForPII(item.content) };
    }
    const match = byKey.get(contentKey(item.content));
    return {
      item,
      status: match ? ("duplicate" as const) : ("new" as const),
      ...(match ? { existingId: match.id } : {}),
      findings: scanForPII(item.content),
    };
  });

  return {
    bundle,
    entries,
    counts: {
      total: entries.length,
      new: entries.filter((e) => e.status === "new").length,
      duplicate: entries.filter((e) => e.status === "duplicate").length,
      expired: entries.filter((e) => e.status === "expired").length,
    },
  };
}

export interface ApplyOptions {
  /** Ids (from the bundle) the user accepted. */
  acceptedIds: string[];
  /**
   * How accepted items are stored locally. Private by default: receiving
   * something is not consent to pass it on.
   */
  visibility?: Visibility;
  /** Extra tags to attach, e.g. `from-alice`. */
  addTags?: string[];
}

export interface ApplyResult {
  imported: MemoryItem[];
  /** Accepted ids that were not in the bundle, if any. */
  unknown: string[];
}

/**
 * Writes the accepted items into the local store as fresh records. Nothing is
 * ever overwritten: an accepted duplicate becomes a second item, because the
 * sender's phrasing is evidence in its own right.
 */
export async function applyImport(
  store: MemoryStore,
  plan: ImportPlan,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const accepted = new Set(options.acceptedIds);
  const byId = new Map(plan.entries.map((e) => [e.item.id, e]));
  const importedAt = new Date().toISOString();

  const imported: MemoryItem[] = [];
  for (const id of accepted) {
    const entry = byId.get(id);
    if (!entry) continue;

    const provenance: ImportProvenance = {
      bundleId: plan.bundle.metadata.bundleId,
      exportedBy: plan.bundle.metadata.exportedBy,
      importedAt,
      originalId: entry.item.id,
    };

    // A bundle that expires in 30 days should not hand over memories that
    // live forever. The item keeps whichever deadline comes first.
    const expiresAt = earliestExpiry(entry.item.expiresAt, plan.bundle.metadata.expiresAt);

    const saved = await store.add({
      content: entry.item.content,
      tags: [...entry.item.tags, ...(options.addTags ?? [])],
      visibility: options.visibility ?? "private",
      confidence: "imported",
      source: entry.item.source,
      ...(expiresAt ? { expiresAt } : {}),
      importedFrom: provenance,
    });
    imported.push(saved);
  }

  const unknown = options.acceptedIds.filter((id) => !byId.has(id));
  return { imported, unknown };
}

/**
 * The sooner of two optional deadlines. Unparseable values are ignored rather
 * than treated as "expires now", so a malformed date cannot silently destroy
 * a memory the moment it lands.
 */
export function earliestExpiry(...candidates: Array<string | undefined>): string | undefined {
  let best: { iso: string; at: number } | undefined;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const at = Date.parse(candidate);
    if (Number.isNaN(at)) continue;
    if (!best || at < best.at) best = { iso: candidate, at };
  }
  return best?.iso;
}

/** A slug safe to use as a tag, e.g. `from-alice`. */
export function senderTag(exportedBy: string): string {
  const slug = exportedBy
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "from-import" : `from-${slug}`;
}
