import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  Config,
  DEFAULT_CONFIG,
  MemoryItem,
  SuggestionFile,
  type Confidence,
  type ImportProvenance,
  type MemorySource,
  type Suggestion,
  type Visibility,
} from "./types.js";

/**
 * Where the store lives. MEMSHARE_DIR wins, so a second identity can run side
 * by side on one machine -- which is also how the two-person sharing flow is
 * tested without two laptops.
 */
export function resolveMemoryDir(): string {
  const fromEnv = process.env.MEMSHARE_DIR;
  if (fromEnv && fromEnv.trim() !== "") return expandHome(fromEnv.trim());
  return path.join(os.homedir(), ".memshare");
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return path.resolve(p);
}

/** Stable identity for a memory's text, used to dedup on import. */
export function contentKey(content: string): string {
  const normalised = content.trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

export interface AddInput {
  content: string;
  tags?: string[];
  visibility?: Visibility;
  confidence?: Confidence;
  source?: Partial<MemorySource>;
  expiresAt?: string;
  id?: string;
  importedFrom?: ImportProvenance;
}

export interface ListFilter {
  /** Case-insensitive substring match against content and tags. */
  query?: string;
  /** An item matches when it carries at least one of these tags. */
  tags?: string[];
  visibility?: Visibility;
  confidence?: Confidence;
  /** Filter by the adapter that wrote the item: claude, chatgpt, cli, ... */
  tool?: string;
  limit?: number;
  /** Expired items are hidden unless this is set. */
  includeExpired?: boolean;
}

export class MemoryStore {
  readonly root: string;

  constructor(root: string = resolveMemoryDir()) {
    this.root = root;
  }

  get memoriesDir(): string {
    return path.join(this.root, "memories");
  }
  get bundlesDir(): string {
    return path.join(this.root, "bundles");
  }
  get configPath(): string {
    return path.join(this.root, "config.json");
  }
  get suggestionsPath(): string {
    return path.join(this.root, "suggestions.json");
  }

  exists(): boolean {
    return existsSync(this.configPath);
  }

  /** Creates the directory layout and a config file. Safe to re-run. */
  async init(overrides: Partial<Config> = {}): Promise<Config> {
    await fs.mkdir(this.memoriesDir, { recursive: true });
    await fs.mkdir(this.bundlesDir, { recursive: true });
    const existing = this.exists() ? await this.readConfig() : DEFAULT_CONFIG;
    const config = Config.parse({ ...existing, ...overrides, memoryDir: this.root });
    await this.writeConfig(config);
    return config;
  }

  async readConfig(): Promise<Config> {
    try {
      const raw = await fs.readFile(this.configPath, "utf8");
      return Config.parse(JSON.parse(raw));
    } catch (err) {
      if (isNotFound(err)) return { ...DEFAULT_CONFIG, memoryDir: this.root };
      throw new Error(`Could not read ${this.configPath}: ${describe(err)}`);
    }
  }

  async writeConfig(config: Config): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await writeJsonAtomic(this.configPath, config);
  }

  private itemPath(id: string): string {
    return path.join(this.memoriesDir, `mem_${id}.json`);
  }

  async add(input: AddInput): Promise<MemoryItem> {
    const config = await this.readConfig();
    const now = new Date().toISOString();
    const item = MemoryItem.parse({
      id: input.id ?? randomUUID(),
      content: input.content.trim(),
      tags: normaliseTags(input.tags ?? []),
      source: {
        tool: input.source?.tool ?? "cli",
        ...(input.source?.sessionId ? { sessionId: input.source.sessionId } : {}),
        timestamp: input.source?.timestamp ?? now,
      },
      confidence: input.confidence ?? "stated",
      visibility: input.visibility ?? config.defaultVisibility,
      createdAt: now,
      updatedAt: now,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.importedFrom ? { importedFrom: input.importedFrom } : {}),
    });
    await fs.mkdir(this.memoriesDir, { recursive: true });
    await writeJsonAtomic(this.itemPath(item.id), item);
    return item;
  }

  async get(id: string): Promise<MemoryItem | undefined> {
    try {
      const raw = await fs.readFile(this.itemPath(id), "utf8");
      return MemoryItem.parse(JSON.parse(raw));
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  /** Every item on disk, newest first. Malformed files are skipped, not fatal. */
  async all(): Promise<MemoryItem[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.memoriesDir);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const items: MemoryItem[] = [];
    for (const name of names) {
      if (!name.startsWith("mem_") || !name.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(this.memoriesDir, name), "utf8");
        items.push(MemoryItem.parse(JSON.parse(raw)));
      } catch {
        // A corrupt or hand-edited file should not take down the whole store.
        continue;
      }
    }
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return items;
  }

  async list(filter: ListFilter = {}): Promise<MemoryItem[]> {
    const now = Date.now();
    const wanted = filter.tags ? normaliseTags(filter.tags) : undefined;
    const query = filter.query?.trim().toLowerCase();
    const tool = filter.tool?.trim().toLowerCase();

    let items = await this.all();
    items = items.filter((item) => {
      if (!filter.includeExpired && isExpired(item, now)) return false;
      if (filter.visibility && item.visibility !== filter.visibility) return false;
      if (filter.confidence && item.confidence !== filter.confidence) return false;
      if (tool && item.source.tool.toLowerCase() !== tool) return false;
      if (wanted && wanted.length > 0) {
        if (!item.tags.some((t) => wanted.includes(t.toLowerCase()))) return false;
      }
      if (query) {
        const haystack = `${item.content} ${item.tags.join(" ")}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    if (filter.limit !== undefined && filter.limit >= 0) {
      items = items.slice(0, filter.limit);
    }
    return items;
  }

  async update(
    id: string,
    patch: Partial<Pick<MemoryItem, "content" | "tags" | "visibility" | "expiresAt">>,
  ): Promise<MemoryItem | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    const next = MemoryItem.parse({
      ...current,
      ...patch,
      ...(patch.tags ? { tags: normaliseTags(patch.tags) } : {}),
      updatedAt: new Date().toISOString(),
    });
    await writeJsonAtomic(this.itemPath(id), next);
    return next;
  }

  async remove(id: string): Promise<boolean> {
    try {
      await fs.unlink(this.itemPath(id));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /** Deletes items whose expiresAt has passed. Returns how many went. */
  async pruneExpired(): Promise<number> {
    const now = Date.now();
    const items = await this.all();
    let removed = 0;
    for (const item of items) {
      if (isExpired(item, now) && (await this.remove(item.id))) removed += 1;
    }
    return removed;
  }

  async listTags(): Promise<string[]> {
    const items = await this.list();
    const tags = new Set<string>();
    for (const item of items) for (const tag of item.tags) tags.add(tag);
    return [...tags].sort((a, b) => a.localeCompare(b));
  }

  /** Content keys of every stored item, for import-time dedup. */
  async contentKeys(): Promise<Set<string>> {
    const items = await this.all();
    return new Set(items.map((i) => contentKey(i.content)));
  }

  async readSuggestions(): Promise<Suggestion[]> {
    try {
      const raw = await fs.readFile(this.suggestionsPath, "utf8");
      return SuggestionFile.parse(JSON.parse(raw)).suggestions;
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  async writeSuggestions(suggestions: Suggestion[]): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await writeJsonAtomic(this.suggestionsPath, { suggestions });
  }

  async addSuggestions(
    entries: Array<{ content: string; tags?: string[] }>,
    source: Partial<MemorySource> = {},
  ): Promise<Suggestion[]> {
    const now = new Date().toISOString();
    const existing = await this.readSuggestions();
    const seen = new Set(existing.map((s) => contentKey(s.content)));
    const stored = await this.contentKeys();

    const added: Suggestion[] = [];
    for (const entry of entries) {
      const content = entry.content.trim();
      if (content === "") continue;
      const key = contentKey(content);
      // Don't re-propose what is already pending or already saved.
      if (seen.has(key) || stored.has(key)) continue;
      seen.add(key);
      added.push({
        id: randomUUID(),
        content,
        tags: normaliseTags(entry.tags ?? []),
        source: {
          tool: source.tool ?? "assistant",
          ...(source.sessionId ? { sessionId: source.sessionId } : {}),
          timestamp: source.timestamp ?? now,
        },
        suggestedAt: now,
      });
    }
    if (added.length > 0) await this.writeSuggestions([...existing, ...added]);
    return added;
  }

  async removeSuggestions(ids: string[]): Promise<void> {
    const drop = new Set(ids);
    const remaining = (await this.readSuggestions()).filter((s) => !drop.has(s.id));
    await this.writeSuggestions(remaining);
  }
}

export function isExpired(item: MemoryItem, now: number = Date.now()): boolean {
  if (!item.expiresAt) return false;
  const at = Date.parse(item.expiresAt);
  return !Number.isNaN(at) && at <= now;
}

export function normaliseTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (tag !== "" && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Parses --tags "a,b" (repeatable) into a flat tag list. */
export function parseTagList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const parts = Array.isArray(value) ? value : [value];
  return normaliseTags(parts.flatMap((v) => v.split(",")));
}

/** Turns 7d / 12h / 30m, or an ISO date, into an absolute ISO timestamp. */
export function parseDuration(value: string, from: Date = new Date()): string {
  const match = /^(\d+)\s*([smhdw])$/i.exec(value.trim());
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    const ms: Record<string, number> = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
    };
    return new Date(from.getTime() + amount * ms[unit]!).toISOString();
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Cannot read "${value}" as a duration (try 7d, 12h) or a date.`);
  }
  return new Date(parsed).toISOString();
}

/** Write via temp file + rename so a crash can't leave a half-written record. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
