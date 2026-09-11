# Changelog

## 0.1.0

First release.

- Local JSON memory store in `~/.memshare` (`MEMSHARE_DIR` or `--dir` to point elsewhere)
- MCP server over stdio with `memory_set`, `memory_get`, `memory_suggest`, `memory_list_tags`
- CLI: `init`, `add`, `list`, `recall`, `tags`, `review`, `export`, `preview`, `import`, `forget`, `prune`, `config`, `serve`
- Three modes: `auto`, `suggest` (default), `manual`. In suggest mode a direct `memory_set` is queued for approval rather than saved
- Consent-first export: only `shareable` items, PII scanned and held back per item, `--preview` runs the same code path as the real export
- Content-hashed bundles with optional expiry; a bundle edited in transit is refused
- Import with per-item approval, dedup against what you already have, and no overwrites

## 0.1.1

- `memshare list` now warns when suggestions are waiting. In the default
  `suggest` mode nothing the AI proposes reaches the store until you run
  `memshare review`; without this, a user who never found that command ended
  up with an empty store and no indication why.
- Fixed stale `npx memshare serve` lines in the deck and spec that pointed at
  the old package name.
- `check:docs` now verifies install and npx lines name the real package.

## 0.2.0

**Default mode is now `auto`, not `suggest`.** Existing stores are unaffected —
their `config.json` already records an explicit mode. New installs now
accumulate memories from day one instead of queueing everything behind a
`memshare review` the user may never discover.

This does not weaken sharing. There are two consent gates: capture (`mode`)
and sharing (`visibility` + PII scan + export preview + per-item import
approval). `auto` relaxes only the first, and everything still lands `private`.
Capture is automatic; sharing never is.

**Bundle `--expires` now propagates to imported items.** A recipient who
imported a 30-day bundle previously kept those memories forever; an imported
item now inherits the earlier of its own deadline and the bundle's. Expiry is
still cooperative — `contentHash` covers `items`, not `metadata`, so a
determined recipient can edit it. It protects against stale context, not a
hostile recipient.

Deck: the suggest-mode mockup showed an in-chat approval that does not exist.
Replaced with the real flow (`memory_suggest` → queue → `memshare review`).
Removed dead CSS from the audience slide and the stale "MVP" roadmap label.

## 0.2.1

Roadmap correction. The deck marked v0.1 as shipped and listed v0.2 as a
future stage — while 0.2.0 was already on npm. Shipped is now v0.2 and the
stages after it are v0.3 (adapters), v0.4 (Docker / remote), v0.5 (discovery
and live sync), v1.0 when the bundle format freezes.

`check:docs` now enforces this: the deck's "shipped" card must name the
current minor version, and no later stage may reuse that number.

## 0.2.2

**New: `memshare mark`.** `MemoryStore.update()` existed but no command exposed
it, so an item's visibility could never change after creation. Since `auto`
capture always writes `private`, the entire sharing flow was unreachable —
the only shareable items were ones typed by hand. The core promise of the
tool did not work.

```
memshare mark --tags project-x --shareable
```

Select by ids, `--tags` or `--query`. Promoting asks for confirmation when
interactive; pulling back to `private` does not. Deliberately not an MCP
tool — capture and recall belong in conversation, but deciding what may leave
your machine should not be delegated to a model.

Deck and README now lead with what you *say* rather than what you type, since
most users will never run a command beyond the consent steps.

## 0.2.3

Rewrote the MCP tool descriptions and server instructions so the model
actually does what the deck claims.

`memory_set` previously said only "save memories as soon as they are worth
keeping" — abstract, with no trigger moments and no examples, while the
"not for transient details" clause pushed models toward saving nothing. It
now names the moments that justify a call (a stated preference or convention,
a decision with its reason, a non-obvious fact about the codebase, a
correction to an assumption) and gives concrete save / do-not-save examples.

Auto mode now says explicitly: call it yourself, do not wait to be asked, do
not batch to the end of the conversation. The server instructions ask for a
`memory_get` at the start and on topic shifts, and for tag reuse via
`memory_list_tags`.

No API or storage change — capture rate is the whole product, and it depends
entirely on the model choosing to call the tool.

## 0.2.4

**`source.tool` now records the client that actually wrote the memory.** It was
hardcoded to `"mcp"`, so `--from claude` and `--from cursor` matched nothing,
always — the client names itself in the initialize handshake and we were
throwing it away. Now `claude-code`, `cursor-vscode`, and so on.

**Corrected the "switching from ChatGPT to Claude" slide.** It showed
`export --from chatgpt` then `import`, which was wrong twice: no ChatGPT
adapter exists (that is v0.3), and export/import is the wrong mechanism
between your own tools regardless — every MCP client reads the same store, so
switching tools needs no migration at all. Bundles move memory between
*people*, not between one person's tools.

## 0.2.5

**Tags name themselves.** Tag choice was left entirely to the model, which is a
silent failure mode: tags are the whole sharing mechanism, so if one session
says `project-x` and the next says `projectx`, `export --tags project-x`
returns nothing and never says why. Between two people it never lines up at all.

The project tag is now derived from the git checkout the assistant is working
in, so every tool, session and teammate on that repo agrees. Guarded against
tagging everything with a home directory or an uninformative folder name
(`src`, `work`, `tmp`). Disable with `autoProjectTag=false`.

The `tags` parameter now tells the model to supply subject-matter tags only,
leave the project name alone, and reuse existing tags via `memory_list_tags`.

**New: `memshare tags --rename <from> --to <to>`** to merge near-duplicates
that slip through.

**Roadmap correction.** v0.3 said "adapters for Claude, ChatGPT, Cursor,
Copilot". Three of those need no adapter — they speak MCP and work today.
v0.3 is now the ChatGPT route and a system-prompt inject for API-only models.

## 0.2.6

**Renamed to `memshare-mcp`.** `-cli` misdescribed the project to the audience
it targets: someone browsing MCP servers reads "CLI tool" and assumes the
terminal is the interface, when capture and recall happen in conversation and
only the consent steps are commands.

`memshare-cli` is deprecated, not unpublished — deprecation warns on install
and leaves the name working, while unpublishing would burn it permanently.
That is exactly what made `memshare` unusable in the first place.

The installed command is unchanged: `memshare`.

```
npm install -g memshare-mcp
claude mcp add memshare -- npx -y memshare-mcp serve
```

## 0.2.7

No functional change. First release published from CI via npm trusted
publishing, so there is no longer a long-lived npm token anywhere. Also
refreshes the README on npm with the sandbox demo (`examples/try-it.sh`).

## 0.3.0

**New MCP tool: `memory_set_visibility`.** Promoting a memory to shareable was
CLI-only, on the argument that consent should not be delegated to a model. In
practice that broke the flow: if promoting means opening a terminal, most
people never promote anything and nothing is ever shareable. You can now say
"make the project-x notes shareable" and the assistant does it.

Marking is not sharing. `shareable` only makes an item *eligible* for an
export the user still runs, previews and approves. The real gate did not move.

**`memory_set` now requires an explicit `visibility`.** It used to default to
private, which meant everything captured needed promoting later. The model
now decides at capture time — shareable for the project and its conventions,
private for anything about the person, private when it is arguable.

**Roadmap stages are no longer numbered.** Tying them to versions collided
with reality twice. Only the shipped card carries a version; the rest are
themes.

## 0.3.1

**New: `memshare instructions`.** Prints standing instructions to paste into
`CLAUDE.md`, `AGENTS.md`, or whatever file your assistant reads each session.
`--append <file>` writes them in place and is safe to run twice.

Capture is the one thing memshare cannot force — nothing in MCP lets a server
compel a tool call, and some clients never forward the server's instructions
to the model at all. This says the same thing through a channel that always
arrives. `memshare init` now points at it, because a user who skips this step
ends up with an empty store and no idea why.

## 0.3.2

`memshare init` no longer pushes `memshare instructions`. That command is a
fallback for clients that do not forward the server's instructions to the
model — useful when capture is not happening, not a setup step. Putting it in
the "Next:" output made a three-step install look like a four-step one.

Setup is back to: install, init, connect. The instructions command is now
documented under "If nothing is being captured", which is when it helps.

## 0.4.0

**Sharing is conversational.** Two new MCP tools mean the whole round trip can
be done by talking:

- `memory_export` — "send the project-x notes to Sam, good for 30 days"
- `memory_import` — "import what Dana sent me"

Both use a two-phase handshake. The first call previews and writes nothing,
returning exactly what would happen, including anything held back for
containing personal data. Only a second call with `confirmed: true` acts. The
approval moves into the conversation rather than disappearing from it.

This reverses an earlier decision to keep export CLI-only. That argument —
"the moment something leaves your machine should be a deliberate command" —
was wrong about where the boundary is. `export` writes a file to your own
disk and transmits nothing; it leaves when you send it, which is manual
regardless. The command was guarding a step that was not the real boundary,
at the cost of a step most users would never perform.

The CLI still does all of it, for scripting and for people who prefer it.
