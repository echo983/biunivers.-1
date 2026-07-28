import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client",
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "server/**/*.test.ts"],
    setupFiles: "./src/test/setup.ts",
  },
});
