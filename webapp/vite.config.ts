import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": "http://localhost:3000",
      "/media": "http://localhost:3000",
    },
  },
  build: { target: "es2020", sourcemap: false },
});
