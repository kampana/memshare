# memshare

**Peer-to-peer AI memory sharing between users — with consent.**

[![npm](https://img.shields.io/npm/v/memshare-cli.svg)](https://www.npmjs.com/package/memshare-cli)
[![CI](https://github.com/kampana/memshare/actions/workflows/ci.yml/badge.svg)](https://github.com/kampana/memshare/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Every AI memory tool today is per-user by design. You can carry *your* memory between *your* tools — but there is no way to hand a colleague the context you have built up. memshare is the first tool that does, with a preview and an approval step on both sides.

No central server. No cloud. No signup. Your memories are plain JSON files on your own machine.

📊 **[See the pitch deck](https://kampana.github.io/memshare/pitch.html)** · 📄 **[Full spec](docs/SPEC.md)**

---

## 30-second quickstart

```bash
npm install -g memshare-cli
memshare init

# Connect it to Claude Code
claude mcp add memshare -- npx -y memshare-cli serve

# Or add it to any MCP client's config:
#   { "mcpServers": { "memshare": { "command": "npx", "args": ["-y", "memshare-cli", "serve"] } } }
```

Then talk to your AI normally. Ask it *"what do you know about me?"* and it will call `memory_get`. Tell it *"remember that I like dark mode"* and it will call `memory_set`.

Add memories yourself at any time:

```bash
memshare add "Auth service uses JWT with 15min refresh" --tags project-x,auth --visibility shareable
memshare list
memshare list --tags project-x
```

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

| Mode | What happens | Who decides |
|---|---|---|
| `auto` | The AI calls `memory_set` and it is saved silently. | The AI |
| `suggest` **(default)** | The AI calls `memory_suggest`. Nothing is stored until you run `memshare review`. | You, in batch |
| `manual` | Nothing is saved unless you say "remember this". | You, every time |

In `suggest` mode a direct `memory_set` is queued as a suggestion rather than saved — the consent step cannot be skipped by an over-eager model.

```bash
memshare review          # approve or reject, one by one
memshare review --yes    # accept everything pending
memshare review --clear  # reject everything pending
```

## Consent, on both sides

1. **You tag at creation time.** Every item is `private` (the default) or `shareable`. Private items are never exported, not even when their tags match.
2. **PII is blocked automatically.** Before anything leaves your machine, memshare scans for emails, phone numbers, government IDs, payment cards, bank details, credentials, and health or financial language. Flagged items are held back; you decide per item whether to skip them, send a redacted version, or send them as-is.
3. **You see the exact bundle first.** `--preview` runs the identical computation the real export does — there is no separate preview code path to drift out of sync.
4. **They choose too.** The recipient previews every item and accepts or rejects individually. Bundles are content-hashed, so a file edited in transit is refused, and `--expires` lets a bundle go stale on its own.

## How it compares

| | Cross-model portability | Self-hosted | User-to-user sharing | Consent flow |
|---|:---:|:---:|:---:|:---:|
| Claude / ChatGPT memory | ✗ | ✗ | ✗ | ✗ |
| Mem0 | ✓ | ✓ | ✗ | ✗ |
| OMP (Open Memory Protocol) | ✓ | ✓ | ✗ | ✗ |
| Portable Memory (MacPaw) | ✓ | ✓ | ✗ | ✗ |
| **memshare** | **✓** | **✓** | **✓** | **✓** |

## MCP tools

The server exposes four tools to any MCP client:

| Tool | What it does |
|---|---|
| `memory_set` | Save one durable fact. Routed to the approval queue in `suggest` mode. |
| `memory_get` | Recall memories by free text, tags, or most-recent. |
| `memory_suggest` | Propose memories for the user to approve later. |
| `memory_list_tags` | List every tag, so the model reuses tags instead of inventing near-duplicates. |

## CLI reference

| Command | |
|---|---|
| `memshare init` | Create the store. `--name`, `--mode`, `--yes` |
| `memshare add <text>` | Add a memory. `--tags`, `--visibility`, `--expires`, `--tool` |
| `memshare list` | Show the store. `--tags`, `--visibility`, `--query`, `--from`, `--limit`, `--json`, `--all` |
| `memshare recall` | Print memories as plain text, to paste into any AI tool |
| `memshare tags` | List all tags |
| `memshare review` | Approve or reject pending suggestions. `--yes`, `--clear` |
| `memshare export` | Write a bundle. `--tags`, `--for`, `--expires`, `--note`, `--out`, `--preview`, `--redact-blocked`, `--include-private`, `--no-scan` |
| `memshare preview <file>` | Inspect a bundle, import nothing |
| `memshare import <file>` | Import a bundle, item by item. `--yes`, `--visibility`, `--tag-sender`, `--allow-duplicates` |
| `memshare forget <ids...>` | Delete memories |
| `memshare prune` | Delete expired memories |
| `memshare config` | Show or change settings. `--set key=value` |
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

- **v0.1 — now:** CLI, MCP server, export/import bundles, PII guard
- **v0.2:** adapters for ChatGPT, Cursor, Copilot
- **v0.3:** Docker deploy, remote MCP server
- **v0.4:** discovery and live sync

## Use as a library

```ts
import { MemoryStore, selectForExport, planImport } from "memshare-cli";

const store = new MemoryStore();
await store.add({ content: "Team chose Postgres over MySQL", tags: ["db"] });
const { included, blocked } = await selectForExport(store, { tags: ["db"] });
```

Every adapter — the CLI, the MCP server, and any you write — goes through these exports. See [`src/index.ts`](src/index.ts).

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
