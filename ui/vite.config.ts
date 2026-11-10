import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the UI runs on Vite's server and the API on 8030; these paths go to the API.
const api = ["/health", "/investigations", "/live", "/system", "/audit", "/jobs", "/chaos"];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(api.map((path) => [path, "http://127.0.0.1:8030"])),
  },
  build: { chunkSizeWarningLimit: 1500 },
});
