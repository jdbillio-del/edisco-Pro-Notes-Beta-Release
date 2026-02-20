import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  base: "./",
  plugins: [
    react(),
    {
      name: "edisco-csp",
      transformIndexHtml(html) {
        const connectSrc = command === "serve" ? "ws://localhost:5173 http://localhost:5173" : "'self'";
        return html.replace("__EDISCO_CONNECT_SRC__", connectSrc);
      }
    }
  ],
  server: {
    host: "127.0.0.1",
    strictPort: true,
    port: 5173
  }
}));
