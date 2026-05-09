import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  optimizeDeps: { include: ["monaco-editor"] },
  resolve: { dedupe: ["monaco-editor"] },
});
