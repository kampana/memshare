import type { PiiFinding } from "../memory/redact.js";
import type { MemoryItem } from "../memory/types.js";

/** Colour is opt-out (NO_COLOR) and only when stdout is a terminal. */
const useColor =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  process.stdout.isTTY === true;

const ESC = String.fromCharCode(27);

const wrap = (open: string, close: string) => (s: string) =>
  useColor ? `${ESC}[${open}m${s}${ESC}[${close}m` : s;

export const c = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  magenta: wrap("35", "39"),
  cyan: wrap("36", "39"),
};

export function heading(text: string): string {
  return c.bold(text);
}

export function ok(text: string): string {
  return `${c.green("+")} ${text}`;
}

export function warn(text: string): string {
  return `${c.yellow("!")} ${text}`;
}

export function fail(text: string): string {
  return `${c.red("x")} ${text}`;
}

export function info(text: string): string {
  return `${c.dim("-")} ${text}`;
}

/** Short id for display; the full id still works everywhere. */
export function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}

export function visibilityBadge(item: MemoryItem): string {
  return item.visibility === "shareable" ? c.green("shareable") : c.dim("private");
}

export function formatItemLine(item: MemoryItem): string {
  const tags = item.tags.length > 0 ? c.cyan(item.tags.join(", ")) : c.dim("(no tags)");
  const from = item.importedFrom ? c.dim(` <- ${item.importedFrom.exportedBy}`) : "";
  const meta = `${tags}  ${c.dim("|")}  ${visibilityBadge(item)}  ${c.dim("|")}  ${c.dim(item.confidence)}${from}`;
  return `${c.dim(shortId(item.id))}  ${truncate(item.content, 68)}\n    ${meta}`;
}

export function formatPii(findings: PiiFinding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
  return [...counts.entries()]
    .map(([label, n]) => (n > 1 ? `${label} x${n}` : label))
    .join(", ");
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 3))}...`;
}

/** A plain aligned table. Widths come from the content, capped per column. */
export function table(headers: string[], rows: string[][], maxWidths: number[] = []): string {
  const widths = headers.map((h, i) => {
    const cap = maxWidths[i] ?? 60;
    const longest = Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length));
    return Math.min(longest, cap);
  });

  const line = (cells: string[], pad: (s: string) => string = (s) => s): string =>
    cells
      .map((cell, i) => pad(truncateCell(cell, widths[i]!).padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();

  const out = [line(headers, c.dim), c.dim(widths.map((w) => "-".repeat(w)).join("  "))];
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}

function truncateCell(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 3))}...`;
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((now.getTime() - then) / 1000);
  const future = seconds < 0;
  const abs = Math.abs(seconds);

  const scale: Array<[number, string]> = [
    [1, "s"],
    [60, "m"],
    [3600, "h"],
    [86_400, "d"],
    [604_800, "w"],
    [2_629_800, "mo"],
    [31_557_600, "y"],
  ];

  let chosen = scale[0]!;
  for (const step of scale) {
    if (abs >= step[0]) chosen = step;
  }
  const value = Math.max(1, Math.floor(abs / chosen[0]));
  const label = `${value}${chosen[1]}`;
  return future ? `in ${label}` : `${label} ago`;
}

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}
