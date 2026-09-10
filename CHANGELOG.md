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
