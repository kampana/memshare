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
