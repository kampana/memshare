import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { detectProjectTag } from "../memory/project.js";
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
    { name: "memshare", version: "0.2.7" },
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
