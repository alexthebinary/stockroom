import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Listen on every interface so other machines on the LAN can open the demo.
    // Vite proxies /api from here, so the API itself stays bound to localhost.
    host: true,
    // Everything under /api is proxied to the backend, so the browser never
    // needs to know the API port and there is no CORS story in dev.
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
