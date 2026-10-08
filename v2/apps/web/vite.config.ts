import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // The manifest is fetched with cookies, so turning on a Cloudflare Access
      // login in front of the app later does not break "Add to Home Screen".
      useCredentials: true,
      includeAssets: ["icon.svg"],
      manifest: {
        name: "ProfitIndex",
        short_name: "ProfitIndex",
        description: "Receive, bill and pay for stock — from the dock to the books.",
        theme_color: "#111210",
        background_color: "#fafaf7",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // The app shell and the barcode decoder work offline; data always comes from the API.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,wasm}"],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  server: {
    port: 5173,
    host: true,
    proxy: { "/api": "http://localhost:4100" },
  },
  preview: { proxy: { "/api": "http://localhost:4100" } },
});
