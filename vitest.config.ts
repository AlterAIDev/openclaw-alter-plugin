import { builtinModules } from "node:module";
import { defineConfig } from "vitest/config";

// Vite's resolver doesn't know about Node 22+ built-ins like `node:sqlite`,
// so we manually external-ize every Node built-in (with and without the
// `node:` prefix).
const NODE_BUILTINS = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  "node:sqlite",
  "sqlite",
];

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
    pool: "forks",
    server: {
      deps: { external: NODE_BUILTINS },
    },
  },
  ssr: {
    external: NODE_BUILTINS,
    noExternal: [],
  },
});
