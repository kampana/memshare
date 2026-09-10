# memshare — Full Build Spec

## What is this?

memshare is an open-source tool for peer-to-peer AI memory sharing between users, with consent. No existing tool does this — all current AI memory tools (Mem0, OMP, Portable Memory, Letta) are per-user only. memshare is the first to enable selective memory sharing between different people, with preview and approval on both sides.

## Core Architecture

```
~/.memshare/memories/*.json    ← the actual product (local JSON files)
        ↑           ↑
    MCP server    CLI tool    ChatGPT adapter    (future)
        ↑
  Claude / Cursor / VS Code
```

The memory store is plain JSON files on the user's machine. The MCP server is just one adapter — if MCP dies tomorrow, the data is still there. The CLI is another adapter. Future adapters (ChatGPT, Gemini) would read/write the same files.

**No central server. No cloud. No signup.** Each user runs memshare locally. Sharing happens via exported bundle files sent however the user wants (email, Slack, AirDrop).

## Tech Stack

- **Language:** TypeScript (Node.js)
- **MCP SDK:** @modelcontextprotocol/sdk
- **CLI framework:** commander
- **Interactive prompts:** inquirer (for import preview/approval)
- **Validation:** zod
- **Storage:** Plain JSON files in ~/.memshare/
- **Package manager:** npm, published as `memshare` on npmjs

## Directory Structure

```
memshare/
├── README.md
├── LICENSE (MIT)
├── package.json
├── tsconfig.json
├── .gitignore
├── src/
│   ├── memory/
│   │   ├── types.ts        # Zod schemas: MemoryItem, MemoryBundle, etc.
│   │   ├── store.ts        # Read/write/query ~/.memshare/memories/
│   │   └── redact.ts       # PII auto-redaction before export
│   ├── sharing/
│   │   ├── export.ts       # Export bundle with consent flow
│   │   ├── import.ts       # Import bundle with preview/approval
│   │   └── bundle.ts       # Bundle format, hashing, validation
│   ├── mcp/
│   │   └── server.ts       # MCP server exposing tools to Claude
│   └── cli/
│       └── index.ts        # CLI entry point (memshare init/list/export/import/serve)
└── test/
    ├── store.test.ts
    ├── export.test.ts
    └── import.test.ts
```

## Data Schema

### MemoryItem (single fact stored locally)

```typescript
{
  id: string (uuid),
  content: string,              // "Auth service uses JWT with 15min refresh"
  tags: string[],               // ["project-x", "auth"]
  source: {
    tool: string,               // "claude", "chatgpt", "user-manual"
    sessionId?: string,
    timestamp: string (ISO)
  },
  confidence: "stated" | "inferred" | "imported",
  visibility: "private" | "shareable",   // default: "private"
  createdAt: string (ISO),
  updatedAt: string (ISO),
  expiresAt?: string (ISO)
}
```

### MemoryBundle (exported file for sharing)

```typescript
{
  metadata: {
    bundleId: string (uuid),
    exportedBy: string,         // display name, not real identity
    exportedAt: string (ISO),
    description?: string,
    schemaVersion: "0.1.0",
    contentHash: string (SHA-256 of items array),
    expiresAt?: string (ISO)
  },
  items: MemoryItem[]           // only items that passed consent + redaction
}
```

## File Storage Layout

```
~/.memshare/
├── config.json                 # user settings (mode, default_visibility, etc.)
├── memories/
│   ├── mem_<uuid>.json         # one file per memory item
│   └── ...
└── bundles/
    ├── bundle_<uuid>.json      # exported bundles (for reference)
    └── ...
```

## config.json

```json
{
  "displayName": "Alice",
  "mode": "suggest",            // "auto" | "suggest" | "manual"
  "defaultVisibility": "private",
  "autoRedactPII": true,
  "memoryDir": "~/.memshare"
}
```

## MCP Server Tools (what Claude sees)

The MCP server exposes these tools:

### memory_set
Save a memory item. Claude calls this when it decides something is worth remembering.
```
Input: { content: string, tags: string[], visibility?: "private" | "shareable" }
Output: { id: string, saved: true }
```

### memory_get
Retrieve memories by query or tags. Claude calls this at the start of conversations to get relevant context.
```
Input: { query?: string, tags?: string[], limit?: number }
Output: { items: MemoryItem[] }
```

### memory_suggest
Suggest memories to save (for "suggest" mode). Returns suggestions for user approval.
```
Input: { suggestions: Array<{ content: string, tags: string[] }> }
Output: { suggested: true, count: number }
```
Note: In suggest mode, Claude calls this instead of memory_set. The suggestions are shown to the user who approves/rejects each one.

### memory_list_tags
List all unique tags in the memory store. Useful for Claude to understand what topics exist.
```
Input: {}
Output: { tags: string[] }
```

## CLI Commands

### memshare init
Creates ~/.memshare/ directory, config.json with defaults, and empty memories/ folder.
Interactive: asks for display name and preferred mode.

### memshare serve
Starts the MCP server (stdio transport). This is what Claude connects to.
Usage: `claude mcp add memshare -- npx -y memshare-cli serve`

### memshare list
Shows all memory items in a table format.
Flags: --tags "tag1,tag2" (filter), --visibility private|shareable, --json (raw output)

### memshare add
Manually add a memory item.
Usage: `memshare add "Auth uses JWT" --tags "project-x,auth" --visibility shareable`

### memshare export
Export selected memories as a bundle.
Flags: --tags "tag1,tag2", --for "recipient_name", --expires "7d", --preview (dry run)
Flow:
1. Filter items by tags + visibility (only "shareable" items)
2. Run PII redaction
3. Show preview to user
4. On approval, write bundle file

### memshare import
Import a bundle from another user.
Usage: `memshare import bundle-file.json`
Flow:
1. Validate bundle (schema, hash integrity)
2. Show interactive preview — each item with accept/reject
3. Merge accepted items into local store (dedup by content hash)
4. Mark imported items with confidence: "imported"

### memshare preview
Preview a bundle without importing.
Usage: `memshare preview bundle-file.json`

## PII Redaction (src/memory/redact.ts)

Before export, auto-scan for sensitive patterns:
- Email addresses (regex)
- Phone numbers (regex) 
- Government IDs / SSN patterns (regex)
- Health-related keywords (keyword list)
- Financial info (credit card patterns, bank account patterns)

Items containing PII are flagged and blocked from export by default. User can override per-item in the preview step.

## How Memory Population Works (3 modes)

### Auto mode
Claude calls memory_set() directly. Items are saved silently. Fast but less control.

### Suggest mode (DEFAULT)
Claude calls memory_suggest() with a list of things it thinks are worth saving. The CLI shows them to the user interactively:
```
Claude suggests saving 3 items:
  1. "Auth service uses JWT with 15min refresh" → tags: project-x, auth
  2. "Team decided Postgres over MySQL" → tags: project-x, db  
  3. "You prefer functional style over OOP" → tags: preferences
Save all? Save some? Skip? 
```
User picks which to save.

### Manual mode
Nothing is saved unless user explicitly says "save this to memory" or "remember this". Claude then calls memory_set().

## Testing Plan

After building, test with this exact flow:

### Test 1: Basic memory operations
```bash
memshare init
memshare add "I prefer TypeScript over JavaScript" --tags "preferences" --visibility shareable
memshare add "Project X uses PostgreSQL" --tags "project-x,db" --visibility shareable
memshare add "My salary is 50000" --tags "personal,financial" --visibility private
memshare list
memshare list --tags "project-x"
```
Expected: list shows all 3 items, filtered list shows only the project-x item.

### Test 2: Export with consent
```bash
memshare export --tags "project-x,preferences" --for "bob" --preview
```
Expected: shows 2 shareable items (TypeScript preference + PostgreSQL), blocks the salary item (private).

```bash
memshare export --tags "project-x,preferences" --for "bob"
```
Expected: creates a bundle JSON file.

### Test 3: Import with preview
```bash
# Simulate Bob's side
MEMSHARE_DIR=/tmp/bob-memshare memshare init
MEMSHARE_DIR=/tmp/bob-memshare memshare import <bundle-file>
```
Expected: shows interactive preview, Bob can accept/reject per item. Accepted items appear in Bob's store with confidence: "imported".

### Test 4: MCP server with Claude
```bash
claude mcp add memshare -- npx -y memshare-cli serve
# Then in Claude: "What do you know about me from memory?"
# Claude should call memory_get and find the stored items
# Then: "Remember that I like dark mode in all my apps"
# Claude should call memory_set
# Then: memshare list — should show the new item
```

### Test 5: PII redaction
```bash
memshare add "Contact me at alice@email.com or 054-1234567" --tags "contact" --visibility shareable
memshare export --tags "contact" --preview
```
Expected: export preview flags this item as containing PII (email + phone) and blocks it.

## What to build first (priority order)

1. **types.ts** — Zod schemas (foundation for everything)
2. **store.ts** — Read/write/query local JSON files
3. **cli/index.ts** — `init`, `add`, `list` commands (so we can test manually)
4. **redact.ts** — PII detection
5. **export.ts + bundle.ts** — Export with consent flow
6. **import.ts** — Import with preview
7. **mcp/server.ts** — MCP server exposing tools
8. Tests

## README should include

- One-liner: "Peer-to-peer AI memory sharing between users — with consent."
- 30-second quickstart (install, init, connect to Claude)
- The architecture diagram (memory store → adapters)
- Comparison table vs Mem0/OMP/Portable Memory
- The 3 modes explanation (auto/suggest/manual)
- License: MIT

---

# As built — v0.1.0

This section records where the shipped implementation differs from the draft above. The draft is kept intact as the design record; where the two disagree, **this section is authoritative**.

## Additions

**`memshare review`** — the draft describes suggest mode as the default but does not say how the user acts on suggestions. Pending suggestions are stored in `~/.memshare/suggestions.json` and reviewed with:

```
memshare review          # approve or reject, one by one
memshare review --yes    # accept everything pending
memshare review --clear  # reject everything pending
```

In suggest mode, a `memory_set` call from the MCP server is **queued as a suggestion rather than saved**. An over-eager model cannot route around the consent step.

**`memshare recall`** — prints memories as plain text for pasting into any AI tool that has no MCP support.

**`memshare forget <ids...>`, `memshare prune`, `memshare tags`, `memshare config`** — deletion, expiry cleanup, tag listing, and settings.

**`--dir <path>`** — a global flag equivalent to `MEMSHARE_DIR`.

**`MemoryItem.importedFrom`** — an optional provenance record set on imported items:

```typescript
importedFrom?: {
  bundleId: string,
  exportedBy: string,
  importedAt: string (ISO),
  originalId?: string     // the id it had in the sender's store
}
```

Optional, so bundles from a client that does not write it still validate.

**`BundleMetadata.exportedFor`** — records who a bundle was prepared for (`--for`).

## Clarifications

- **Bundle filenames** are `bundle-<8 hex>.memshare.json`, matching the pitch deck.
- **Imported items are stored `private`** regardless of how the sender marked them. Receiving something is not consent to pass it on; re-sharing is a fresh decision.
- **Imports never overwrite.** An accepted duplicate is saved as a second item and gets a new local id — the sender's phrasing is evidence in its own right. Duplicates are detected by a normalised content hash (trimmed, whitespace-collapsed, lowercased) and are shown unchecked in the import preview.
- **`contentHash`** is SHA-256 over a canonical serialisation of the `items` array — object keys sorted, no incidental whitespace — so two people hashing the same items always agree. A bundle edited in transit fails validation and is refused.
- **Bundle validation order:** schema → content hash → schema version → expiry. A bundle from a newer *major* schema is refused rather than partially read.
- **Expiry** applies at both levels: `MemoryItem.expiresAt` hides and prunes an item locally, `BundleMetadata.expiresAt` makes the recipient refuse the whole bundle.
- **PII is blocked, not silently dropped.** Flagged items are held back from export and the user chooses per item: skip, send redacted, or send as-is. `--redact-blocked` chooses "redacted" for all of them non-interactively; without a terminal the default is to skip.
- **PII detection covers** email, phone, government ID (including label-anchored matches such as `passport number ...`), payment cards (Luhn-checked), IBAN and labelled bank details, credentials and API keys, plus health and financial keyword lists. Overlapping matches resolve to the highest-confidence category, so a card number is not also reported as a phone number.
- **Non-interactive use:** every command that would prompt accepts `--yes`, and fails with an explanatory message rather than hanging when stdin is not a terminal.

## Tech stack, as shipped

- `@inquirer/prompts` rather than the legacy `inquirer` default export — same project, current API.
- `vitest` for tests (the draft did not name a runner).
- TypeScript compiled to ESM, Node 18.17+.

## Not in v0.1.0

The team-server tier from the pitch deck — `memshare share --with`, `memshare inbox`, `memshare accept` — is future work. See the roadmap in the README.

## npm package name

Published as **`memshare-cli`**, not `memshare`. The name `memshare` was published by an unrelated project in 2021 and unpublished that November; npm permanently reserves unpublished names, so the registry refuses it with a 409 for everyone, the original owner included.

The installed binary is still `memshare` — only the install line differs:

```
npm install -g memshare-cli
claude mcp add memshare -- npx -y memshare-cli serve
```
