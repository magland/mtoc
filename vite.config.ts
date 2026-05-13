import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  optimizeDeps: { include: ["monaco-editor"] },
  resolve: { dedupe: ["monaco-editor"] },
  test: {
    // Skip checked-out git worktrees (which live under `.claude/worktrees/`
    // and carry their own `tests/` dirs). Without this, vitest's auto-
    // discovery doubles every test up by also running it from the worktree
    // copy.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
