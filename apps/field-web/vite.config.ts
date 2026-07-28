import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["floodrise-icon.svg"],
      manifest: {
        name: "floodRISE Field",
        short_name: "floodRISE",
        description: "Offline-ready, human-verified flood reporting for Kerala responders and communities.",
        theme_color: "#062d78",
        background_color: "#ffffff",
        display: "standalone",
        orientation: "portrait-primary",
        start_url: "/",
        scope: "/",
        categories: ["utilities", "navigation", "government"],
        icons: [
          {
            src: "/floodrise-icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable"
          }
        ]
      },
      workbox: {
        navigateFallback: "/index.html",
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
});
