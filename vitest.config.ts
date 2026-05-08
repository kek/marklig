import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
    globals: false,
    reporters: ["default"],
    setupFiles: ["tests/setup.ts"],
  },
});
