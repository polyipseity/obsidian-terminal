// @ts-check
import eslintJs from "@eslint/js";
import eslintPrettier from "eslint-config-prettier/flat";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import globals from "globals"; // provide Node/browser globals for file-level overrides
import path from "node:path";
import { fileURLToPath } from "node:url";
import eslintTs from "typescript-eslint";

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
  eslintJs.configs.recommended,
  ...eslintTs.configs.strict,
  includeIgnoreFile(path.join(__dirname, ".gitignore")),
  {
    files: FILE_GLOBS,
  },
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-namespace": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
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
  eslintPrettier,
]);
