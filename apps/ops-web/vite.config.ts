import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

import { firebaseBuildMetadataPlugin } from "../../scripts/firebase-build-metadata.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, repositoryRoot, "");

  return {
    // CloudFront and Firebase Hosting publish Operations below /ops/.
    // Development remains rooted at / for the local and Playwright workflows.
    base: command === "build" ? "/ops/" : "/",
    envDir: repositoryRoot,
    plugins: [
      react(),
      tailwindcss(),
      firebaseBuildMetadataPlugin({
        application: "ops",
        apiConfigKey: "VITE_API_ROOT",
        environment,
        repositoryRoot,
      }),
    ],
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
  };
});
