import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Works out a stable tag for the project the assistant is working in.
 *
 * Tags are the whole sharing mechanism -- `export --tags project-x` only works
 * if everyone's memories carry the same tag. Left to a model, the name drifts
 * between sessions and tools ("project-x", "projectx", "proj-x"), and the drift
 * is silent: the export simply returns nothing. Deriving it from the checkout
 * gives every tool on every machine the same answer for the same repository.
 */

/** Directory names that say nothing useful about what is being worked on. */
const MEANINGLESS = new Set([
  "src",
  "lib",
  "app",
  "code",
  "work",
  "projects",
  "repos",
  "dev",
  "documents",
  "desktop",
  "downloads",
  "tmp",
  "temp",
  "home",
  "users",
  "workspace",
]);

/**
 * The git repository root containing `from`, if there is one. Walks up until
 * it finds a `.git` entry (a directory for a normal clone, a file for a
 * worktree or submodule).
 */
export function findRepoRoot(from: string = process.cwd()): string | undefined {
  let current = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Lowercase, hyphenated, safe to use as a tag. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The project tag for a working directory, or undefined when there is nothing
 * meaningful to name — running from a home directory or a filesystem root
 * should not tag every memory with someone's username.
 */
export function detectProjectTag(cwd: string = process.cwd()): string | undefined {
  const root = findRepoRoot(cwd) ?? path.resolve(cwd);

  // Never name a memory after the user or the root of the disk.
  const home = os.homedir();
  if (path.resolve(root) === path.resolve(home)) return undefined;
  if (path.dirname(root) === root) return undefined;

  const slug = slugify(path.basename(root));
  if (slug === "" || MEANINGLESS.has(slug)) return undefined;
  // A bare drive letter or a single character is not a project name.
  if (slug.length < 2) return undefined;

  return slug;
}
