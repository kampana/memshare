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
