# End-to-end flow, with a real model

`npm run e2e`

Everything under `test/` except this directory runs offline and deterministically.
This one drives a real `claude -p` session against a real memshare MCP server,
so it needs a working Claude Code install and it costs money to run.

It exists because `test/mcp.test.ts` already proves the plumbing — export
selects the right items, import refuses to overwrite, the handshake holds — and
cannot prove the half that decides whether memshare is any use: that an
assistant *reaches for* the tools. Nothing in MCP lets a server compel a tool
call, so capture has to be measured rather than assumed.

Treat it as an eval, not a test. The subject is three strings: the tool
descriptions in `src/mcp/server.ts`, the server's `instructions`, and
`ASSISTANT_INSTRUCTIONS`. Edit any of them and the numbers here move.

## The flow

Five sessions, each a fresh conversation, against two simulated machines:

| Leg | Prompt | What must happen |
|---|---|---|
| 1 | Alice is told a fact in passing | `memory_set`, shareable, fact in the store |
| 2 | "share it with bob", then "yes, go ahead" | `memory_export` twice — preview, then confirmed — bundle written |
| 3a | "what's in this file?" | `memory_preview`, and Bob's store still empty |
| 3b | "import it", then "yes, all of them" | `memory_import` confirmed; lands `private` / `imported` |
| 4 | a question only Alice's memory answers | `memory_get`, and the fact in the reply |

A run-unique subject (`Zynthara-1a2b`) is planted in leg 1, so every later
assertion is an exact match rather than a judgement call, and nothing can be
answered from the model's prior knowledge.

Legs 2 and 3b run as two turns, because the consent gate is deliberately a
human one: told only "share this with bob", the model previews and stops to
ask. An earlier version of these legs granted consent up front in the same
sentence — "I approve sending it, you do not need to check back with me" — to
get a single-shot session past the gate. That fought the tool descriptions,
which say to show the list and *wait*, and it obeyed roughly half the time;
the other half it previewed and asked anyway, and the run failed for the model
doing exactly the right thing. Answering the question in a second turn is both
faithful and stable. Leg 3a withholds consent on purpose, which is what makes
"looking is free" testable.

## Isolation

The run must not touch the developer's own setup. Four controls, all in
`driver-claude-code.mjs` and `makeMachine`:

- **`--strict-mcp-config`** — the single most important one. Without it the
  developer's *real* memshare server is also loaded and the model under test
  can write into their actual memory.
- **A throwaway `HOME` for every memshare CLI subprocess.** `init` appends its
  standing instructions to `~/.claude/CLAUDE.md` by default, so running it under
  the real home writes into the developer's Claude config. `claude` itself is
  *not* run under a fake home — it reads its credentials from `~/.claude`.
- **`--no-session-persistence`** — nothing reaches the session history or the
  `/resume` picker.
- **Denied built-ins** (`Bash`, `Read`, `Write`, …) with `--permission-prompts none`.
  This is also an assertion-validity control: a working `Read` would let a model
  answer leg 3a by opening the bundle itself and pass without calling
  `memory_preview`. Every leg asserts that no denied tool actually ran — models
  do try, and the check reads the tool *result*, since the transcript records
  attempts either way.

Stores, homes and project directories are all temp dirs, removed at the end.
`--keep` leaves them in place for debugging.

## Options

```
--model <alias>   sonnet (default), opus, …
--reps <n>        repeat the whole flow; capture is stochastic, so a rate is
                  more informative than a single pass
--keep            leave the temp stores, homes and projects on disk
```

## Known gaps

- The instructions arrive via a real `init` append into the project's
  `CLAUDE.md`, which is the faithful path. But a developer's global
  `~/.claude/CLAUDE.md` is also auto-discovered, and if it already carries the
  memshare block there is no clean control arm — "with instructions" and
  "without" both have them. Measuring that contrast needs a driver that owns
  the whole system prompt.
- One client. The driver interface is deliberately narrow so a second one —
  the Anthropic SDK bridged to the MCP server over stdio, or Cursor — is a new
  file rather than a rewrite.
