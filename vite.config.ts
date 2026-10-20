import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  // Business data is available only through the authenticated API.
  // Do not copy the historical 500-customer snapshot or a demo entrypoint.
  publicDir: false,
  build: {
    sourcemap: false,
    rollupOptions: {
      input: { portal: "index.html" },
    },
  },
  server: { fs: { deny: [".private/**", "**/.env*", "**/.git/**"] } },
});
