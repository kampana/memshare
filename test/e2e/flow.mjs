/**
 * The memshare flow, end to end, with a real model in the loop.
 *
 * `test/mcp.test.ts` already proves the plumbing: export selects the right
 * items, import refuses to overwrite, the handshake holds. What it cannot
 * prove is the half that decides whether memshare is any use -- that an
 * assistant *reaches for* the tools. Capture in particular is something MCP
 * cannot compel, so it has to be measured rather than assumed.
 *
 * This is therefore an eval, not a unit test: the subject is the tool
 * descriptions in src/mcp/server.ts, the server's `instructions`, and
 * ASSISTANT_INSTRUCTIONS. Edit any of those three and the numbers here move.
 *
 * Nothing here touches the developer's own setup. Stores, homes and projects
 * are all temp directories; `--strict-mcp-config` keeps the real memshare
 * server out of the session. See driver-claude-code.mjs.
 *
 *   node test/e2e/flow.mjs [--model sonnet] [--reps 1] [--keep]
 */

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { runSession } from "./driver-claude-code.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const cliPath = path.join(repo, "dist/cli/index.js");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const MODEL = flag("model", "sonnet");
const REPS = Number(flag("reps", "1"));
const KEEP = argv.includes("--keep");

/** How the MCP server is launched -- the same command a user's config holds. */
const serveCommand = { command: process.execPath, args: [cliPath, "serve"] };

/** Everything a run creates, so it can all be deleted at the end. */
const temp = [];
const mkTemp = (label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `memshare-e2e-${label}-`));
  temp.push(dir);
  return dir;
};

/**
 * HOME is redirected for every memshare CLI subprocess, and that is a safety
 * control rather than tidiness. `init` appends its standing instructions to
 * `~/.claude/CLAUDE.md` by default (see `instructionTargets` in
 * src/cli/index.ts), so running it under the real HOME writes into the
 * developer's actual Claude config.
 *
 * `claude` itself is *not* run under a fake home -- it reads its credentials
 * from ~/.claude, so redirecting it would break auth, not isolate anything.
 */
const homeEnv = (home) => ({ HOME: home, USERPROFILE: home });

/**
 * One simulated machine: a home, a project directory with a CLAUDE.md, and a
 * memshare store. `init` runs with instruction-appending left ON, so the
 * standing instructions reach the model the way they reach a real user's --
 * written into CLAUDE.md by the installer and discovered from disk -- rather
 * than being injected by the test through --append-system-prompt.
 */
function makeMachine(name) {
  const home = mkTemp(`home-${name}`);
  const project = mkTemp(`project-${name}`);
  const store = mkTemp(`store-${name}`);

  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  // `init` appends only to instruction files that already exist -- creating one
  // in a repo that has none is deliberately not its business -- so seed it.
  fs.writeFileSync(path.join(project, "CLAUDE.md"), `# ${name}'s project\n`, "utf8");

  execFileSync(process.execPath, [cliPath, "init", "--name", name, "--yes"], {
    cwd: project,
    env: { ...process.env, ...homeEnv(home), MEMSHARE_DIR: store },
    stdio: "pipe",
  });

  return { name, home, project, store };
}

/** What is in a store, read through the CLI rather than off the files. */
function readStore(store) {
  const out = execFileSync(process.execPath, [cliPath, "list", "--json"], {
    env: { ...process.env, MEMSHARE_DIR: store },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

/** The bundles a machine has exported, newest first. */
function bundlesIn(store) {
  const dir = path.join(store, "bundles");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".memshare.json"))
    .map((f) => path.join(dir, f));
}

/**
 * A run-unique subject, so every downstream assertion is an exact match rather
 * than a judgement call -- and so nothing can be answered from the model's
 * prior knowledge or a warm cache.
 */
const subject = () => `Zynthara-${randomBytes(2).toString("hex")}`;

// ------------------------------------------------------------------ reporting

const checks = [];
let currentLeg = "";

const leg = (title) => {
  currentLeg = title;
  console.log(`\n\x1b[1m${title}\x1b[0m`);
};

const check = (label, pass, detail) => {
  checks.push({ leg: currentLeg, label, pass, detail });
  const mark = pass ? "\x1b[32m  ok\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${mark}  ${label}${detail && !pass ? `\n          ${detail}` : ""}`);
};

/**
 * Shared handling for a session that did not complete at all, plus the
 * sandbox assertion.
 *
 * The sandbox check is not housekeeping. Models do reach for Bash and Read --
 * leg 3b does it routinely -- and the whole safety story rests on those being
 * refused rather than merely discouraged. It also protects the assertions:
 * a working Read would let a model answer the preview leg by opening the
 * bundle itself, passing the check without ever calling memory_preview.
 */
function ranCleanly(res) {
  const ok = !res.error && res.exitCode === 0;
  if (!ok) {
    check(
      "the session ran",
      false,
      `exit ${res.exitCode}, ${res.error ?? ""} ${res.stderr.slice(0, 500)}\n` +
        `          result: ${JSON.stringify(res.resultEvent ?? null).slice(0, 1200)}`,
    );
  }

  const tried = res.toolCalls.filter((c) => c.refused).map((c) => c.name);
  console.log(
    `  tools: ${res.toolNames.join(", ") || "(none)"}` +
      (tried.length ? `   \x1b[2m(refused: ${[...new Set(tried)].join(", ")})\x1b[0m` : ""),
  );

  check(
    "no denied tool actually ran",
    res.escaped.length === 0,
    res.escaped.map((c) => `${c.name} ran: ${JSON.stringify(c.input).slice(0, 120)}`).join("; "),
  );
  return ok;
}

const callsTo = (res, tool) => res.toolCalls.filter((c) => c.name.endsWith(tool));

// ---------------------------------------------------------------------- legs

/**
 * Leg 1 -- Alice is told something in passing and should save it herself.
 *
 * The fact is phrased as team knowledge on purpose. An earlier version used a
 * bare service name with no context, and the model reasonably filed it
 * `private` under the instructions' own "when it is arguable, choose private"
 * tie-breaker -- which then left leg 2 with nothing shareable to export.
 * Whether that tie-breaker fires correctly on genuinely ambiguous facts is a
 * separate question and deserves its own measurement, not a pass/fail here.
 */
async function legOne(alice, token) {
  leg("Leg 1 — Alice saves");
  const res = await runSession({
    prompt:
      `Quick note for the team: our ${token} service authenticates to Kafka over mTLS. ` +
      `Everyone working on the platform needs to know that.`,
    storeDir: alice.store,
    projectDir: alice.project,
    serveCommand,
    model: MODEL,
  });
  if (!ranCleanly(res)) return res;

  const set = callsTo(res, "memory_set")[0];
  check("memory_set was called unprompted", Boolean(set), `saw: ${res.toolNames.join(", ")}`);
  check(
    "the saved content carries the fact",
    Boolean(set) && String(set.input.content ?? "").includes(token),
    set ? `content: ${JSON.stringify(set.input.content)}` : "no memory_set call",
  );
  check(
    "team knowledge was saved shareable",
    set?.input?.visibility === "shareable",
    set ? `visibility: ${set.input.visibility}` : "no memory_set call",
  );

  // The tool call is intent; the store is outcome. Assert both -- a call that
  // fails server-side still appears in the transcript.
  const stored = readStore(alice.store);
  check(
    "the item is really in Alice's store",
    stored.some((i) => String(i.content).includes(token)),
    `store holds ${stored.length} item(s)`,
  );
  return res;
}

/**
 * Leg 2 -- Alice shares with Bob.
 *
 * The assertion that matters is the handshake: the first `memory_export` must
 * change nothing, and only a second call carrying `confirmed` may write. That
 * is the consent design, so it is asserted directly rather than inferred from
 * the file appearing.
 *
 * Consent is given in a second turn, not smuggled into the first. Told only
 * "share this with bob" the model previews and stops to ask -- that is the
 * design working, and an earlier version of this leg tried to talk it out of
 * that by approving up front in the same sentence. It obeyed about half the
 * time; the other half it previewed and asked anyway, and correct behaviour
 * was scored as a failure. Answering the question is both faithful and stable.
 */
async function legTwo(alice, token) {
  leg("Leg 2 — Alice exports for Bob");
  const res = await runSession({
    turns: [
      `Share what you know about ${token} with my colleague bob.`,
      `Yes, that list is right — go ahead and write the bundle.`,
    ],
    storeDir: alice.store,
    projectDir: alice.project,
    serveCommand,
    model: MODEL,
  });
  if (!ranCleanly(res)) return { res, bundle: null };

  const exports = callsTo(res, "memory_export");
  check("memory_export was called", exports.length > 0, `saw: ${res.toolNames.join(", ")}`);
  check(
    "the first export call was a preview, not a write",
    exports.length > 0 && exports[0].input.confirmed !== true,
    exports.length > 0
      ? `first call confirmed: ${exports[0].input.confirmed}`
      : "no memory_export call",
  );
  check(
    "a second call confirmed it",
    exports.some((c) => c.input.confirmed === true),
    `${exports.length} export call(s)`,
  );

  const bundles = bundlesIn(alice.store);
  check("a bundle was written", bundles.length === 1, `found ${bundles.length}`);

  const bundle = bundles[0] ?? null;
  const body = bundle ? fs.readFileSync(bundle, "utf8") : "";
  check("the bundle carries the fact", body.includes(token), bundle ? "token absent" : "no bundle");
  return { res, bundle };
}

/**
 * Leg 3a -- Bob looks inside without taking anything.
 *
 * "Looking is free" is a design commitment, so the assertion is on Bob's store
 * still being empty afterwards. Read/Bash are denied in the driver, which is
 * what stops the model answering this by opening the file itself and passing
 * the check without ever calling the tool.
 */
async function legThreePreview(bob, bundle, token) {
  leg("Leg 3a — Bob previews, stores nothing");
  const res = await runSession({
    prompt: `A colleague sent me this file: ${bundle}. What is in it?`,
    storeDir: bob.store,
    projectDir: bob.project,
    serveCommand,
    model: MODEL,
  });
  if (!ranCleanly(res)) return res;

  check(
    "memory_preview was called",
    callsTo(res, "memory_preview").length > 0,
    `saw: ${res.toolNames.join(", ")}`,
  );
  check("the preview described the fact", res.text.includes(token), res.text.slice(0, 200));

  const stored = readStore(bob.store);
  check("Bob's store is still empty", stored.length === 0, `store holds ${stored.length} item(s)`);
  return res;
}

/**
 * Leg 3b -- Bob takes it in. Imports are never overwrites and land private.
 *
 * Consent is answered in a second turn for the same reason as leg 2. Note the
 * contrast with leg 3a, which withholds it: there, nothing may be stored.
 */
async function legThreeImport(bob, bundle, token) {
  leg("Leg 3b — Bob imports");
  const res = await runSession({
    turns: [
      `Please import the memories in ${bundle} into my memory.`,
      `Yes, all of them — go ahead.`,
    ],
    storeDir: bob.store,
    projectDir: bob.project,
    serveCommand,
    model: MODEL,
  });
  if (!ranCleanly(res)) return res;

  const imports = callsTo(res, "memory_import");
  check("memory_import was called", imports.length > 0, `saw: ${res.toolNames.join(", ")}`);
  check(
    "it confirmed before writing",
    imports.some((c) => c.input.confirmed === true),
    `${imports.length} import call(s)`,
  );

  const stored = readStore(bob.store);
  const item = stored.find((i) => String(i.content).includes(token));
  check("the fact is in Bob's store", Boolean(item), `store holds ${stored.length} item(s)`);
  check(
    "imports land private",
    item?.visibility === "private",
    item ? `visibility: ${item.visibility}` : "item missing",
  );
  check(
    "imports are marked as imported",
    item?.confidence === "imported",
    item ? `confidence: ${item.confidence}` : "item missing",
  );
  return res;
}

/**
 * Leg 4 -- the payoff. A fresh conversation on Bob's machine, asked a question
 * only Alice's memory can answer. This is the whole product in one assertion.
 */
async function legFour(bob, token) {
  leg("Leg 4 — Bob recalls it in a new conversation");
  const res = await runSession({
    prompt: `How does ${token} authenticate to Kafka?`,
    storeDir: bob.store,
    projectDir: bob.project,
    serveCommand,
    model: MODEL,
  });
  if (!ranCleanly(res)) return res;

  const gets = callsTo(res, "memory_get");
  check("memory_get was called before answering", gets.length > 0, `saw: ${res.toolNames.join(", ")}`);

  // The query the model chose is the first thing worth knowing when this leg
  // fails: a recall bug and a model that simply did not search look identical
  // from the answer alone.
  const queries = gets.map((g) => JSON.stringify(g.input.query ?? null)).join(", ");
  if (gets.length > 0) console.log(`  \x1b[2mqueries: ${queries}\x1b[0m`);

  check(
    "the answer contains the imported fact",
    /mTLS/i.test(res.text),
    `queries: ${queries}\n          answer: ${res.text.slice(0, 200)}`,
  );
  return res;
}

// ---------------------------------------------------------------------- main

async function runFlow() {
  const token = subject();
  const alice = makeMachine("alice");
  const bob = makeMachine("bob");
  console.log(`\nsubject: ${token}`);

  const results = [];
  results.push(await legOne(alice, token));

  const { res: two, bundle } = await legTwo(alice, token);
  results.push(two);

  if (bundle) {
    results.push(await legThreePreview(bob, bundle, token));
    results.push(await legThreeImport(bob, bundle, token));
    results.push(await legFour(bob, token));
  } else {
    leg("Legs 3–4 — skipped");
    check("a bundle existed to carry forward", false, "leg 2 produced none");
  }

  return results.reduce((sum, r) => sum + (r?.costUsd ?? 0), 0);
}

async function main() {
  if (!fs.existsSync(cliPath)) {
    console.error("dist/ is missing — run `npm run build` first.");
    process.exit(2);
  }

  console.log(`model: ${MODEL}   reps: ${REPS}`);
  console.log("stores, homes and projects are temp dirs; your own setup is untouched");

  let cost = 0;
  for (let rep = 0; rep < REPS; rep++) {
    if (REPS > 1) console.log(`\n\x1b[2m── rep ${rep + 1}/${REPS} ──\x1b[0m`);
    cost += await runFlow();
  }

  if (KEEP) console.log(`\nkept:\n  ${temp.join("\n  ")}`);
  else for (const d of temp) fs.rmSync(d, { recursive: true, force: true });

  const failed = checks.filter((c) => !c.pass);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed` +
      (cost ? `   ~$${cost.toFixed(4)}` : ""),
  );
  for (const f of failed) console.log(`  \x1b[31m✗\x1b[0m ${f.leg} — ${f.label}`);

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
