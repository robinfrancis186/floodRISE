import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ command }) => {
  // CloudFront publishes this application below /field/. Keep the development
  // server at / so existing local and Playwright workflows remain convenient.
  const appBase = command === "build" ? "/field/" : "/";

  return {
    base: appBase,
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [
      react(),
      tailwindcss(),
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
          navigateFallback: `${appBase}index.html`,
          globPatterns: ["**/*.{js,css,html,svg,woff2}"],
          runtimeCaching: [
            {
              // Only the public alert feed may be retained for last-known offline
              // awareness. Reporter-scoped media, receipts, routes, health and
              // commands always cross the network and are never cached.
              urlPattern: ({ url, request, sameOrigin }) => sameOrigin
                && request.method === "GET"
                && url.pathname === "/api/v1/alerts",
              handler: "NetworkFirst",
              options: {
                cacheName: "field-public-alerts-v2",
                networkTimeoutSeconds: 3,
                cacheableResponse: { statuses: [200] },
                expiration: { maxEntries: 8, maxAgeSeconds: 3600 }
              }
            }
          ]
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
