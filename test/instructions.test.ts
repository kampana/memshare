import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ASSISTANT_INSTRUCTIONS,
  INSTRUCTIONS_MARKER,
  appendInstructionsToFile,
} from "../src/instructions.js";

describe("assistant instructions", () => {
  it("starts with the marker, so --append can detect a repeat", () => {
    expect(ASSISTANT_INSTRUCTIONS.startsWith(INSTRUCTIONS_MARKER)).toBe(true);
  });

  it("names every tool the assistant is expected to call", () => {
    for (const tool of [
      "memory_get",
      "memory_set",
      "memory_list_tags",
      "memory_set_visibility",
      "memory_forget",
    ]) {
      expect(ASSISTANT_INSTRUCTIONS).toContain(tool);
    }
  });

  it("states the visibility rule, including the tie-breaker", () => {
    expect(ASSISTANT_INSTRUCTIONS).toContain("shareable");
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/arguable[\s\S]{0,40}private/i);
  });

  it("tells the assistant not to promote things on its own", () => {
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/only call `memory_set_visibility` when/i);
  });

  it("rules out secrets outright", () => {
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/never store/i);
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/credentials/i);
  });

  it("is markdown that can be dropped into CLAUDE.md as-is", () => {
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/^## /);
    expect(ASSISTANT_INSTRUCTIONS.endsWith("\n")).toBe(true);
  });
});

describe("visibility of what it is doing", () => {
  it("asks the assistant to report saves, so a silent failure is not silent", () => {
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/tell me when you save/i);
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/noted:/i);
  });

  it("asks for an end-of-session sweep, to catch what was passed over", () => {
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/sweep before we finish/i);
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/wrapping up/i);
  });
});

describe("saving in two places at once", () => {
  it("says a fact written to another memory system is saved here as well", () => {
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/every save is a save here too/i);
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/one write\s+with two destinations/i);
  });

  it("covers the phrasings that trigger a save elsewhere, including none", () => {
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/"remember"/);
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/or none at all/i);
  });
});

describe("deleting", () => {
  it("makes memory_forget the user's call, never the assistant's", () => {
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/only call `memory_forget` when/i);
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/never on your own initiative/i);
  });
});

describe("appendInstructionsToFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "memshare-instr-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("appends to an existing file, keeping what was there", async () => {
    const file = path.join(dir, "CLAUDE.md");
    await fs.writeFile(file, "# My project\n\nSome notes.\n", "utf8");

    expect(await appendInstructionsToFile(file)).toBe("added");

    const after = await fs.readFile(file, "utf8");
    expect(after).toContain("# My project");
    expect(after).toContain(INSTRUCTIONS_MARKER);
    expect(after).toContain(ASSISTANT_INSTRUCTIONS);
  });

  it("is safe to run twice -- the second call changes nothing", async () => {
    const file = path.join(dir, "AGENTS.md");
    await fs.writeFile(file, "notes\n", "utf8");

    await appendInstructionsToFile(file);
    const afterFirst = await fs.readFile(file, "utf8");

    expect(await appendInstructionsToFile(file)).toBe("already-present");
    expect(await fs.readFile(file, "utf8")).toBe(afterFirst);
  });

  it("separates itself from a file that does not end in a newline", async () => {
    const file = path.join(dir, "CLAUDE.md");
    await fs.writeFile(file, "no trailing newline", "utf8");

    await appendInstructionsToFile(file);
    expect(await fs.readFile(file, "utf8")).toContain(`no trailing newline\n\n${INSTRUCTIONS_MARKER}`);
  });

  it("does not stack blank lines on a file that already ends in one", async () => {
    const file = path.join(dir, "CLAUDE.md");
    await fs.writeFile(file, "notes\n\n", "utf8");

    await appendInstructionsToFile(file);
    expect(await fs.readFile(file, "utf8")).toContain(`notes\n\n${INSTRUCTIONS_MARKER}`);
  });

  it("creates the file, and the directory above it, when it is missing", async () => {
    const file = path.join(dir, "nested", "CLAUDE.md");

    expect(await appendInstructionsToFile(file)).toBe("added");
    expect(await fs.readFile(file, "utf8")).toBe(ASSISTANT_INSTRUCTIONS);
  });
});
