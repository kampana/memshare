# memshare — notes for AI assistants working on this repo

## The one rule that is easy to break

`docs/index.html` (the landing page) and `docs/pitch.html` (the deck) are the **single source of truth**. When they and `README.md` disagree, the deck wins — it is the product's public face and must never lag the code. Change what the tool does, and all three change in the same commit.

The full design spec lives outside the repo, at `~/Documents/memshare-SPEC.md`, and is deliberately not published. Keep it current there; never add it back to `docs/`.

`npm run check:docs` catches the mechanical half (commands invoked in docs that the CLI does not register, version drift). It cannot check whether the prose is still true. Read it.

## Layout

```
src/memory/    the store, the schemas, the PII scanner  — depends on nothing else
src/sharing/   bundle format, export selection, import planning
src/mcp/       MCP adapter (stdio)
src/cli/       CLI adapter
src/index.ts   the public library surface every adapter goes through
```

`src/memory/` must never import from `src/mcp/` or `src/cli/`. The store is the product; adapters are replaceable.

## Design commitments

- **Preview and the real action share one code path.** `selectForExport` and `planImport` compute what *would* happen; the CLI renders that object and then acts on it. Never write a parallel implementation for a preview — consent based on a stale preview is not consent.
- **Nothing leaves the machine on its own.** There is no network code here. Adding some needs an explicit discussion first.
- **The PII scanner is deliberately over-eager.** Adding a pattern? Add a test for what it must *not* match too. `test/redact.test.ts` keeps a list of ordinary technical sentences that must stay clean.
- **Imports never overwrite** and are stored `private`.
- **stdout belongs to the MCP transport.** In `src/mcp/`, log to stderr only.

## Before saying you are done

```bash
npm run typecheck && npm run build && npm test && npm run check:docs
```

Bumping the version means changing it in `package.json`, `src/cli/index.ts` (`VERSION`) and `src/mcp/server.ts` — `check:docs` will fail if you miss one — plus a `CHANGELOG.md` entry.

> Verify deck changes against the **live URL**, not just the local file. GitHub Pages takes ~40s to redeploy and caches.

## Memory (memshare)

You have a memshare memory store available over MCP. Treat it as your
long-term memory of me and my work.

- **Load the tools first.** memshare tools are MCP tools that may be
  deferred (name only, no schema). Before the first memshare call in a
  session, run `ToolSearch` with query `"+memshare memory"` to load their
  schemas. If you skip this step, calls to `memory_get` / `memory_set`
  will silently fail with an InputValidationError.
- **Recall first.** At the start of a conversation — immediately after
  loading the tools — call `memory_get` to find out what you already know
  about me and this project. Call it again when the topic shifts.
- **Save as you go.** When you learn something durable, call `memory_set`
  straight away. Don't wait to be asked, and don't batch it to the end of
  the conversation. Worth saving: a decision and the reason behind it, a
  team convention, a preference of mine, a non-obvious fact about the
  codebase or the domain, a correction to something you assumed.
- **Every save is a save here too.** Whenever you write a durable fact to
  any other memory or notes system you maintain — triggered by any phrasing
  ("remember", "note", "keep in mind", or none at all) — also call
  `memory_set` for the same fact here, every time. Treat it as one write
  with two destinations, not two independent decisions. It runs the other way
  too: when `memory_import` takes in memories someone sent me, write those
  into your own memory as well — they are things you now know about my work,
  and arriving in a bundle rather than in conversation changes nothing.
- **Not worth saving:** anything already visible in the current file or
  diff, transient task state, or anything I'll have forgotten by tomorrow.
- **Choose visibility every time.** `shareable` for facts about the
  project, the codebase and how the team works — things a colleague would
  want to know. `private` for anything about me personally. When it is
  arguable, choose `private`.
- **Never store** secrets, credentials, access tokens, health details or
  financial details. Not even as `private`.
- **Reuse tags.** Call `memory_list_tags` and reuse what is already there
  rather than inventing near-duplicates. Don't add a tag for the project or
  repository — that one is added automatically.
- **Looking is free.** To answer "what did someone send me?", call
  `memory_preview` — it reads a bundle and stores nothing. Reach for
  `memory_import` only once I have said I want some of it.
- **Promoting is mine to ask for.** Only call `memory_set_visibility` when
  I actually ask you to. Never decide on your own that something should
  become shareable.
- **Forgetting is mine to ask for too.** Only call `memory_forget` when I
  explicitly ask you to delete something. Never on your own initiative —
  deletion is irreversible and there is no undo.
- **Tell me when you save something.** One short line is enough — "noted:
  the team chose Postgres for JSONB". I want to see that it is working, and
  to catch a bad one straight away rather than a month later.
- **Sweep before we finish.** When a working session is wrapping up, look
  back over it and save anything durable you did not save at the time.
