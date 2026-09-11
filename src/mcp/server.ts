import * as path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { detectProjectTag } from "../memory/project.js";
import { summarisePII } from "../memory/redact.js";
import { MemoryStore, expandHome, parseDuration } from "../memory/store.js";
import { Visibility, type Mode } from "../memory/types.js";
import { readBundleFile, writeBundleFile } from "../sharing/bundle.js";
import { buildExportBundle, selectForExport } from "../sharing/export.js";
import { applyImport, planImport, senderTag } from "../sharing/import.js";

/**
 * The MCP adapter. It owns no state -- every tool call goes straight to the
 * JSON files in ~/.memshare, which is the whole point: if MCP goes away, the
 * memories are still sitting there in a folder.
 *
 * stdout belongs to the JSON-RPC transport. All logging goes to stderr.
 */

const MODE_NOTES: Record<Mode, string> = {
  auto:
    "Store mode is AUTO: call memory_set yourself, as soon as a durable fact appears. " +
    "Do not wait to be asked, and do not batch it to the end of the conversation.",
  suggest:
    "Store mode is SUGGEST (the default): propose memories with memory_suggest instead of saving them. " +
    "The user reviews them later with `memshare review`. If you call memory_set anyway, it is queued as a suggestion, not saved.",
  manual:
    "Store mode is MANUAL: save nothing unless the user explicitly asks you to remember it. Then call memory_set.",
};

export async function createServer(store: MemoryStore = new MemoryStore()): Promise<McpServer> {
  const config = await store.readConfig();
  const modeNote = MODE_NOTES[config.mode];

  // The client launches this server in the project directory, so the checkout
  // name is a tag every tool and every session agrees on. Without it the model
  // invents a name each time and `export --tags` silently matches nothing.
  const projectTag = config.autoProjectTag ? detectProjectTag() : undefined;
  const withProject = (tags: string[]): string[] =>
    projectTag && !tags.includes(projectTag) ? [projectTag, ...tags] : tags;

  /**
   * Which tool is actually writing. The client names itself in the initialize
   * handshake ("claude-code", "cursor-vscode", ...), and recording it is what
   * makes `memshare list --from cursor` mean anything. Only available after
   * the handshake, so it is read per call rather than captured up front.
   */
  const sourceTool = (): string => {
    const name = server.server.getClientVersion()?.name?.trim().toLowerCase();
    return name && name !== "" ? name : "mcp";
  };

  const server = new McpServer(
    { name: "memshare", version: "0.4.1" },
    {
      instructions:
        "memshare is this user's own memory store, shared across every AI tool they use. " +
        "Treat it as your long-term memory of them.\n\n" +
        "At the start of a conversation, call memory_get to recall what you already know about " +
        "this user and their work, and call it again when the topic shifts. " +
        "Reuse existing tags rather than inventing near-duplicates -- memory_list_tags shows them.\n\n" +
        modeNote +
        "\n\nNever store secrets, credentials, health details or financial details. memshare blocks " +
        "them from being shared, but they should not be written down in the first place.",
    },
  );

  server.registerTool(
    "memory_set",
    {
      title: "Save a memory",
      description:
        "Save one durable fact about the user, their projects, or their preferences -- something " +
        "that will still be true and useful in a conversation a month from now.\n\n" +
        "Moments that usually justify a call: the user states a preference or a team convention; " +
        "a decision is made and a reason is given; you learn something non-obvious about their " +
        "codebase, domain or process; the user corrects an assumption you were working from.\n\n" +
        "Worth saving: \"The team chose Postgres over MySQL for its JSONB support.\" " +
        "\"Migrations run through scripts/migrate.ts, never by hand.\" " +
        "\"Prefers TypeScript with strict mode over plain JavaScript.\"\n" +
        "Not worth saving: anything already visible in the current file or diff, transient task " +
        "state, or secrets, credentials, health details and financial details.\n\n" +
        "One fact per call, written as a standalone sentence that makes sense with no other " +
        "context. " +
        modeNote,
      inputSchema: {
        content: z
          .string()
          .min(1)
          .describe("The fact, as a standalone sentence. E.g. 'Auth service uses JWT with 15min refresh'."),
        tags: z
          .array(z.string())
          .default([])
          .describe(
            "Short lowercase topic tags for the subject matter, e.g. ['auth', 'deploy']. " +
              "Do not invent a name for the project or repository -- that tag is added automatically. " +
              "Call memory_list_tags first and reuse existing tags rather than near-duplicates.",
          ),
        visibility: Visibility.describe(
          "Decide this every time; there is no default.\n" +
            "'shareable' — facts about the project, codebase, team conventions or technical " +
            "decisions. Things a colleague working on the same thing would want to know. " +
            "It still cannot leave the machine without the user approving an export.\n" +
            "'private' — anything about the person rather than the work: their preferences, " +
            "their circumstances, their opinions about people, anything sensitive. " +
            "When the two are arguable, choose 'private'.",
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ content, tags, visibility }) => {
      // In suggest mode a direct write would bypass the user's consent, so it
      // becomes a suggestion instead of an error.
      if (config.mode === "suggest") {
        const [queued] = await store.addSuggestions([{ content, tags: withProject(tags) }], { tool: sourceTool() });
        return text(
          queued
            ? `Queued for the user's approval (suggest mode). It is not saved yet; the user reviews it with \`memshare review\`. id: ${queued.id}`
            : "Already saved or already pending approval; nothing queued.",
        );
      }

      const item = await store.add({
        content,
        tags: withProject(tags),
        ...(visibility ? { visibility } : {}),
        confidence: "stated",
        source: { tool: sourceTool() },
      });
      return text(`Saved. id: ${item.id}, visibility: ${item.visibility}`);
    },
  );

  server.registerTool(
    "memory_get",
    {
      title: "Recall memories",
      description:
        "Look up what is already known about the user. Call this early in a conversation, and again when " +
        "the topic shifts. With no arguments it returns the most recent memories; a query or tags narrow it down.",
      inputSchema: {
        query: z.string().optional().describe("Free-text substring match over content and tags."),
        tags: z.array(z.string()).optional().describe("Return items carrying any of these tags."),
        limit: z.number().int().positive().max(200).optional().describe("Maximum items (default 20)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, tags, limit }) => {
      const items = await store.list({
        ...(query ? { query } : {}),
        ...(tags && tags.length > 0 ? { tags } : {}),
        limit: limit ?? 20,
      });
      if (items.length === 0) return text("No memories matched.");
      const lines = items.map(
        (i) =>
          `- ${i.content}` +
          (i.tags.length > 0 ? `  [tags: ${i.tags.join(", ")}]` : "") +
          `  (${i.confidence}, ${i.visibility}` +
          (i.importedFrom ? `, from ${i.importedFrom.exportedBy}` : "") +
          `, id: ${i.id})`,
      );
      return text(`${items.length} memory item(s):\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "memory_suggest",
    {
      title: "Suggest memories to save",
      description:
        "Propose memories without saving them. The user approves or rejects each one with `memshare review`. " +
        "This is the right tool in suggest mode: gather what was worth learning from the conversation and " +
        "propose it in one call.",
      inputSchema: {
        suggestions: z
          .array(
            z.object({
              content: z.string().min(1).describe("The fact, as a standalone sentence."),
              tags: z.array(z.string()).default([]).describe("Short lowercase topic tags."),
            }),
          )
          .min(1)
          .describe("The items to propose."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ suggestions }) => {
      const added = await store.addSuggestions(
        suggestions.map((entry) => ({ ...entry, tags: withProject(entry.tags) })),
        { tool: sourceTool() },
      );
      const duplicates = suggestions.length - added.length;
      const parts = [`${added.length} suggestion(s) queued for the user's approval.`];
      if (duplicates > 0) parts.push(`${duplicates} skipped (already saved or already pending).`);
      parts.push("Nothing is stored until the user runs `memshare review`.");
      return text(parts.join(" "));
    },
  );

  server.registerTool(
    "memory_set_visibility",
    {
      title: "Change what may be shared",
      description:
        "Mark memories as 'shareable' so they can be included in an export, or back to 'private'. " +
        "Select them by id, by tag, or by a text query.\n\n" +
        "Only call this when the user has actually asked for it -- \"make the project-x notes " +
        "shareable\", \"don't share that one\". Never decide on your own that something should " +
        "become shareable.\n\n" +
        "This does not share anything. It only makes an item eligible for an export that the user " +
        "still has to run and approve.",
      inputSchema: {
        visibility: Visibility.describe(
          "'shareable' to allow it into a future export, 'private' to rule it out.",
        ),
        ids: z.array(z.string()).optional().describe("Memory ids, as returned by memory_get."),
        tags: z.array(z.string()).optional().describe("Every memory carrying any of these tags."),
        query: z.string().optional().describe("Every memory matching this text."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ visibility, ids, tags, query }) => {
      if ((!ids || ids.length === 0) && (!tags || tags.length === 0) && !query) {
        return text(
          "Nothing selected. Pass ids, tags, or a query -- this tool will not change every memory at once.",
        );
      }

      const selected =
        ids && ids.length > 0
          ? (await store.all()).filter((i) => ids.includes(i.id))
          : await store.list({
              ...(tags && tags.length > 0 ? { tags } : {}),
              ...(query ? { query } : {}),
            });

      const changing = selected.filter((i) => i.visibility !== visibility);
      if (selected.length === 0) return text("Nothing matched.");
      if (changing.length === 0) {
        return text(`All ${selected.length} matching memory(s) are already ${visibility}.`);
      }

      for (const item of changing) await store.update(item.id, { visibility });

      const listed = changing.map((i) => `- ${i.content}`).join("\n");
      return text(
        `${changing.length} memory(s) are now ${visibility}:\n${listed}\n\n` +
          (visibility === "shareable"
            ? "They are still on this machine only. Sharing them takes an explicit `memshare export`, which the user runs and approves."
            : "They can no longer be included in any export."),
      );
    },
  );

  server.registerTool(
    "memory_export",
    {
      title: "Prepare memories to share with someone",
      description:
        "Write a bundle file the user can send to another person. Nothing is transmitted -- this " +
        "only writes a file to their machine, which they then send however they like.\n\n" +
        "**Always call this twice.** The first call, without `confirmed`, changes nothing and " +
        "returns exactly what would go in, including anything held back for containing personal " +
        "or sensitive data. Show that list to the user in full and wait. Only if they agree, call " +
        "again with `confirmed: true` to write the file.\n\n" +
        "Never call it with `confirmed: true` first. The user deciding what leaves their machine " +
        "is the point of this tool, not an obstacle to route around.\n\n" +
        "Only items the user has marked 'shareable' are eligible; private ones are never included.",
      inputSchema: {
        tags: z
          .array(z.string())
          .optional()
          .describe("Limit to memories carrying any of these tags. Omit to offer everything shareable."),
        query: z.string().optional().describe("Limit to memories matching this text."),
        for: z
          .string()
          .optional()
          .describe("Who the bundle is for, recorded in it. E.g. 'sam'."),
        expires: z
          .string()
          .optional()
          .describe("Refuse import after this long, e.g. '30d'. Imported items inherit the deadline."),
        note: z.string().optional().describe("A short note to the recipient."),
        confirmed: z
          .boolean()
          .optional()
          .describe("Leave unset to preview. Set true only after the user has seen the list and agreed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ tags, query, for: forWhom, expires, note, confirmed }) => {
      const selection = await selectForExport(store, {
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(query ? { query } : {}),
      });

      if (selection.included.length === 0 && selection.blocked.length === 0) {
        const why =
          selection.skipped.length > 0
            ? ` ${selection.skipped.length} memory(s) matched but are marked private.`
            : "";
        return text(
          `Nothing to export.${why} Only memories marked 'shareable' can be included -- ` +
            "memory_set_visibility can change that, if the user asks.",
        );
      }

      const lines = selection.included.map((c) => `- ${c.item.content}`);
      const blocked = selection.blocked.map(
        (c) => `- ${c.item.content}\n    held back: ${summarisePII(c.findings)}`,
      );

      if (!confirmed) {
        const parts = [
          `Nothing written yet. This would share ${selection.included.length} memory(s)` +
            (forWhom ? ` with ${forWhom}` : "") +
            ":",
          lines.join("\n") || "(none)",
        ];
        if (blocked.length > 0) {
          parts.push(
            `\n${selection.blocked.length} held back for containing personal or sensitive data:`,
            blocked.join("\n"),
            "Those stay out unless the user explicitly asks to include them, via `memshare export --redact-blocked`.",
          );
        }
        parts.push(
          "\nShow this list to the user and wait. Call again with confirmed: true only if they agree.",
        );
        return text(parts.join("\n"));
      }

      if (selection.included.length === 0) {
        return text(
          "Every matching memory was held back for containing sensitive data. Nothing written.",
        );
      }

      const config = await store.readConfig();
      const bundle = buildExportBundle(
        selection.included.map((c) => c.item),
        {
          exportedBy: config.displayName,
          ...(note ? { description: note } : {}),
          ...(forWhom ? { exportedFor: forWhom } : {}),
          ...(expires ? { expiresAt: parseDuration(expires) } : {}),
        },
      );
      const written = await writeBundleFile(bundle, store.bundlesDir);

      return text(
        `Wrote ${written}\n${selection.included.length} memory(s)` +
          (forWhom ? ` for ${forWhom}` : "") +
          (expires ? `, expiring in ${expires}` : "") +
          `.\n\nTell the user where the file is and that they need to send it themselves -- ` +
          "memshare never transmits anything. The recipient runs `memshare import <file>` and " +
          "accepts items one by one.",
      );
    },
  );

  server.registerTool(
    "memory_import",
    {
      title: "Take in memories someone sent",
      description:
        "Read a bundle file another person sent and add the memories the user wants from it.\n\n" +
        "**Always call this twice.** The first call, without `confirmed`, changes nothing and " +
        "returns every item in the bundle, flagging which ones the user already knows and " +
        "anything that looks sensitive. Show that list and wait. Only if they agree, call again " +
        "with `confirmed: true`.\n\n" +
        "By default the second call takes everything new. If the user only wants some of it, pass " +
        "`accept` with the ids from the preview.\n\n" +
        "Imported memories are stored private, whatever the sender marked them -- receiving " +
        "something is not permission to pass it on. Nothing the user already had is overwritten.",
      inputSchema: {
        file: z.string().min(1).describe("Path to the .memshare.json file the sender provided."),
        confirmed: z
          .boolean()
          .optional()
          .describe("Leave unset to preview. Set true only after the user has seen the list and agreed."),
        accept: z
          .array(z.string())
          .optional()
          .describe("Ids from the preview to take. Omit to take everything new."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ file, confirmed, accept }) => {
      const result = await readBundleFile(path.resolve(expandHome(file)));
      if (!result.ok || !result.bundle) {
        return text(`Cannot use this bundle:\n${result.errors.map((e) => `- ${e}`).join("\n")}`);
      }

      const plan = await planImport(store, result.bundle);
      const from = plan.bundle.metadata.exportedBy;

      if (!confirmed) {
        const lines = plan.entries.map((e) => {
          const flags = [
            e.status === "duplicate" ? "already known" : undefined,
            e.status === "expired" ? "expired" : undefined,
            e.findings.length > 0 ? `sensitive: ${summarisePII(e.findings)}` : undefined,
          ].filter(Boolean);
          return `- ${e.item.content}${flags.length > 0 ? `  (${flags.join("; ")})` : ""}\n    id: ${e.item.id}`;
        });
        return text(
          `Nothing imported yet. ${from} sent ${plan.counts.total} memory(s), ` +
            `${plan.counts.new} of them new:\n${lines.join("\n")}\n\n` +
            "Show this to the user and wait. Call again with confirmed: true to take the new ones, " +
            "or pass `accept` with the ids they actually want.",
        );
      }

      const acceptedIds =
        accept && accept.length > 0
          ? accept
          : plan.entries.filter((e) => e.status === "new").map((e) => e.item.id);

      if (acceptedIds.length === 0) return text("Nothing new to import.");

      const applied = await applyImport(store, plan, {
        acceptedIds,
        addTags: [senderTag(from)],
      });
      return text(
        `Imported ${applied.imported.length} memory(s) from ${from}, stored private and tagged ` +
          `${senderTag(from)}. Nothing the user already had was changed.`,
      );
    },
  );

  server.registerTool(
    "memory_list_tags",
    {
      title: "List memory tags",
      description:
        "List every tag in the store. Useful before memory_get, to see which topics exist and to reuse " +
        "existing tags instead of inventing near-duplicates.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const tags = await store.listTags();
      return text(tags.length === 0 ? "No tags yet." : `Tags: ${tags.join(", ")}`);
    },
  );

  return server;
}

/** Starts the server on stdio and resolves when the transport closes. */
export async function serve(store: MemoryStore = new MemoryStore()): Promise<void> {
  if (!store.exists()) {
    console.error(
      `memshare: no store at ${store.root}. Run \`memshare init\` first; starting with defaults for now.`,
    );
  }
  const server = await createServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`memshare MCP server ready (store: ${store.root})`);

  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });
  await server.close();
}

function text(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}
