import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// On GitHub Pages a project site is served from /<repo>/, so the bundle must be
// built with a matching base. The deploy workflow sets VITE_BASE from the repo
// name; locally (dev/preview) we fall back to "/nave-drone/".
const base = process.env.VITE_BASE ?? "/nave-drone/";

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "NAVE — drone engine",
        short_name: "NAVE",
        description: "Vespers for the empty hall — a browser-native dark-ambient drone engine.",
        lang: "en",
        theme_color: "#100c09",
        background_color: "#100c09",
        display: "standalone",
        orientation: "portrait",
        categories: ["music", "entertainment"],
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Audio is fully synthesized in-browser, so precaching the app shell is
        // all that's needed for offline play. (The "oracle" API call won't work
        // offline, by design.)
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
      },
    }),
  ],
});
