import { patchLens } from "@patchlens-ai/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [patchLens(), react()],
  server: {
    host: "127.0.0.1",
    port: 4312,
    strictPort: true,
  },
});
