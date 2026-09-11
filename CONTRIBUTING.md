# Contributing to memshare

Thanks for wanting to help. memshare handles people's private notes about their work and their lives, so the bar for changes is "would I be comfortable if this ran on my own machine".

## Getting set up

```bash
git clone https://github.com/kampana/memshare.git
cd memshare
npm install
npm run build
npm test
```

To try your build without installing it globally:

```bash
MEMSHARE_DIR=/tmp/dev-store node dist/cli/index.js init --yes
MEMSHARE_DIR=/tmp/dev-store node dist/cli/index.js add "hello" --tags test
```

## Before you open a PR

```bash
npm run typecheck
npm test
npm run check:docs
```

## Keep the three documents in sync

The project is described in three places, and they are one set:

| File | What it is |
|---|---|
| `README.md` | What a user reads first |
| `docs/index.html` | The landing page at <https://kampana.github.io/memshare/> — what people see first. |
| `docs/pitch.html` | **The source of truth.** Published at <https://kampana.github.io/memshare/pitch.html> — when the three disagree, this one wins. |

**Change one, change all three.** A CLI flag added in code but missing from the spec, or a command promised in the deck that does not exist, is a bug — not a documentation nicety. `npm run check:docs` catches the mechanical half of this: it fails if the docs reference a `memshare` command the CLI does not register, or if version numbers drift apart. It cannot check that your prose still makes sense, so read it.

Commands that are deliberately future-facing (the team-server tier, for example) belong in `scripts/check-docs.mjs` under `PLANNED_COMMANDS`, so the check stays honest about what ships today.

## Things worth knowing

- **The store is the product.** `src/memory/` must never depend on `src/mcp/` or `src/cli/`. Adapters go through the exports in `src/index.ts`, so a future ChatGPT or Gemini adapter can be written without touching the core.
- **Preview and the real thing share one code path.** `selectForExport` and `planImport` compute what *would* happen; the CLI renders it and then acts on the same object. Never write a second, parallel implementation for the preview — it will drift, and consent based on a stale preview is not consent.
- **The PII scanner should be over-eager.** A false positive costs a keystroke in the export preview. A false negative sends someone's medical history to a colleague. When adding a pattern, add a test for what it must *not* match too — `test/redact.test.ts` has a list of ordinary technical sentences that must stay clean.
- **Nothing leaves the machine on its own.** There is no network code in this project, and there should not be any without a very explicit discussion first.
- **Imports never overwrite.** An accepted duplicate becomes a second item. The sender's phrasing is evidence in its own right.

## Bundle schema changes

`SCHEMA_VERSION` in `src/memory/types.ts` gates cross-version compatibility. Adding an optional field is a minor bump. Anything that would make an older memshare misread a newer bundle is a major bump — older clients refuse those outright, which is the intended behaviour.

## Reporting a security issue

Please do not open a public issue for anything that could expose someone's memories. Open a private security advisory on the repository instead.

> Verify deck changes against the **live URL**, not just the local file. GitHub Pages takes ~40s to redeploy and caches.

## Releasing

Publishing runs from GitHub Actions using npm trusted publishing (OIDC). There is no npm token in the repository, in CI secrets, or on anyone's laptop.

```bash
npm version patch      # or minor — bumps package.json and tags
git push && git push --tags
```

The workflow builds, typechecks, runs the tests and `check:docs`, refuses to publish if the tag does not match `package.json`, and only then publishes. Remember to bump `VERSION` in `src/cli/index.ts` and the version in `src/mcp/server.ts` too — `check:docs` fails the release if you forget.
