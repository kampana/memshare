import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { MemoryStore } from "../memory/store.js";
import { Visibility, type Mode } from "../memory/types.js";

/**
 * The MCP adapter. It owns no state -- every tool call goes straight to the
 * JSON files in ~/.memshare, which is the whole point: if MCP goes away, the
 * memories are still sitting there in a folder.
 *
 * stdout belongs to the JSON-RPC transport. All logging goes to stderr.
 */

const MODE_NOTES: Record<Mode, string> = {
  auto: "Store mode is AUTO: save memories with memory_set as soon as they are worth keeping.",
  suggest:
    "Store mode is SUGGEST (the default): propose memories with memory_suggest instead of saving them. " +
    "The user reviews them later with `memshare review`. If you call memory_set anyway, it is queued as a suggestion, not saved.",
  manual:
    "Store mode is MANUAL: save nothing unless the user explicitly asks you to remember it. Then call memory_set.",
};

export async function createServer(store: MemoryStore = new MemoryStore()): Promise<McpServer> {
  const config = await store.readConfig();
  const modeNote = MODE_NOTES[config.mode];

  const server = new McpServer(
    { name: "memshare", version: "0.2.1" },
    {
      instructions:
        "memshare gives you a local, user-owned memory store shared across AI tools. " +
        "Call memory_get near the start of a conversation to recall what you already know about this user " +
        "and their projects. " +
        modeNote +
        " Never store secrets, credentials, health details or financial details -- memshare blocks them from " +
        "sharing, but they should not be written down in the first place.",
    },
  );

  server.registerTool(
    "memory_set",
    {
      title: "Save a memory",
      description:
        "Save one durable fact about the user, their projects, or their preferences. " +
        "Use it for things that stay true after this conversation ends, not for transient details. " +
        "One fact per call, written as a standalone sentence that makes sense without context. " +
        modeNote,
      inputSchema: {
        content: z
          .string()
          .min(1)
          .describe("The fact, as a standalone sentence. E.g. 'Auth service uses JWT with 15min refresh'."),
        tags: z
          .array(z.string())
          .default([])
          .describe("Short lowercase topic tags, e.g. ['project-x', 'auth']."),
        visibility: Visibility.optional().describe(
          "'private' (default) never leaves the machine. 'shareable' may be included in an export the user approves.",
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ content, tags, visibility }) => {
      // In suggest mode a direct write would bypass the user's consent, so it
      // becomes a suggestion instead of an error.
      if (config.mode === "suggest") {
        const [queued] = await store.addSuggestions([{ content, tags }], { tool: "mcp" });
        return text(
          queued
            ? `Queued for the user's approval (suggest mode). It is not saved yet; the user reviews it with \`memshare review\`. id: ${queued.id}`
            : "Already saved or already pending approval; nothing queued.",
        );
      }

      const item = await store.add({
        content,
        tags,
        ...(visibility ? { visibility } : {}),
        confidence: "stated",
        source: { tool: "mcp" },
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
      const added = await store.addSuggestions(suggestions, { tool: "mcp" });
      const duplicates = suggestions.length - added.length;
      const parts = [`${added.length} suggestion(s) queued for the user's approval.`];
      if (duplicates > 0) parts.push(`${duplicates} skipped (already saved or already pending).`);
      parts.push("Nothing is stored until the user runs `memshare review`.");
      return text(parts.join(" "));
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
