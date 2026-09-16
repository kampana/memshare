/**
 * Drives a real Claude Code session against a real memshare MCP server.
 *
 * The point of this driver is that it is not a simulation: `claude -p` is the
 * client memshare's users actually run, so it exercises the parts an in-process
 * test cannot -- whether the client forwards the server's `instructions`, how
 * the tool descriptions read once the harness has rendered them, and whether a
 * model reaches for the tools unprompted.
 *
 * Every invocation is sandboxed away from the developer's own setup. See
 * `isolationArgs` -- that list is a safety control, not a style choice.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Every tool the memshare server exposes, as the harness namespaces them. */
const MEMSHARE_TOOLS = [
  "memory_set",
  "memory_get",
  "memory_suggest",
  "memory_set_visibility",
  "memory_forget",
  "memory_export",
  "memory_import",
  "memory_stats",
  "memory_preview",
  "memory_list_tags",
];

/**
 * Built-in tools the session must not have.
 *
 * Two reasons, and the second is the one that is easy to forget: it keeps the
 * run from touching anything of the developer's, *and* it stops the model
 * satisfying a prompt some other way. Leave `Read` enabled and the import leg
 * will happily read the bundle off disk and describe it without ever calling
 * `memory_preview` -- the assertion passes for the wrong reason.
 */
const DENIED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  // Noise rather than risk: it has nothing to do with memshare and only costs
  // a turn. `ToolSearch` is deliberately left alone -- the harness defers MCP
  // tools and uses it to find them, so denying it would hide the tools under
  // test rather than tighten the run.
  "ListAgents",
];

/** Finds the claude binary without depending on shell resolution. */
export function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;

  const candidates =
    process.platform === "win32"
      ? [
          path.join(
            os.homedir(),
            "AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
          ),
        ]
      : [
          "/usr/local/bin/claude",
          path.join(os.homedir(), ".local/bin/claude"),
          path.join(os.homedir(), ".claude/local/claude"),
        ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Last resort: let the OS resolve it. Works on POSIX; on Windows the shim is
  // a .cmd that Node refuses to spawn without a shell, hence the path above.
  return "claude";
}

/**
 * The flags that keep a run from touching the developer's own Claude Code
 * state or memshare store. Changing any of these is a safety decision.
 */
function isolationArgs() {
  return [
    // Without this the developer's *real* memshare server is also loaded, and
    // the model under test can write into their actual memory. This one flag
    // is the difference between a test and an accident.
    "--strict-mcp-config",
    // Keeps the run out of ~/.claude session history and the /resume picker.
    "--no-session-persistence",
    // Anything that would prompt is denied outright rather than hanging.
    "--permission-prompts",
    "none",
  ];
}

/**
 * Runs one fresh conversation -- `prompt` for a single turn, or `turns` for an
 * exchange.
 *
 * `turns` exists because of the consent gate. `memory_export`'s description
 * tells the model to show the preview and *wait*, and in a single-shot session
 * waiting means ending the turn -- so a leg that needs the confirmed call has
 * no way to reach it except by talking the model out of the behaviour the tool
 * is designed to have. Consent granted up front in the first prompt does that
 * unreliably: the model is as likely to preview and stop anyway, which is
 * correct behaviour scored as a failure. A second turn is how a user actually
 * answers, so that is what the driver sends.
 *
 * Turns are fed over `--input-format stream-json`, one message at a time, each
 * sent only once the previous turn's `result` event has arrived. It stays one
 * process and one conversation, so `--no-session-persistence` still holds --
 * resuming by session id would have meant writing the run into ~/.claude.
 *
 * Returns what the assertions actually care about -- which tools were called,
 * across every turn, in order, with what arguments -- plus the final text and
 * what it cost.
 */
export async function runSession({
  prompt,
  turns,
  storeDir,
  serveCommand,
  projectDir,
  appendSystemPrompt,
  model = "sonnet",
  budgetUsd = 0.5,
  timeoutMs = 240_000,
}) {
  const messages = turns ?? [prompt];
  const multiTurn = messages.length > 1;
  // The cwd is the fake project: it holds the CLAUDE.md that `memshare init`
  // appended to, so the model picks the instructions up the way a real user's
  // would arrive -- discovered from disk, not injected by the test. It is also
  // a throwaway, so the harness's auto-memory keys to a directory that does
  // not exist tomorrow.
  const cwd = projectDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "memshare-e2e-cwd-"));
  const ownsCwd = !projectDir;

  const mcpConfig = JSON.stringify({
    mcpServers: {
      memshare: {
        command: serveCommand.command,
        args: serveCommand.args,
        env: { MEMSHARE_DIR: storeDir },
      },
    },
  });

  const args = [
    "--print",
    // A multi-turn run takes its messages on stdin instead, so there is no
    // prompt argument to give.
    ...(multiTurn ? ["--input-format", "stream-json"] : [messages[0]]),
    "--model",
    model,
    "--mcp-config",
    mcpConfig,
    ...isolationArgs(),
    "--allowedTools",
    ["mcp__memshare", ...MEMSHARE_TOOLS.map((t) => `mcp__memshare__${t}`)].join(","),
    "--disallowedTools",
    DENIED_TOOLS.join(","),
    "--max-budget-usd",
    String(budgetUsd),
    "--output-format",
    "stream-json",
    "--verbose",
  ];

  if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);

  const started = Date.now();
  // Note: HOME is deliberately *not* redirected here, unlike the memshare CLI
  // subprocesses. `claude` reads its own credentials from ~/.claude, so a fake
  // home would break authentication rather than isolate anything. Isolation for
  // this process comes from --strict-mcp-config and the throwaway cwd.
  const child = spawn(resolveClaudeBin(), args, {
    cwd,
    env: { ...process.env, MEMSHARE_DIR: storeDir },
    stdio: [multiTurn ? "pipe" : "ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  if (multiTurn) {
    let sent = 0;
    const sendNext = () => {
      child.stdin.write(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: messages[sent++] }] },
        }) + "\n",
      );
    };

    // Turns are separated by `result` events, so the stream has to be read as
    // it arrives rather than parsed once at the end -- the next message cannot
    // be sent until the previous turn is actually over.
    let partial = "";
    child.stdout.on("data", (d) => {
      const chunk = String(d);
      stdout += chunk;
      partial += chunk;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (event.type !== "result") continue;
        if (sent < messages.length) sendNext();
        else child.stdin.end();
      }
    });

    child.stdin.on("error", () => {}); // the child may exit first; not our failure
    sendNext();
  } else {
    child.stdout.on("data", (d) => (stdout += d));
  }

  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => clearTimeout(timer));

  if (ownsCwd) fs.rmSync(cwd, { recursive: true, force: true });

  return { ...parseStream(stdout), exitCode: code, stderr, ms: Date.now() - started };
}

/**
 * Pulls the tool calls out of the stream-json transcript.
 *
 * Tool inputs are parsed JSON by the time they reach here, but the harness may
 * escape strings differently than you would write them -- so assertions match
 * on parsed fields, never on the serialised input.
 */
function parseStream(stdout) {
  const toolCalls = [];
  const texts = [];
  // tool_use_id -> what came back, so a call can be told apart from a call the
  // permission layer refused. The transcript records what the model *tried*,
  // which is not the same as what it was allowed to do.
  const results = new Map();
  let finalText = "";
  let costUsd = null;
  let error = null;
  let resultEvent = null;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // a partial line; the next one carries the whole object
    }

    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use") {
          toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} });
        } else if (block.type === "text" && block.text) {
          texts.push(block.text);
        }
      }
    } else if (event.type === "user") {
      for (const block of event.message?.content ?? []) {
        if (block.type !== "tool_result") continue;
        const body =
          typeof block.content === "string"
            ? block.content
            : (block.content ?? []).map((c) => c.text ?? "").join("\n");
        results.set(block.tool_use_id, { isError: Boolean(block.is_error), body });
      }
    } else if (event.type === "result") {
      resultEvent = event;
      finalText = typeof event.result === "string" ? event.result : "";
      costUsd = event.total_cost_usd ?? null;
      if (event.is_error) error = event.subtype ?? "error";
    }
  }

  for (const call of toolCalls) {
    const r = results.get(call.id);
    call.result = r ?? null;
    // A denied call comes back as an error rather than never appearing, so
    // "was it refused" has to be read off the result, not the call. The
    // refusal wording is not stable enough to match on -- an errored result
    // for a tool that is not on the menu is the refusal.
    call.refused = DENIED_TOOLS.includes(call.name) && Boolean(r?.isError);
  }

  return {
    toolCalls,
    /** Denied-list tools the model tried and was actually allowed to run. */
    escaped: toolCalls.filter(
      (c) => DENIED_TOOLS.includes(c.name) && !c.refused && !c.result?.isError,
    ),
    // `memory_set` rather than `mcp__memshare__memory_set`, so assertions read
    // the way the tool is named in the source.
    toolNames: toolCalls.map((c) => c.name.replace(/^mcp__memshare__/, "")),
    text: finalText || texts.join("\n"),
    costUsd,
    error,
    // The whole `result` event, kept only so a failure can say *why* the
    // session ended badly. `exit 1, success` on its own is not a diagnosis.
    resultEvent,
  };
}
