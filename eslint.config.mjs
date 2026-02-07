// @ts-check
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import { includeIgnoreFile } from "@eslint/compat";
import path from "node:path";
import { fileURLToPath } from "node:url";
import globals from "globals"; // provide Node/browser globals for file-level overrides
import eslintConfigPrettier from "eslint-config-prettier/flat";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const FILE_GLOBS = [
  "**/*.cjs",
  "**/*.cts",
  "**/*.d.ts",
  "**/*.js",
  "**/*.jsx",
  "**/*.mjs",
  "**/*.mts",
  "**/*.ts",
  "**/*.tsx",
];

export default defineConfig([
  eslint.configs.recommended,
  tseslint.configs.recommended,
  includeIgnoreFile(path.join(__dirname, ".gitignore")),
  {
    files: FILE_GLOBS,
  },
  {
    rules: {
      "@typescript-eslint/no-namespace": "off",
    },
  },
  // Scripts run on Node.js — provide Node globals so `console` is defined
  {
    files: ["scripts/**", "tests/scripts/**"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  // Disable formatting-related rules that may conflict with Prettier
  eslintConfigPrettier,
]);
