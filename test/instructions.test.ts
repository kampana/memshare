import { describe, expect, it } from "vitest";

import { ASSISTANT_INSTRUCTIONS, INSTRUCTIONS_MARKER } from "../src/instructions.js";

describe("assistant instructions", () => {
  it("starts with the marker, so --append can detect a repeat", () => {
    expect(ASSISTANT_INSTRUCTIONS.startsWith(INSTRUCTIONS_MARKER)).toBe(true);
  });

  it("names every tool the assistant is expected to call", () => {
    for (const tool of ["memory_get", "memory_set", "memory_list_tags", "memory_set_visibility"]) {
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
