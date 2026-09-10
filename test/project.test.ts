import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectProjectTag, findRepoRoot, slugify } from "../src/memory/project.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "memshare-proj-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("slugify", () => {
  it("makes a tag-safe name", () => {
    expect(slugify("Project X")).toBe("project-x");
    expect(slugify("my_repo.git")).toBe("my-repo-git");
    expect(slugify("  Acme--Client  ")).toBe("acme-client");
    expect(slugify("!!!")).toBe("");
  });
});

describe("findRepoRoot", () => {
  it("finds the checkout from a nested directory", async () => {
    const repo = path.join(dir, "my-app");
    const nested = path.join(repo, "src", "deep");
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(path.join(repo, ".git"));
    expect(findRepoRoot(nested)).toBe(repo);
  });

  it("treats a .git file as a checkout too (worktrees, submodules)", async () => {
    const repo = path.join(dir, "worktree-app");
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, ".git"), "gitdir: /elsewhere", "utf8");
    expect(findRepoRoot(repo)).toBe(repo);
  });

  it("returns undefined outside a repository", async () => {
    const plain = path.join(dir, "no-repo-here");
    await fs.mkdir(plain, { recursive: true });
    // The temp dir itself must not sit inside a checkout for this to hold.
    const found = findRepoRoot(plain);
    expect(found === undefined || found !== plain).toBe(true);
  });
});

describe("detectProjectTag", () => {
  it("names the memory after the repository, not the subdirectory", async () => {
    const repo = path.join(dir, "Project X");
    const nested = path.join(repo, "src", "auth");
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(path.join(repo, ".git"));
    expect(detectProjectTag(nested)).toBe("project-x");
  });

  it("falls back to the folder name when there is no repository", async () => {
    const plain = path.join(dir, "loose-notes");
    await fs.mkdir(plain, { recursive: true });
    expect(detectProjectTag(plain)).toBe("loose-notes");
  });

  it("refuses to tag every memory with the user's home directory", () => {
    expect(detectProjectTag(os.homedir())).toBeUndefined();
  });

  it("skips directory names that say nothing", async () => {
    for (const name of ["src", "work", "tmp", "workspace"]) {
      const p = path.join(dir, name);
      await fs.mkdir(p, { recursive: true });
      expect(detectProjectTag(p)).toBeUndefined();
    }
  });

  it("is stable: the same repo gives the same tag from anywhere inside it", async () => {
    const repo = path.join(dir, "stable-repo");
    const a = path.join(repo, "a");
    const b = path.join(repo, "b", "c");
    await fs.mkdir(a, { recursive: true });
    await fs.mkdir(b, { recursive: true });
    await fs.mkdir(path.join(repo, ".git"));
    expect(detectProjectTag(a)).toBe(detectProjectTag(b));
    expect(detectProjectTag(a)).toBe("stable-repo");
  });
});
