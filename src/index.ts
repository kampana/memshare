/**
 * Library entry point.
 *
 * The CLI and the MCP server are both just adapters over this. Anyone writing
 * a third adapter -- a ChatGPT action, a Gemini shim, an editor plugin --
 * should be able to do it against these exports alone.
 */

export * from "./instructions.js";
export * from "./memory/types.js";
export * from "./memory/store.js";
export * from "./memory/redact.js";
export * from "./sharing/bundle.js";
export * from "./sharing/export.js";
export * from "./sharing/import.js";
export { createServer, serve } from "./mcp/server.js";
