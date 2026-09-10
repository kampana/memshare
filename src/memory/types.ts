import { z } from "zod";

/**
 * Bundle schema version. Bump the minor when adding optional fields, the major
 * when an old importer could misread a new bundle.
 */
export const SCHEMA_VERSION = "0.1.0";

/** ISO-8601 timestamp. Kept permissive on purpose: any Date-parseable string. */
export const IsoDateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "must be an ISO-8601 timestamp",
  });

export const Confidence = z.enum(["stated", "inferred", "imported"]);
export type Confidence = z.infer<typeof Confidence>;

export const Visibility = z.enum(["private", "shareable"]);
export type Visibility = z.infer<typeof Visibility>;

export const Mode = z.enum(["auto", "suggest", "manual"]);
export type Mode = z.infer<typeof Mode>;

export const MemorySource = z.object({
  /** Which adapter wrote this: "claude", "chatgpt", "cli", "import", ... */
  tool: z.string().min(1),
  sessionId: z.string().optional(),
  timestamp: IsoDateTime,
});
export type MemorySource = z.infer<typeof MemorySource>;

/** Set on items that arrived in someone else's bundle. */
export const ImportProvenance = z.object({
  bundleId: z.string().min(1),
  exportedBy: z.string().min(1),
  importedAt: IsoDateTime,
  /** The id the item had in the sender's store. */
  originalId: z.string().min(1).optional(),
});
export type ImportProvenance = z.infer<typeof ImportProvenance>;

export const MemoryItem = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  source: MemorySource,
  confidence: Confidence,
  visibility: Visibility,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  expiresAt: IsoDateTime.optional(),
  importedFrom: ImportProvenance.optional(),
});
export type MemoryItem = z.infer<typeof MemoryItem>;

export const BundleMetadata = z.object({
  bundleId: z.string().min(1),
  /** A display name, deliberately not a verified identity. */
  exportedBy: z.string().min(1),
  exportedAt: IsoDateTime,
  /** Free-text note for the recipient, and who it was prepared for. */
  description: z.string().optional(),
  exportedFor: z.string().optional(),
  schemaVersion: z.string().min(1),
  /** SHA-256 over the canonicalised `items` array. */
  contentHash: z.string().length(64),
  expiresAt: IsoDateTime.optional(),
});
export type BundleMetadata = z.infer<typeof BundleMetadata>;

export const MemoryBundle = z.object({
  metadata: BundleMetadata,
  items: z.array(MemoryItem),
});
export type MemoryBundle = z.infer<typeof MemoryBundle>;

export const Config = z.object({
  displayName: z.string().min(1).default("anonymous"),
  mode: Mode.default("suggest"),
  defaultVisibility: Visibility.default("private"),
  autoRedactPII: z.boolean().default(true),
  /** Informational: the live location always comes from resolveMemoryDir(). */
  memoryDir: z.string().default("~/.memshare"),
});
export type Config = z.infer<typeof Config>;

export const DEFAULT_CONFIG: Config = {
  displayName: "anonymous",
  mode: "suggest",
  defaultVisibility: "private",
  autoRedactPII: true,
  memoryDir: "~/.memshare",
};

/** A pending item proposed by an assistant in "suggest" mode. */
export const Suggestion = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  source: MemorySource,
  suggestedAt: IsoDateTime,
});
export type Suggestion = z.infer<typeof Suggestion>;

export const SuggestionFile = z.object({
  suggestions: z.array(Suggestion).default([]),
});
export type SuggestionFile = z.infer<typeof SuggestionFile>;
