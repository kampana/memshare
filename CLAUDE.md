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
