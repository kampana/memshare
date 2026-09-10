import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Each suite creates its own temp MEMSHARE_DIR, but process.env is shared
    // within a worker, so keep files isolated in their own processes.
    pool: "forks",
  },
});
