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

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { expandHome } from "./memory/store.js";

/** A marker so `--append` can tell whether this is already in a file. */
export const INSTRUCTIONS_MARKER = "## Memory (memshare)";

export const ASSISTANT_INSTRUCTIONS = `${INSTRUCTIONS_MARKER}

You have a memshare memory store available over MCP. Treat it as your
long-term memory of me and my work.

- **Load the tools first.** In Claude Code, memshare tools may be deferred
  (name only, no schema). Before the first memshare call in a session, run
  \`ToolSearch\` with query \`"+memshare memory"\` to load their schemas.
  Skipping this step causes \`memory_get\` / \`memory_set\` to fail silently.
  In other tools (Cursor, etc.) this step is not needed.
- **Recall first.** At the start of a conversation — immediately after
  loading the tools — call \`memory_get\` to find out what you already know
  about me and this project. Call it again when the topic shifts.
- **Save as you go.** When you learn something durable, call \`memory_set\`
  straight away. Don't wait to be asked, and don't batch it to the end of
  the conversation. Worth saving: a decision and the reason behind it, a
  team convention, a preference of mine, a non-obvious fact about the
  codebase or the domain, a correction to something you assumed.
- **Every save is a save here too.** Whenever you write a durable fact to
  any other memory or notes system you maintain — triggered by any phrasing
  ("remember", "note", "keep in mind", or none at all) — also call
  \`memory_set\` for the same fact here, every time. Treat it as one write
  with two destinations, not two independent decisions. It runs the other way
  too: when \`memory_import\` takes in memories someone sent me, write those
  into your own memory as well — they are things you now know about my work,
  and arriving in a bundle rather than in conversation changes nothing.
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
- **Looking is free.** To answer "what did someone send me?", call
  \`memory_preview\` — it reads a bundle and stores nothing. Reach for
  \`memory_import\` only once I have said I want some of it.
- **Promoting is mine to ask for.** Only call \`memory_set_visibility\` when
  I actually ask you to. Never decide on your own that something should
  become shareable.
- **Forgetting is mine to ask for too.** Only call \`memory_forget\` when I
  explicitly ask you to delete something. Never on your own initiative —
  deletion is irreversible and there is no undo.
- **Tell me when you save something.** One short line is enough — "noted:
  the team chose Postgres for JSONB". I want to see that it is working, and
  to catch a bad one straight away rather than a month later.
- **Sweep before we finish.** When a working session is wrapping up, look
  back over it and save anything durable you did not save at the time.
`;

/**
 * Appends the standing instructions to `file`, unless they are already in it.
 * The marker is the check, so this is safe to run again -- which matters,
 * because `memshare init` now runs it unprompted and people re-run `init`.
 *
 * The file is created if it is missing. `init` only calls this for files that
 * already exist -- putting a CLAUDE.md in a repo that has none is not
 * memshare's business -- but `instructions --append <file>` names one
 * deliberately, and there "it isn't there yet" is not a reason to refuse.
 */
export async function appendInstructionsToFile(
  file: string,
): Promise<"added" | "already-present"> {
  const target = expandHome(file);
  let existing = "";
  try {
    existing = await fs.readFile(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (existing.includes(INSTRUCTIONS_MARKER)) return "already-present";

  await fs.mkdir(path.dirname(target), { recursive: true });
  const separator =
    existing === "" || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  await fs.appendFile(target, `${separator}${ASSISTANT_INSTRUCTIONS}`, "utf8");
  return "added";
}
