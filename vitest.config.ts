import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // gpx.ts uses DOMParser, so these run against a DOM rather than bare Node.
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
});
