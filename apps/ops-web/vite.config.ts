import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ command }) => ({
  // CloudFront publishes Operations below /ops/. Development remains rooted at
  // / so the existing local and Playwright workflows do not need a second mode.
  base: command === "build" ? "/ops/" : "/",
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
    exclude: ["**/node_modules/**", "**/dist/**", "**/._*"],
  },
}));
