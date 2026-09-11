# memshare

**Peer-to-peer AI memory sharing between users — with consent.**

[![npm](https://img.shields.io/npm/v/memshare-mcp.svg)](https://www.npmjs.com/package/memshare-mcp)
[![CI](https://github.com/kampana/memshare/actions/workflows/ci.yml/badge.svg)](https://github.com/kampana/memshare/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Every AI memory tool today treats memory as a feature of a chat product. memshare treats it as a data type: plain JSON files you own.

Once memory is a file, three things follow, in this order. You can **inspect** it — greppable, diffable, and actually gone when you delete it. You can **move** it — one store, every MCP client, every machine you own. And only then can you **share** it — selectively, item by item, with approval on both sides. That last one no other tool does at all; they are all per-account by design.

That third one is the part nothing else does. A designer working in Cursor and backend devs working in Claude Code can hand each other context directly — different people *and* different vendors, same bundle format.

No central server. No cloud. No signup.

🌐 **[memshare.dev site](https://kampana.github.io/memshare/)** · 📊 **[Pitch deck](https://kampana.github.io/memshare/pitch.html)** · 📄 **[Full spec](docs/SPEC.md)**

---

## 30-second quickstart

```bash
npm install -g memshare-mcp
memshare init

# Connect it to Claude Code
claude mcp add memshare -- npx -y memshare-mcp serve

# Or add it to any MCP client's config:
#   { "mcpServers": { "memshare": { "command": "npx", "args": ["-y", "memshare-mcp", "serve"] } } }
```

## You mostly talk, not type

After setup, capture and recall happen in conversation — there is no command to run:

> *"we went with Postgres — the JSONB support decided it"* → the AI calls `memory_set`, saved as `private`
>
> *"what do you know about this project?"* → the AI calls `memory_get`
>
> *"remember that I like dark mode"* → the AI calls `memory_set`

The commands exist for the decisions you should not delegate to a model: **what becomes shareable, what gets exported, and what you accept from someone else.** That is the point, not an unfinished UI.

Promoting happens either way — in conversation, or at a prompt:

> *"make the project-x notes shareable"* → the AI calls `memory_set_visibility`

```bash
memshare mark --tags project-x --shareable
```

Either route only makes an item **eligible**. Nothing is shared until you run `memshare export` and approve the preview — that step stays deliberately out of the model's hands.

### Tags name themselves

You never have to say "tag this project-x". The project tag is derived from the git checkout the assistant is working in, so every tool, every session and every teammate on that repo agrees on it — and the model is told to add only subject-matter tags (`auth`, `deploy`) on top. Turn it off with `memshare config --set autoProjectTag=false`.

If near-duplicates creep in anyway, merge them:

```bash
memshare tags --rename projectx --to project-x
```

You can also add memories by hand at any time:

```bash
memshare add "Auth service uses JWT with 15min refresh" --tags project-x,auth --visibility shareable
memshare list
memshare list --tags project-x
```

## If nothing is being captured

memshare can offer memory, but nothing in MCP can make a model *use* it. The server asks the assistant to save as it learns — in its handshake and in every tool description — but some clients never pass server instructions to the model at all.

If `memshare list` is still empty after a few days of real work, say it once more in the file your tool reads every session:

```bash
memshare instructions --append ~/.claude/CLAUDE.md    # Claude Code
memshare instructions --append ./AGENTS.md            # Cursor, Windsurf, Copilot
```

Safe to run twice — it checks before appending.

## Try it in a sandbox first

The whole flow — capture, the consent step, PII getting blocked, export, per-item import — against throwaway stores:

```bash
git clone https://github.com/kampana/memshare.git
cd memshare && npm install && npm run build
bash examples/try-it.sh
```

This does install the project's dependencies locally, in the folder you cloned. What it does **not** do: install anything globally, create or modify `~/.memshare`, or add anything to your Claude config. It builds two fake stores under a temp directory and deletes cleanly. Nothing carries over to a real setup.

## Sharing with someone else

```bash
# Alice — see exactly what would go out, before anything is written
memshare export --tags "project-x,architecture" --for bob --expires 7d --preview

# Happy with it? Write the bundle.
memshare export --tags "project-x,architecture" --for bob --expires 7d
# → ~/.memshare/bundles/bundle-a3f8c2d1.memshare.json
```

Send that file however you like — email, Slack, AirDrop, a USB stick. Then, on Bob's machine:

```bash
memshare preview bundle-a3f8c2d1.memshare.json   # look, import nothing
memshare import  bundle-a3f8c2d1.memshare.json   # choose item by item
```

Bob picks each item individually. Accepted items land in his store marked `imported`, stored **private** by default — receiving something is not consent to pass it on. Nothing he already had is overwritten.

## Architecture

```
              ~/.memshare/memories/*.json
              the actual product — plain JSON files
                ▲        ▲         ▲         ▲
                │        │         │         │
          MCP server   CLI    ChatGPT adapter  system-prompt inject
                │                (planned)        (planned)
                │
      Claude · Cursor · VS Code · Windsurf · any MCP client
```

The memory store is the product. The MCP server is one adapter over it, the CLI is another. If MCP disappears tomorrow, your data is still sitting in a folder — human-readable, diffable, and git-friendly. Sync it between your own machines with git or Dropbox; it is just files.

```
~/.memshare/
├── config.json              # your settings
├── memories/
│   └── mem_<uuid>.json      # one file per memory
├── suggestions.json         # pending, not yet approved
└── bundles/
    └── bundle_<id>.memshare.json
```

## How memories get saved — three modes

These control what gets **written down** locally. What gets **shared** is a separate gate, covered below, and is never automatic.

| Mode | What happens | Who decides |
|---|---|---|
| `auto` **(default)** | The AI saves what it learns as you work. Everything lands `private`. | The AI, locally |
| `suggest` | The AI calls `memory_suggest`. Nothing is stored until you run `memshare review`. | You, in batch |
| `manual` | Nothing is saved unless you say "remember this". | You, every time |

`auto` is the default because an empty store is useless, and nothing captured locally can leave your machine until you mark it `shareable` anyway. If you would rather approve every item, use `suggest` — and note that a direct `memory_set` is then queued as a suggestion rather than saved, so an over-eager model cannot skip the consent step.

```bash
memshare review          # approve or reject, one by one
memshare review --yes    # accept everything pending
memshare review --clear  # reject everything pending
```

## Consent, on both sides

1. **You tag at creation time.** Every item is `private` (the default) or `shareable`. Private items are never exported, not even when their tags match.
2. **PII is blocked automatically.** Before anything leaves your machine, memshare scans for emails, phone numbers, government IDs, payment cards, bank details, credentials, and health or financial language. Flagged items are held back; you decide per item whether to skip them, send a redacted version, or send them as-is.
3. **You see the exact bundle first.** `--preview` runs the identical computation the real export does — there is no separate preview code path to drift out of sync.
4. **They choose too.** The recipient previews every item and accepts or rejects individually. Bundles are content-hashed, so a file edited in transit is refused.

### What `--expires` does, and does not do

`memshare export --expires 30d` sets a deadline that does two things: the recipient's memshare **refuses to import** the bundle after it passes, and any item they did import **inherits that deadline** — so it stops being recalled and is deleted by `memshare prune`.

It does **not** delete the bundle file, and it is **cooperative, not enforced**: the deadline lives in the bundle metadata, which is not covered by the content hash, so a determined recipient can edit it. Expiry protects against stale context, not against a hostile recipient. There is no central server, so there is nothing that could revoke a file someone already has.

## How it compares

| | Cross-model portability | Self-hosted | User-to-user sharing | Consent flow |
|---|:---:|:---:|:---:|:---:|
| Claude / ChatGPT memory | ✗ | ✗ | ✗ | ✗ |
| Mem0 | ✓ | ✓ | ✗ | ✗ |
| OMP (Open Memory Protocol) | ✓ | ✓ | ✗ | ✗ |
| Portable Memory (MacPaw) | ✓ | ✓ | ✗ | ✗ |
| **memshare** | **✓** | **✓** | **✓** | **✓** |

## MCP tools

The server exposes five tools to any MCP client:

| Tool | What it does |
|---|---|
| `memory_set` | Save one durable fact, choosing `private` or `shareable` for it. Routed to the approval queue in `suggest` mode. |
| `memory_get` | Recall memories by free text, tags, or most-recent. |
| `memory_suggest` | Propose memories for the user to approve later. |
| `memory_set_visibility` | Mark memories shareable or private, when the user asks in conversation. |
| `memory_list_tags` | List every tag, so the model reuses tags instead of inventing near-duplicates. |

## CLI reference

| Command | |
|---|---|
| `memshare init` | Create the store. `--name`, `--mode`, `--yes` |
| `memshare add <text>` | Add a memory. `--tags`, `--visibility`, `--expires`, `--tool` |
| `memshare list` | Show the store. `--tags`, `--visibility`, `--query`, `--from`, `--limit`, `--json`, `--all` |

`--from` matches the MCP client that wrote the memory — the name it gives in the handshake, such as `claude-code` or `cursor-vscode`. Memories added by hand are `cli`.

| `memshare recall` | Print memories as plain text, to paste into any AI tool |
| `memshare tags` | List all tags. `--rename <from> --to <to>` merges near-duplicates |
| `memshare mark [ids...]` | Promote memories to shareable, or pull them back. `--tags`, `--query`, `--shareable`, `--private` |
| `memshare review` | Approve or reject pending suggestions. `--yes`, `--clear` |
| `memshare export` | Write a bundle. `--tags`, `--for`, `--expires`, `--note`, `--out`, `--preview`, `--redact-blocked`, `--include-private`, `--no-scan` |
| `memshare preview <file>` | Inspect a bundle, import nothing |
| `memshare import <file>` | Import a bundle, item by item. `--yes`, `--visibility`, `--tag-sender`, `--allow-duplicates` |
| `memshare forget <ids...>` | Delete memories |
| `memshare prune` | Delete expired memories |
| `memshare config` | Show or change settings. `--set key=value` |
| `memshare instructions` | Print standing instructions for your assistant. `--append <file>` |
| `memshare serve` | Run the MCP server on stdio |

`--dir <path>` or `MEMSHARE_DIR` points any command at a different store — handy for keeping a separate memory profile per client, or for trying the sharing flow with yourself:

```bash
MEMSHARE_DIR=/tmp/bob memshare init
MEMSHARE_DIR=/tmp/bob memshare import bundle-a3f8c2d1.memshare.json
```

## Where it can run

The same code, four ways to run it — pick one, switch whenever:

- **Local** *(we suggest starting here)* — files on your laptop, MCP as a local process. Sharing: export a file and send it.
- **Shared folder** — Dropbox, Drive, or a git repo. Sharing: auto-sync through the folder.
- **Team server** *(planned)* — Docker on your VPS. Sharing: by username.
- **Hosted** *(planned)* — managed infra, same protocol, zero ops.

## Roadmap

- **Shipped:** CLI, MCP server, export/import bundles, PII guard, consent flow
- **Next:** a ChatGPT route — only if people ask for one. Claude Code, Cursor, Copilot and Windsurf already work; they speak MCP and need no adapter.
- **Later:** Docker deploy, remote MCP server, revocable sharing
- **Someday:** discovery and live sync

## Use as a library

```ts
import { MemoryStore, selectForExport, planImport } from "memshare-mcp";

const store = new MemoryStore();
await store.add({ content: "Team chose Postgres over MySQL", tags: ["db"] });
const { included, blocked } = await selectForExport(store, { tags: ["db"] });
```

Every adapter — the CLI, the MCP server, and any you write — goes through these exports. See [`src/index.ts`](src/index.ts).

## Why is the package called `memshare-mcp`?

Two reasons. `memshare` itself is unusable on npm — an unrelated project published it in February 2021 and unpublished it that November, and npm permanently reserves unpublished names, returning 409 for everyone including the original owner. And `-mcp` says what this actually is: an MCP server first, with a CLI for the decisions that should not be delegated to a model.

The installed command is still `memshare`. An earlier release used `memshare-cli`, which is now deprecated and points here.

## Development

```bash
npm install
npm run build
npm test
npm run check:docs   # docs and CLI must agree
```

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT © memshare contributors
