import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxies /api to the Go master's HTTP API during local dev so the
// dashboard can call relative paths without dealing with CORS itself.
export default defineConfig({
  plugins: [react()],
  build: {
    // ECharts is a deliberate, lazily loaded chunk (see charts/); it is the
    // one file expected to exceed the default warning size.
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: Number(process.env.VITE_DEV_PORT ?? 5173),
    proxy: {
      "/api": {
        target: process.env.VITE_MASTER_API ?? "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
