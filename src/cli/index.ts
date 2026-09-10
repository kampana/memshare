#!/usr/bin/env node
import * as path from "node:path";

import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { Command, Option } from "commander";

import { summarisePII } from "../memory/redact.js";
import {
  MemoryStore,
  parseDuration,
  parseTagList,
  resolveMemoryDir,
} from "../memory/store.js";
import { Mode, Visibility, type MemoryItem } from "../memory/types.js";
import { readBundleFile, writeBundleFile } from "../sharing/bundle.js";
import {
  buildExportBundle,
  describeSkipReason,
  selectForExport,
  type ExportCandidate,
} from "../sharing/export.js";
import { applyImport, planImport, senderTag, type ImportPlan } from "../sharing/import.js";
import {
  c,
  fail,
  formatItemLine,
  formatPii,
  heading,
  info,
  isInteractive,
  ok,
  relativeTime,
  shortId,
  table,
  truncate,
  warn,
} from "./ui.js";

const VERSION = "0.1.1";

const program = new Command();

program
  .name("memshare")
  .description(
    "Peer-to-peer AI memory sharing between users -- with consent.\n" +
      "Your memories are plain JSON files on your machine. Nothing is uploaded anywhere.",
  )
  .version(VERSION, "-v, --version")
  .option("--dir <path>", "memory store location (overrides MEMSHARE_DIR)")
  .showHelpAfterError();

function store(): MemoryStore {
  const dir = program.opts<{ dir?: string }>().dir;
  return new MemoryStore(dir ? path.resolve(dir) : resolveMemoryDir());
}

/** Most commands are meaningless without a store; say so once, clearly. */
async function requireStore(): Promise<MemoryStore> {
  const s = store();
  if (!s.exists()) {
    throw new UserError(
      `No memshare store at ${s.root}.\n  Run ${c.bold("memshare init")} to create one.`,
    );
  }
  return s;
}

class UserError extends Error {}

// ---------------------------------------------------------------- init

program
  .command("init")
  .description("create the memory store in ~/.memshare (or $MEMSHARE_DIR)")
  .option("--name <displayName>", "the name shown on bundles you export")
  .addOption(
    new Option("--mode <mode>", "how memories get saved").choices(Mode.options),
  )
  .option("-y, --yes", "accept defaults, ask nothing")
  .action(async (opts: { name?: string; mode?: string; yes?: boolean }) => {
    const s = store();
    const existed = s.exists();
    const current = await s.readConfig();

    let displayName = opts.name ?? current.displayName;
    let mode = (opts.mode as (typeof Mode.options)[number] | undefined) ?? current.mode;

    if (!opts.yes && isInteractive() && (!opts.name || !opts.mode)) {
      if (!opts.name) {
        displayName = await input({
          message: "Display name (shown to people you share with):",
          default: displayName === "anonymous" ? guessName() : displayName,
        });
      }
      if (!opts.mode) {
        mode = await select({
          message: "How should memories get saved?",
          default: mode,
          choices: [
            {
              name: "suggest  - the AI proposes, you approve (recommended)",
              value: "suggest" as const,
            },
            { name: "auto     - the AI saves silently", value: "auto" as const },
            {
              name: "manual   - nothing is saved unless you ask for it",
              value: "manual" as const,
            },
          ],
        });
      }
    }

    const config = await s.init({ displayName: displayName.trim() || "anonymous", mode });

    console.log();
    console.log(ok(existed ? `Updated ${c.bold(s.root)}` : `Created ${c.bold(s.root)}`));
    console.log(info(`display name: ${c.bold(config.displayName)}`));
    console.log(info(`mode:         ${c.bold(config.mode)}`));
    console.log(info(`PII guard:    ${config.autoRedactPII ? "on" : "off"}`));
    console.log();
    console.log(heading("Next:"));
    console.log(`  claude mcp add memshare -- npx -y memshare-cli serve`);
    console.log(`  memshare add "I prefer TypeScript" --tags preferences --visibility shareable`);
    console.log();
  });

// ---------------------------------------------------------------- add

program
  .command("add")
  .argument("<content>", "the fact to remember, as a standalone sentence")
  .description("add a memory by hand")
  .option("-t, --tags <tags>", "comma-separated tags", collect, [] as string[])
  .addOption(
    new Option("--visibility <visibility>", "private (default) or shareable").choices(
      Visibility.options,
    ),
  )
  .option("--expires <when>", "forget it after e.g. 7d, 12h, or an ISO date")
  .option("--tool <name>", "which tool this came from", "cli")
  .action(
    async (
      content: string,
      opts: { tags: string[]; visibility?: string; expires?: string; tool: string },
    ) => {
      const s = await requireStore();
      const item = await s.add({
        content,
        tags: parseTagList(opts.tags),
        ...(opts.visibility ? { visibility: opts.visibility as MemoryItem["visibility"] } : {}),
        ...(opts.expires ? { expiresAt: parseDuration(opts.expires) } : {}),
        source: { tool: opts.tool },
      });
      console.log(ok(`Saved ${c.dim(shortId(item.id))} ${c.bold(truncate(item.content, 60))}`));
      console.log(
        info(
          `${item.tags.length > 0 ? item.tags.join(", ") : "no tags"} | ${item.visibility}` +
            (item.expiresAt ? ` | expires ${relativeTime(item.expiresAt)}` : ""),
        ),
      );
      if (item.visibility === "private") {
        console.log(info(`Private items are never exported. Use --visibility shareable to share.`));
      }
    },
  );

// ---------------------------------------------------------------- list

program
  .command("list")
  .alias("ls")
  .description("show what is in your memory store")
  .option("-t, --tags <tags>", "only items with any of these tags", collect, [] as string[])
  .addOption(new Option("--visibility <visibility>", "filter").choices(Visibility.options))
  .option("-q, --query <text>", "substring match on content and tags")
  .option("--from <tool>", "only items written by this tool, e.g. claude, chatgpt")
  .option("-n, --limit <n>", "maximum items to show", (v) => Number.parseInt(v, 10))
  .option("--json", "raw JSON output")
  .option("--all", "include expired items")
  .action(
    async (opts: {
      tags: string[];
      visibility?: string;
      query?: string;
      from?: string;
      limit?: number;
      json?: boolean;
      all?: boolean;
    }) => {
      const s = await requireStore();
      const items = await s.list({
        tags: parseTagList(opts.tags),
        ...(opts.visibility ? { visibility: opts.visibility as MemoryItem["visibility"] } : {}),
        ...(opts.query ? { query: opts.query } : {}),
        ...(opts.from ? { tool: opts.from } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.all ? { includeExpired: true } : {}),
      });

      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }

      if (items.length === 0) {
        console.log(info("No memories matched."));
        await printPendingHint(s);
        return;
      }

      console.log();
      console.log(
        table(
          ["ID", "MEMORY", "TAGS", "VISIBILITY", "AGE"],
          items.map((i) => [
            shortId(i.id),
            truncate(i.content, 52),
            i.tags.join(", "),
            i.visibility,
            relativeTime(i.createdAt),
          ]),
          [8, 52, 24, 10, 8],
        ),
      );
      console.log();
      const shareable = items.filter((i) => i.visibility === "shareable").length;
      console.log(info(`${items.length} item(s), ${shareable} shareable.`));
      await printPendingHint(s);
    },
  );

/**
 * In suggest mode nothing the AI proposes reaches the store until the user
 * reviews it. A user who never discovers `review` ends up with an empty store
 * and no idea why, so say it wherever they are already looking.
 */
async function printPendingHint(s: MemoryStore): Promise<void> {
  const pending = await s.readSuggestions();
  if (pending.length === 0) return;
  console.log(
    warn(
      `${pending.length} suggestion(s) waiting for you — nothing is saved until you run ` +
        `${c.bold("memshare review")}.`,
    ),
  );
}

// ---------------------------------------------------------------- recall

program
  .command("recall")
  .description("print memories as plain text, ready to paste into any AI tool")
  .option("-t, --tags <tags>", "only items with any of these tags", collect, [] as string[])
  .option("-q, --query <text>", "substring match on content and tags")
  .option("-n, --limit <n>", "maximum items", (v) => Number.parseInt(v, 10), 30)
  .action(async (opts: { tags: string[]; query?: string; limit: number }) => {
    const s = await requireStore();
    const items = await s.list({
      tags: parseTagList(opts.tags),
      ...(opts.query ? { query: opts.query } : {}),
      limit: opts.limit,
    });
    if (items.length === 0) {
      console.log("(no relevant memories)");
      return;
    }
    console.log("What you know about me and my work:");
    for (const item of items) {
      const tags = item.tags.length > 0 ? ` (${item.tags.join(", ")})` : "";
      console.log(`- ${item.content}${tags}`);
    }
  });

// ---------------------------------------------------------------- tags

program
  .command("tags")
  .description("list every tag in the store")
  .action(async () => {
    const s = await requireStore();
    const tags = await s.listTags();
    console.log(tags.length === 0 ? info("No tags yet.") : tags.join("\n"));
  });

// ---------------------------------------------------------------- forget

program
  .command("forget")
  .argument("<ids...>", "memory ids (full or the short form shown by `list`)")
  .description("delete memories")
  .action(async (ids: string[]) => {
    const s = await requireStore();
    const all = await s.all();
    let removed = 0;
    for (const given of ids) {
      const match = all.find((i) => i.id === given || shortId(i.id) === given);
      if (!match) {
        console.log(fail(`No memory matches ${c.bold(given)}`));
        continue;
      }
      if (await s.remove(match.id)) {
        removed += 1;
        console.log(ok(`Forgot ${c.dim(shortId(match.id))} ${truncate(match.content, 56)}`));
      }
    }
    if (removed === 0) process.exitCode = 1;
  });

// ---------------------------------------------------------------- prune

program
  .command("prune")
  .description("delete memories whose expiry has passed")
  .action(async () => {
    const s = await requireStore();
    const removed = await s.pruneExpired();
    console.log(removed === 0 ? info("Nothing expired.") : ok(`Removed ${removed} expired item(s).`));
  });

// ---------------------------------------------------------------- review

program
  .command("review")
  .description("approve or reject what the AI suggested (suggest mode)")
  .option("-y, --yes", "accept every suggestion without asking")
  .option("--clear", "reject every suggestion")
  .addOption(
    new Option("--visibility <visibility>", "visibility for accepted items").choices(
      Visibility.options,
    ),
  )
  .action(async (opts: { yes?: boolean; clear?: boolean; visibility?: string }) => {
    const s = await requireStore();
    const suggestions = await s.readSuggestions();

    if (suggestions.length === 0) {
      console.log(info("No pending suggestions."));
      return;
    }

    if (opts.clear) {
      await s.writeSuggestions([]);
      console.log(ok(`Rejected ${suggestions.length} suggestion(s).`));
      return;
    }

    console.log();
    console.log(heading(`${suggestions.length} suggestion(s) waiting:`));
    console.log();
    for (const [i, s2] of suggestions.entries()) {
      console.log(`  ${c.dim(String(i + 1).padStart(2))}. ${s2.content}`);
      console.log(
        `      ${s2.tags.length > 0 ? c.cyan(s2.tags.join(", ")) : c.dim("(no tags)")}  ${c.dim(
          `via ${s2.source.tool}, ${relativeTime(s2.suggestedAt)}`,
        )}`,
      );
    }
    console.log();

    let acceptedIds: string[];
    if (opts.yes || !isInteractive()) {
      if (!opts.yes) {
        throw new UserError(
          "Nothing to prompt with (not a terminal). Re-run with --yes to accept all, or --clear to reject all.",
        );
      }
      acceptedIds = suggestions.map((s2) => s2.id);
    } else {
      acceptedIds = await checkbox({
        message: "Which should be saved? (space to toggle, enter to confirm)",
        pageSize: 15,
        choices: suggestions.map((s2) => ({
          name: `${truncate(s2.content, 70)}${s2.tags.length > 0 ? `  [${s2.tags.join(", ")}]` : ""}`,
          value: s2.id,
          checked: true,
        })),
      });
    }

    const visibility = (opts.visibility as MemoryItem["visibility"] | undefined) ?? undefined;
    let saved = 0;
    for (const suggestion of suggestions) {
      if (!acceptedIds.includes(suggestion.id)) continue;
      await s.add({
        content: suggestion.content,
        tags: suggestion.tags,
        ...(visibility ? { visibility } : {}),
        confidence: "inferred",
        source: suggestion.source,
      });
      saved += 1;
    }

    // Everything reviewed leaves the queue, accepted or not.
    await s.writeSuggestions([]);
    console.log();
    console.log(ok(`Saved ${saved}, rejected ${suggestions.length - saved}.`));
  });

// ---------------------------------------------------------------- export

program
  .command("export")
  .description("export shareable memories as a bundle file")
  .option("-t, --tags <tags>", "only items with any of these tags", collect, [] as string[])
  .option("-q, --query <text>", "substring match on content and tags")
  .option("--from <tool>", "only items written by this tool, e.g. chatgpt")
  .option("--for <recipient>", "who this bundle is for (recorded in the bundle)")
  .option("--note <text>", "a note for the recipient")
  .option("--expires <when>", "recipient should refuse it after e.g. 7d, 30d")
  .option("-o, --out <file>", "where to write the bundle")
  .option("--preview", "show what would be exported, write nothing")
  .option("-y, --yes", "skip the confirmation prompt")
  .option("--include-private", "also export items marked private (asks first)")
  .option("--redact-blocked", "include PII-flagged items with the PII masked out")
  .option("--no-scan", "skip PII detection entirely (not recommended)")
  .action(
    async (opts: {
      tags: string[];
      query?: string;
      from?: string;
      for?: string;
      note?: string;
      expires?: string;
      out?: string;
      preview?: boolean;
      yes?: boolean;
      includePrivate?: boolean;
      redactBlocked?: boolean;
      scan: boolean;
    }) => {
      const s = await requireStore();
      const config = await s.readConfig();

      const selection = await selectForExport(s, {
        tags: parseTagList(opts.tags),
        ...(opts.query ? { query: opts.query } : {}),
        ...(opts.from ? { tool: opts.from } : {}),
        ...(opts.includePrivate ? { includePrivate: true } : {}),
        scanForPii: opts.scan,
      });

      console.log();
      console.log(heading(`Export preview${opts.for ? ` for ${c.bold(opts.for)}` : ""}`));
      console.log();

      if (selection.included.length > 0) {
        console.log(c.green(`Will be included (${selection.included.length}):`));
        for (const candidate of selection.included) {
          console.log(`  ${formatItemLine(candidate.item)}`);
        }
        console.log();
      }

      if (selection.blocked.length > 0) {
        console.log(c.yellow(`Blocked -- looks sensitive (${selection.blocked.length}):`));
        for (const candidate of selection.blocked) {
          console.log(`  ${formatItemLine(candidate.item)}`);
          console.log(`      ${c.yellow("contains:")} ${formatPii(candidate.findings)}`);
        }
        console.log();
      }

      if (selection.skipped.length > 0) {
        const counts = new Map<string, number>();
        for (const s2 of selection.skipped) {
          const reason = describeSkipReason(s2.reason);
          counts.set(reason, (counts.get(reason) ?? 0) + 1);
        }
        const summary = [...counts.entries()].map(([r, n]) => `${n} ${r}`).join(", ");
        console.log(info(`Not considered: ${summary}.`));
        console.log();
      }

      if (selection.included.length === 0 && selection.blocked.length === 0) {
        console.log(
          fail(
            "Nothing to export. Only items marked " +
              c.bold("shareable") +
              " are eligible -- set one with `memshare add ... --visibility shareable`.",
          ),
        );
        process.exitCode = 1;
        return;
      }

      if (opts.preview) {
        console.log(info("Preview only. Re-run without --preview to write the bundle."));
        return;
      }

      const items: MemoryItem[] = selection.included.map((candidate) => candidate.item);

      // Each blocked item gets its own decision -- that is the consent step.
      for (const candidate of selection.blocked) {
        const decision = await decideBlocked(candidate, opts);
        if (decision === "redacted") items.push(candidate.redacted);
        else if (decision === "as-is") items.push(candidate.item);
      }

      if (items.length === 0) {
        console.log(fail("Everything was excluded. Nothing written."));
        process.exitCode = 1;
        return;
      }

      if (!opts.yes && isInteractive()) {
        const go = await confirm({
          message: `Export ${items.length} item(s)${opts.for ? ` for ${opts.for}` : ""}?`,
          default: true,
        });
        if (!go) {
          console.log(info("Cancelled. Nothing written."));
          return;
        }
      }

      const bundle = buildExportBundle(items, {
        exportedBy: config.displayName,
        ...(opts.note ? { description: opts.note } : {}),
        ...(opts.for ? { exportedFor: opts.for } : {}),
        ...(opts.expires ? { expiresAt: parseDuration(opts.expires) } : {}),
      });

      const destination = opts.out ? path.resolve(opts.out) : s.bundlesDir;
      const written = await writeBundleFile(bundle, destination);

      console.log();
      console.log(ok(`Wrote ${c.bold(written)}`));
      console.log(info(`${items.length} item(s), hash ${bundle.metadata.contentHash.slice(0, 12)}...`));
      if (bundle.metadata.expiresAt) {
        console.log(info(`Expires ${relativeTime(bundle.metadata.expiresAt)}.`));
      }
      console.log();
      console.log(heading("Send that file however you like. On the other side:"));
      console.log(`  memshare preview ${path.basename(written)}`);
      console.log(`  memshare import ${path.basename(written)}`);
      console.log();
    },
  );

type BlockedDecision = "redacted" | "as-is" | "skip";

async function decideBlocked(
  candidate: ExportCandidate,
  opts: { redactBlocked?: boolean; yes?: boolean },
): Promise<BlockedDecision> {
  if (opts.redactBlocked) return "redacted";
  if (opts.yes || !isInteractive()) return "skip";

  console.log();
  console.log(`${c.yellow("Blocked:")} ${candidate.item.content}`);
  console.log(`  ${c.dim("contains:")} ${summarisePII(candidate.findings)}`);
  console.log(`  ${c.dim("redacted:")} ${candidate.redacted.content}`);

  return select<BlockedDecision>({
    message: "What should happen to it?",
    default: "skip",
    choices: [
      { name: "Skip it (recommended)", value: "skip" },
      { name: "Include the redacted version", value: "redacted" },
      { name: "Include it as-is, sensitive parts and all", value: "as-is" },
    ],
  });
}

// ---------------------------------------------------------------- preview

program
  .command("preview")
  .argument("<file>", "bundle file to inspect")
  .description("inspect a bundle without importing it")
  .option("--json", "raw JSON output")
  .action(async (file: string, opts: { json?: boolean }) => {
    const s = await requireStore();
    const plan = await loadPlan(s, file);
    if (opts.json) {
      console.log(JSON.stringify(plan.bundle, null, 2));
      return;
    }
    printPlan(plan);
    console.log(info(`Nothing imported. Run \`memshare import ${path.basename(file)}\` to choose.`));
    console.log();
  });

// ---------------------------------------------------------------- import

program
  .command("import")
  .argument("<file>", "bundle file from someone else")
  .description("import a bundle, choosing item by item")
  .option("-y, --yes", "accept every new item without asking")
  .addOption(
    new Option("--visibility <visibility>", "how to store accepted items").choices(
      Visibility.options,
    ),
  )
  .option("--tag-sender", "tag accepted items with the sender's name, e.g. from-alice")
  .option("--allow-duplicates", "also offer items you already have")
  .action(
    async (
      file: string,
      opts: {
        yes?: boolean;
        visibility?: string;
        tagSender?: boolean;
        allowDuplicates?: boolean;
      },
    ) => {
      const s = await requireStore();
      const plan = await loadPlan(s, file);
      printPlan(plan);

      const selectable = plan.entries.filter(
        (e) => e.status === "new" || (e.status === "duplicate" && opts.allowDuplicates),
      );

      if (selectable.length === 0) {
        console.log(info("Nothing new to import."));
        return;
      }

      let acceptedIds: string[];
      if (opts.yes || !isInteractive()) {
        if (!opts.yes) {
          throw new UserError(
            "Import needs a terminal to ask you item by item. Re-run with --yes to accept all new items.",
          );
        }
        acceptedIds = selectable.map((e) => e.item.id);
      } else {
        acceptedIds = await checkbox({
          message: "Which items do you want? (space to toggle, enter to confirm)",
          pageSize: 15,
          choices: selectable.map((e) => ({
            name:
              `${truncate(e.item.content, 66)}` +
              (e.item.tags.length > 0 ? `  [${e.item.tags.join(", ")}]` : "") +
              (e.status === "duplicate" ? c.dim("  (you already have this)") : "") +
              (e.findings.length > 0 ? c.yellow(`  (${formatPii(e.findings)})`) : ""),
            value: e.item.id,
            checked: e.status === "new" && e.findings.length === 0,
          })),
        });
      }

      if (acceptedIds.length === 0) {
        console.log(info("Nothing accepted."));
        return;
      }

      const result = await applyImport(s, plan, {
        acceptedIds,
        ...(opts.visibility ? { visibility: opts.visibility as MemoryItem["visibility"] } : {}),
        ...(opts.tagSender ? { addTags: [senderTag(plan.bundle.metadata.exportedBy)] } : {}),
      });

      console.log();
      console.log(
        ok(
          `Imported ${result.imported.length} item(s) from ${c.bold(
            plan.bundle.metadata.exportedBy,
          )}.`,
        ),
      );
      console.log(
        info(
          `Stored as ${c.bold(result.imported[0]?.visibility ?? "private")} with confidence ` +
            `${c.bold("imported")}. Nothing you already had was overwritten.`,
        ),
      );
      console.log();
    },
  );

async function loadPlan(s: MemoryStore, file: string): Promise<ImportPlan> {
  const result = await readBundleFile(path.resolve(file));
  for (const w of result.warnings) console.log(warn(w));
  if (!result.ok || !result.bundle) {
    throw new UserError(`Cannot use this bundle:\n  ${result.errors.join("\n  ")}`);
  }
  return planImport(s, result.bundle);
}

function printPlan(plan: ImportPlan): void {
  const meta = plan.bundle.metadata;
  console.log();
  console.log(heading(`Bundle from ${c.bold(meta.exportedBy)}`));
  console.log(
    info(
      `${plan.counts.total} item(s), exported ${relativeTime(meta.exportedAt)}` +
        (meta.exportedFor ? `, for ${meta.exportedFor}` : "") +
        (meta.expiresAt ? `, expires ${relativeTime(meta.expiresAt)}` : ""),
    ),
  );
  console.log(info(`Integrity check passed (${meta.contentHash.slice(0, 12)}...).`));
  if (meta.description) console.log(info(`Note: ${meta.description}`));
  console.log();

  for (const entry of plan.entries) {
    const marker =
      entry.status === "new"
        ? c.green("new")
        : entry.status === "duplicate"
          ? c.dim("dup")
          : c.yellow("exp");
    console.log(`  ${marker}  ${entry.item.content}`);
    const bits = [
      entry.item.tags.length > 0 ? c.cyan(entry.item.tags.join(", ")) : c.dim("(no tags)"),
      c.dim(`via ${entry.item.source.tool}`),
    ];
    if (entry.status === "duplicate") bits.push(c.dim("you already have this"));
    if (entry.findings.length > 0) bits.push(c.yellow(`sensitive: ${formatPii(entry.findings)}`));
    console.log(`       ${bits.join(c.dim("  |  "))}`);
  }
  console.log();
}

// ---------------------------------------------------------------- serve

program
  .command("serve")
  .description("run the MCP server on stdio (this is what Claude connects to)")
  .action(async () => {
    // Imported lazily so the CLI stays fast for everything else.
    const { serve } = await import("../mcp/server.js");
    await serve(store());
  });

// ---------------------------------------------------------------- config

program
  .command("config")
  .description("show or change settings")
  .option("--set <key=value>", "e.g. --set mode=auto", collect, [] as string[])
  .action(async (opts: { set: string[] }) => {
    const s = await requireStore();
    let config = await s.readConfig();

    if (opts.set.length > 0) {
      const patch: Record<string, unknown> = {};
      for (const pair of opts.set) {
        const at = pair.indexOf("=");
        if (at === -1) throw new UserError(`Expected key=value, got "${pair}".`);
        const key = pair.slice(0, at).trim();
        const raw = pair.slice(at + 1).trim();
        if (!(key in config)) {
          throw new UserError(
            `Unknown setting "${key}". Known: ${Object.keys(config).join(", ")}.`,
          );
        }
        patch[key] = raw === "true" ? true : raw === "false" ? false : raw;
      }
      config = await s.init(patch);
      console.log(ok("Updated."));
    }

    console.log();
    console.log(heading(`Store: ${s.root}`));
    for (const [key, value] of Object.entries(config)) {
      console.log(`  ${key.padEnd(20)} ${c.bold(String(value))}`);
    }
    console.log();
  });

// ---------------------------------------------------------------- run

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function guessName(): string {
  const raw = process.env.USER ?? process.env.USERNAME ?? "";
  return raw.trim() === "" ? "anonymous" : raw.trim();
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    // Ctrl-C inside a prompt is a normal way to leave, not a crash.
    if (err instanceof Error && err.name === "ExitPromptError") {
      console.log();
      console.log(info("Cancelled."));
      process.exitCode = 130;
      return;
    }
    if (err instanceof UserError) {
      console.error();
      console.error(fail(err.message));
      console.error();
      process.exitCode = 1;
      return;
    }
    console.error();
    console.error(fail(err instanceof Error ? err.message : String(err)));
    console.error();
    process.exitCode = 1;
  }
}

void main();
