/**
 * Standing instructions for an assistant, to paste into CLAUDE.md, AGENTS.md,
 * .cursorrules, or whatever file the tool reads at the start of a session.
 *
 * The MCP server already sends equivalent guidance in its `instructions` field
 * and in every tool description, but not every client forwards those to the
 * model. This is the same message through a channel that always arrives.
 *
 * Capture is the one thing memshare cannot force -- nothing in MCP lets a
 * server compel a tool call -- so it is worth saying twice.
 */

/** A marker so `--append` can tell whether this is already in a file. */
export const INSTRUCTIONS_MARKER = "## Memory (memshare)";

export const ASSISTANT_INSTRUCTIONS = `${INSTRUCTIONS_MARKER}

You have a memshare memory store available over MCP. Treat it as your
long-term memory of me and my work.

- **Recall first.** At the start of a conversation, call \`memory_get\` to
  find out what you already know about me and this project. Call it again
  when the topic shifts.
- **Save as you go.** When you learn something durable, call \`memory_set\`
  straight away. Don't wait to be asked, and don't batch it to the end of
  the conversation. Worth saving: a decision and the reason behind it, a
  team convention, a preference of mine, a non-obvious fact about the
  codebase or the domain, a correction to something you assumed.
- **Not worth saving:** anything already visible in the current file or
  diff, transient task state, or anything I'll have forgotten by tomorrow.
- **Choose visibility every time.** \`shareable\` for facts about the
  project, the codebase and how the team works — things a colleague would
  want to know. \`private\` for anything about me personally. When it is
  arguable, choose \`private\`.
- **Never store** secrets, credentials, access tokens, health details or
  financial details. Not even as \`private\`.
- **Reuse tags.** Call \`memory_list_tags\` and reuse what is already there
  rather than inventing near-duplicates. Don't add a tag for the project or
  repository — that one is added automatically.
- **Promoting is mine to ask for.** Only call \`memory_set_visibility\` when
  I actually ask you to. Never decide on your own that something should
  become shareable.
- **Tell me when you save something.** One short line is enough — "noted:
  the team chose Postgres for JSONB". I want to see that it is working, and
  to catch a bad one straight away rather than a month later.
- **Sweep before we finish.** When a working session is wrapping up, look
  back over it and save anything durable you did not save at the time.
`;
