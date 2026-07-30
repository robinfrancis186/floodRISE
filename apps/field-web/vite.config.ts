import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

import { firebaseBuildMetadataPlugin } from "../../scripts/firebase-build-metadata.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ command, mode }) => {
  // CloudFront publishes this application below /field/. Keep the development
  // server at / so existing local and Playwright workflows remain convenient.
  const appBase = command === "build" ? "/field/" : "/";
  const environment = loadEnv(mode, repositoryRoot, "");

  return {
    base: appBase,
    envDir: repositoryRoot,
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [
      react(),
      tailwindcss(),
      firebaseBuildMetadataPlugin({
        application: "field",
        apiConfigKey: "VITE_API_BASE_URL",
        environment,
        repositoryRoot,
      }),
      VitePWA({
        registerType: "autoUpdate",
        scope: appBase,
        includeAssets: [
          "floodrise-icon.svg",
          "icons/floodrise-192.png",
          "icons/floodrise-512.png",
          "icons/floodrise-maskable-512.png",
          "icons/floodrise-apple-touch-180.png"
        ],
        manifest: {
          name: "floodRISE Field",
          short_name: "floodRISE",
          description: "Offline-ready, human-verified flood reporting for Kerala responders and communities.",
          theme_color: "#062d78",
          background_color: "#ffffff",
          display: "standalone",
          orientation: "any",
          start_url: appBase,
          scope: appBase,
          categories: ["utilities", "navigation", "government"],
          icons: [
            {
              src: `${appBase}icons/floodrise-192.png`,
              sizes: "192x192",
              type: "image/png",
              purpose: "any"
            },
            {
              src: `${appBase}icons/floodrise-512.png`,
              sizes: "512x512",
              type: "image/png",
              purpose: "any"
            },
            {
              src: `${appBase}icons/floodrise-maskable-512.png`,
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable"
            }
          ]
        },
        workbox: {
          // Imported activation code deletes historical API response caches
          // before this worker takes control, including on offline and
          // sign-in-required cold starts.
          importScripts: [`${appBase}service-worker-purge.js`],
          navigateFallback: `${appBase}index.html`,
          // API requests are always network-only. The denylist also prevents a
          // future root-scoped worker from treating an API navigation as the
          // offline application shell.
          navigateFallbackDenylist: [/^\/api(?:\/|$)/],
          globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        }
      })
    ],
    server: {
      proxy: {
        "/api": "http://127.0.0.1:8787"
      }
    },
    test: {
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
      include: ["src/**/*.test.{ts,tsx}"],
      exclude: ["**/node_modules/**", "**/dist/**", "**/._*"],
      restoreMocks: true
    }
  };
});
