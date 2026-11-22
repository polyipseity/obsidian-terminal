// @ts-check
import eslintJs from "@eslint/js";
import eslintJson from "@eslint/json";
import eslintPrettier from "eslint-config-prettier/flat";
import eslintObsidianMd from "eslint-plugin-obsidianmd";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import globals from "globals"; // provide Node/browser globals for file-level overrides
import path from "node:path";
import eslintTs from "typescript-eslint";

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
  "**/*.svelte",
  "**/*.svelte.js",
  "**/*.svelte.ts",
];

export default defineConfig([
  {
    files: FILE_GLOBS,
    extends: [
      eslintJs.configs.recommended,
      ...eslintTs.configs.strictTypeChecked,
      eslintPrettier,
    ],
  },
  // Obsidian
  ...eslintObsidianMd.configs.recommendedWithLocalesEn.filter(
    (config) => !config.name?.endsWith("typescript-eslint/base"),
  ),
  includeIgnoreFile(path.join(import.meta.dirname, ".gitignore")),
  {
    files: FILE_GLOBS,
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.mjs", "*.mts"],
        },
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
  {
    files: ["src/**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}"],
    rules: {
      "@typescript-eslint/no-require-imports": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    rules: {
      "obsidianmd/no-global-this": "warn",
    },
  },
  // Scripts and tests run on Node.js — provide Node globals so `console` is defined
  {
    files: ["*.mjs", "*.mts", "scripts/**", "tests/**"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-restricted-globals": "off",
      "obsidianmd/hardcoded-config-path": "off",
      "obsidianmd/no-nodejs-modules": "off",
      "obsidianmd/prefer-create-el": "off",
      "obsidianmd/rule-custom-message": "off",
    },
  },
  {
    files: ["tests/**"],
    rules: {
      // Scoped to tests/**: xterm and its add-ons read KeyboardEvent.keyCode, so these specs construct events with it on
      // purpose. The rule still applies to production code.
      "@typescript-eslint/no-deprecated": "off",
      // Scoped to tests/**: production class instances are checked; the tests assign mocks on purpose and their assertions do not change.
      "@typescript-eslint/no-unsafe-class-instance-assignment": "off",
    },
  },
  {
    files: ["assets/**/*.json"],
    plugins: { json: eslintJson },
    language: "json/json",
    rules: {
      "json/no-duplicate-keys": "error",
      "obsidianmd/ui/sentence-case-json": "off",
    },
  },
  // Most of these files are desktop-only, and are properly guarded
  {
    files: ["src/terminal/environment.ts", "src/terminal/pseudoterminal.ts"],
    languageOptions: {
      globals: {
        ...globals.nodeBuiltin,
        NodeJS: false,
      },
    },
  },
]);
