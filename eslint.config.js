import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";

export default defineConfig([
  globalIgnores([
    "dist",
    "node_modules",
    "coverage",
    "tmp",
    "test_scripts",
    // Vendored verbatim from numbl — must remain byte-identical
    // (see scripts/sync_from_numbl.ts).
    "src/lexer",
    "src/parser",
  ]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      eslintConfigPrettier,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
    },
  },
]);
