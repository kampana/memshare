import { scanForPII, redact, type PiiFinding } from "../memory/redact.js";
import { isExpired, type MemoryStore } from "../memory/store.js";
import type { MemoryBundle, MemoryItem } from "../memory/types.js";
import { createBundle } from "./bundle.js";

export type SkipReason = "private" | "expired" | "no-match";

export interface ExportCandidate {
  item: MemoryItem;
  /** Empty when the item is clean. */
  findings: PiiFinding[];
  /** The same item with every finding replaced by a marker. */
  redacted: MemoryItem;
}

export interface SkippedItem {
  item: MemoryItem;
  reason: SkipReason;
}

export interface ExportSelection {
  /** Clean items, ready to go. */
  included: ExportCandidate[];
  /** Items held back because they contain PII. The user decides per item. */
  blocked: ExportCandidate[];
  /** Items that never entered the running, with the reason why. */
  skipped: SkippedItem[];
}

export interface SelectOptions {
  tags?: string[];
  /** Only items written by this adapter (`--from chatgpt`). */
  tool?: string;
  query?: string;
  /** Off by default: private means private. */
  includePrivate?: boolean;
  /** Defaults to the store's `autoRedactPII` config value. */
  scanForPii?: boolean;
}

/**
 * Works out what an export would contain, without writing anything. The CLI
 * calls this for both `--preview` and the real run, so the preview is the
 * same computation the export is -- not a separate code path that can drift.
 */
export async function selectForExport(
  store: MemoryStore,
  options: SelectOptions = {},
): Promise<ExportSelection> {
  const config = await store.readConfig();
  const scan = options.scanForPii ?? config.autoRedactPII;

  const matching = await store.list({
    ...(options.tags && options.tags.length > 0 ? { tags: options.tags } : {}),
    ...(options.tool ? { tool: options.tool } : {}),
    ...(options.query ? { query: options.query } : {}),
    includeExpired: true,
  });

  const included: ExportCandidate[] = [];
  const blocked: ExportCandidate[] = [];
  const skipped: SkippedItem[] = [];

  for (const item of matching) {
    if (isExpired(item)) {
      skipped.push({ item, reason: "expired" });
      continue;
    }
    if (item.visibility !== "shareable" && !options.includePrivate) {
      skipped.push({ item, reason: "private" });
      continue;
    }

    const candidate = inspect(item, scan);
    if (candidate.findings.length > 0) blocked.push(candidate);
    else included.push(candidate);
  }

  return { included, blocked, skipped };
}

/** Scans one item and prepares its redacted twin. */
export function inspect(item: MemoryItem, scan = true): ExportCandidate {
  if (!scan) return { item, findings: [], redacted: item };

  const inContent = scanForPII(item.content);
  const inTags = item.tags.flatMap((tag) => scanForPII(tag));
  const findings = [...inContent, ...inTags];
  if (findings.length === 0) return { item, findings: [], redacted: item };

  const redacted: MemoryItem = {
    ...item,
    content: redact(item.content).text,
    tags: item.tags.map((tag) => redact(tag).text),
  };
  return { item, findings, redacted };
}

export interface BuildOptions {
  exportedBy: string;
  description?: string;
  exportedFor?: string;
  expiresAt?: string;
}

/**
 * Assembles the bundle from whatever the user approved. Items arrive already
 * resolved -- redacted or not -- so consent is decided before this point.
 */
export function buildExportBundle(
  items: MemoryItem[],
  options: BuildOptions,
): MemoryBundle {
  return createBundle({
    items,
    exportedBy: options.exportedBy,
    ...(options.description ? { description: options.description } : {}),
    ...(options.exportedFor ? { exportedFor: options.exportedFor } : {}),
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
  });
}

export function describeSkipReason(reason: SkipReason): string {
  switch (reason) {
    case "private":
      return "marked private";
    case "expired":
      return "expired";
    case "no-match":
      return "did not match the filter";
  }
}
