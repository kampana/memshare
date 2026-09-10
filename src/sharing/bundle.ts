import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  MemoryBundle,
  SCHEMA_VERSION,
  type BundleMetadata,
  type MemoryItem,
} from "../memory/types.js";

export const BUNDLE_EXTENSION = ".memshare.json";

/**
 * Deterministic JSON: object keys sorted, no incidental whitespace. Two people
 * hashing the same items must get the same digest, whatever order their
 * JSON runtime happened to produce.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/** SHA-256 over the canonicalised items array. */
export function computeContentHash(items: MemoryItem[]): string {
  return createHash("sha256").update(canonicalize(items), "utf8").digest("hex");
}

export interface CreateBundleOptions {
  items: MemoryItem[];
  /** Display name of the sender. Not a verified identity. */
  exportedBy: string;
  description?: string;
  exportedFor?: string;
  /** Absolute ISO timestamp after which the recipient should refuse it. */
  expiresAt?: string;
}

export function createBundle(options: CreateBundleOptions): MemoryBundle {
  const items = options.items.map((item) => ({ ...item }));
  const metadata: BundleMetadata = {
    bundleId: randomUUID(),
    exportedBy: options.exportedBy,
    exportedAt: new Date().toISOString(),
    ...(options.description ? { description: options.description } : {}),
    ...(options.exportedFor ? { exportedFor: options.exportedFor } : {}),
    schemaVersion: SCHEMA_VERSION,
    contentHash: computeContentHash(items),
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
  };
  return MemoryBundle.parse({ metadata, items });
}

/** e.g. `bundle-a3f8c2d1.memshare.json` */
export function bundleFileName(bundle: MemoryBundle): string {
  const short = bundle.metadata.bundleId.replace(/-/g, "").slice(0, 8);
  return `bundle-${short}${BUNDLE_EXTENSION}`;
}

export interface ValidationResult {
  ok: boolean;
  bundle?: MemoryBundle;
  /** Problems that make the bundle unsafe to import. */
  errors: string[];
  /** Problems worth showing the user, but not disqualifying. */
  warnings: string[];
}

/** Schema, hash integrity, schema-version and expiry checks, in that order. */
export function validateBundle(raw: unknown, now: Date = new Date()): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const parsed = MemoryBundle.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const where = issue.path.length > 0 ? issue.path.join(".") : "bundle";
      errors.push(`${where}: ${issue.message}`);
    }
    return { ok: false, errors, warnings };
  }

  const bundle = parsed.data;

  const actual = computeContentHash(bundle.items);
  if (actual !== bundle.metadata.contentHash) {
    errors.push(
      `Content hash mismatch: the bundle says ${bundle.metadata.contentHash.slice(0, 12)}... ` +
        `but its items hash to ${actual.slice(0, 12)}... The file was modified after export.`,
    );
  }

  const theirMajor = majorOf(bundle.metadata.schemaVersion);
  const ourMajor = majorOf(SCHEMA_VERSION) ?? 0;
  if (theirMajor === undefined) {
    errors.push(`Unreadable schemaVersion "${bundle.metadata.schemaVersion}".`);
  } else if (theirMajor > ourMajor) {
    errors.push(
      `Bundle uses schema ${bundle.metadata.schemaVersion}, this memshare understands ` +
        `${SCHEMA_VERSION}. Upgrade with: npm install -g memshare-cli`,
    );
  } else if (bundle.metadata.schemaVersion !== SCHEMA_VERSION) {
    warnings.push(
      `Bundle was written with schema ${bundle.metadata.schemaVersion} (this is ${SCHEMA_VERSION}).`,
    );
  }

  if (bundle.metadata.expiresAt) {
    const expires = Date.parse(bundle.metadata.expiresAt);
    if (!Number.isNaN(expires) && expires <= now.getTime()) {
      errors.push(
        `This bundle expired on ${new Date(expires).toISOString()}. ` +
          `Ask ${bundle.metadata.exportedBy} for a fresh one.`,
      );
    }
  }

  if (bundle.items.length === 0) warnings.push("Bundle contains no items.");

  return { ok: errors.length === 0, bundle, errors, warnings };
}

export async function writeBundleFile(
  bundle: MemoryBundle,
  destination: string,
): Promise<string> {
  const isDirectory = await isDir(destination);
  const file = isDirectory ? path.join(destination, bundleFileName(bundle)) : destination;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
  return file;
}

/** Reads and validates a bundle file. Never throws on bad content. */
export async function readBundleFile(
  file: string,
  now: Date = new Date(),
): Promise<ValidationResult> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message =
      code === "ENOENT" ? `No such file: ${file}` : `Could not read ${file}: ${String(err)}`;
    return { ok: false, errors: [message], warnings: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      errors: [`${path.basename(file)} is not valid JSON: ${(err as Error).message}`],
      warnings: [],
    };
  }

  return validateBundle(parsed, now);
}

function majorOf(version: string): number | undefined {
  const major = Number(version.split(".")[0]);
  return Number.isInteger(major) ? major : undefined;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
