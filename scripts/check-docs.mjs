#!/usr/bin/env node
/**
 * Keeps the published docs honest about what the CLI actually does.
 *
 * It checks mechanical things only:
 *   1. every `memshare <command>` the docs invoke is a command the CLI
 *      registers (or is listed below as deliberately future-facing);
 *   2. every install and npx line names the real npm package;
 *   3. the version is the same in package.json, the CLI and the MCP server;
 *   4. the deck's roadmap marks the version that is actually shipped.
 *
 * It cannot tell you whether a sentence describing behaviour is still true.
 * That has drifted before and only reading catches it.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

/** Commands the deck promises for a tier that has not shipped yet. */
const PLANNED_COMMANDS = new Set(["share", "inbox", "accept"]);

/**
 * Published documents only. The full design spec is kept outside the repo on
 * purpose, so it is deliberately not listed here.
 */
const DOCS = ["README.md", "docs/pitch.html", "docs/index.html", "CONTRIBUTING.md"];

/**
 * Only look inside code: fenced blocks and inline spans in Markdown, and
 * code blocks in HTML. Prose says "memshare handles your notes", which is
 * not a command invocation.
 */
function codeFrom(doc, text) {
  if (doc.endsWith(".html")) {
    // The deck wraps commands in .code-block divs; the landing page uses
    // <pre> and inline <code>. Both are places a reader copies from.
    const blocks = [
      ...text.matchAll(/<div class="code-block"[^>]*>([\s\S]*?)<\/div>/g),
      ...text.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g),
      ...text.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g),
    ];
    return blocks.map((m) => m[1].replace(/<[^>]+>/g, " ")).join("\n");
  }
  const fenced = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const inline = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  return [...fenced, ...inline].join("\n");
}

const problems = [];

// ---------------------------------------------------------------- commands

const cliSource = read("src/cli/index.ts");
const registered = new Set(
  [...cliSource.matchAll(/\.command\("([a-z-]+)"\)/g)].map((m) => m[1]),
);
for (const alias of cliSource.matchAll(/\.alias\("([a-z-]+)"\)/g)) registered.add(alias[1]);

if (registered.size === 0) {
  problems.push("Could not find any commands in src/cli/index.ts - has the CLI moved?");
}

// Same line only: a `memshare` at the end of one line followed by an unrelated
// word on the next is not an invocation.
const INVOCATION = /(?:^|[\s(])memshare[ \t]+([a-z][a-z-]*)/gm;

for (const doc of DOCS) {
  const code = codeFrom(doc, read(doc));
  for (const match of code.matchAll(INVOCATION)) {
    const command = match[1];
    if (registered.has(command)) continue;
    if (PLANNED_COMMANDS.has(command)) continue;
    problems.push(
      `${doc}: invokes \`memshare ${command}\`, which the CLI does not register. ` +
        `Either implement it, fix the docs, or add it to PLANNED_COMMANDS.`,
    );
  }
}

// ------------------------------------------------------------ package name
//
// The command is `memshare`, but the npm package is not. Every install and
// npx line has to name the package, and those are the lines readers copy.

const pkg = JSON.parse(read("package.json"));
const pkgName = pkg.name;

// Same line only, and skip any flags before the package name. A bare
// `npm install` with no argument installs dependencies and names nothing.
const INSTALL_LINES = [
  { re: /npx[ \t]+(?:-{1,2}[a-zA-Z-]+[ \t]+)*([@a-z0-9][\w@/.-]*)/gm, what: "npx" },
  {
    re: /npm[ \t]+(?:install|i)[ \t]+(?:-{1,2}[a-zA-Z-]+[ \t]+)*([@a-z0-9][\w@/.-]*)/gm,
    what: "npm install",
  },
];

for (const doc of DOCS) {
  const code = codeFrom(doc, read(doc));
  for (const { re, what } of INSTALL_LINES) {
    for (const match of code.matchAll(re)) {
      const named = match[1];
      if (named === pkgName) continue;
      if (named.startsWith(`${pkgName}@`)) continue; // pinned version
      problems.push(
        `${doc}: a ${what} line names "${named}", but the package is "${pkgName}". ` +
          `Readers copy these lines verbatim.`,
      );
    }
  }
}

// Every shipped command should be findable in the README's reference table.
const readme = read("README.md");
for (const command of registered) {
  if (command === "ls") continue; // alias, documented alongside `list`
  if (!readme.includes(`memshare ${command}`)) {
    problems.push(`README.md: does not document the \`${command}\` command.`);
  }
}

// ---------------------------------------------------------------- versions

const versions = {
  "package.json": pkg.version,
  "src/cli/index.ts": cliSource.match(/const VERSION = "([^"]+)"/)?.[1],
  "src/mcp/server.ts": read("src/mcp/server.ts").match(/version: "([^"]+)"/)?.[1],
};
for (const [file, version] of Object.entries(versions)) {
  if (version !== pkg.version) {
    problems.push(`${file}: version is ${version ?? "missing"}, expected ${pkg.version}.`);
  }
}

// ---------------------------------------------------------------- roadmap
//
// The deck's roadmap card marked "shipped" has to name the version that is
// actually shipped, and no later stage may reuse that number. This drifted
// twice before the stages stopped carrying version numbers at all.

const deck = read("docs/pitch.html");
const shippedCard = deck.match(/v(\d+\.\d+)\s*·\s*shipped/);
const currentMinor = pkg.version.split(".").slice(0, 2).join(".");

if (!shippedCard) {
  problems.push(
    `docs/pitch.html: no roadmap card marked "vX.Y · shipped". One card must say which version is out.`,
  );
} else if (shippedCard[1] !== currentMinor) {
  problems.push(
    `docs/pitch.html: the roadmap says v${shippedCard[1]} is shipped, but package.json is ${pkg.version}. ` +
      `Move the "shipped" marker.`,
  );
}

// Any version already released must not be presented as future. An earlier
// version of this check only fired when a document mentioned the current
// version *nowhere* as shipped, so a stale "PLANNED · v0.5" sitting beside a
// correct "v0.5 · shipped" slipped through for two releases.
const [curMajor, curMinor] = currentMinor.split(".").map(Number);

for (const doc of ["docs/pitch.html", "README.md", "docs/index.html"]) {
  const text = read(doc);
  for (const match of text.matchAll(/v(\d+)\.(\d+)/g)) {
    const [major, minor] = [Number(match[1]), Number(match[2])];
    const isReleased = major < curMajor || (major === curMajor && minor <= curMinor);
    if (!isReleased) continue;

    // "v0.5 · shipped" is the one correct way to name a released version.
    const following = text.slice(match.index, match.index + 60);
    if (/shipped/i.test(following)) continue;

    problems.push(
      `${doc}: presents v${major}.${minor} as future, but ${pkg.version} is already released. ` +
        `Drop the version number or mark it shipped.`,
    );
  }
}

// ---------------------------------------------------------------- report

if (problems.length > 0) {
  console.error(`check:docs found ${problems.length} problem(s):\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nREADME.md, docs/pitch.html and docs/index.html are one set. Change one, change all three.",
  );
  process.exit(1);
}

const schemaVersion = read("src/memory/types.ts").match(/SCHEMA_VERSION = "([^"]+)"/)?.[1];
console.log(
  `check:docs ok - ${registered.size} commands, version ${pkg.version}, schema ${schemaVersion}.`,
);
