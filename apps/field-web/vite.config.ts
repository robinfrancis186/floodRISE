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
            // Health must always be fetched from the network because the
            // per-profile demo reset uses it as a deletion safety proof.
            urlPattern: ({ url }) => url.pathname.startsWith("/api/v1/")
              && url.pathname !== "/api/v1/reports"
              && url.pathname !== "/api/v1/health",
            handler: "NetworkFirst",
            options: {
              cacheName: "field-api-last-known",
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 40, maxAgeSeconds: 3600 }
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
