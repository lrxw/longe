import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Every file is transformed with the root tsconfig. Without this, a test importing
  // the mod's tokens (mods/longe-inbox/hooks/tokens.ts) picks up the mod's own
  // tsconfig, which extends Claude Code's generated, git-ignored type stubs: on a
  // fresh checkout (CI) the transform then fails with "Tsconfig not found".
  oxc: { tsconfig: fileURLToPath(new URL("./tsconfig.json", import.meta.url)) },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
  },
});
