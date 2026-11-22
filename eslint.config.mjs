// @ts-check
import eslintJs from "@eslint/js";
import eslintPrettier from "eslint-config-prettier/flat";
import eslintObsidianMd from "eslint-plugin-obsidianmd";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import globals from "globals"; // provide Node/browser globals for file-level overrides
import path from "node:path";
import ts from "typescript";
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

const ASSET_JSON = "assets/**/*.json";
const lintFiles = [...FILE_GLOBS, ASSET_JSON];
/** @type {{ parseForESLint(text: string, options: object): ReturnType<typeof eslintTs.parser.parseForESLint> }} */
const assetParser = eslintTs.parser;

export default defineConfig([
  {
    files: lintFiles,
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
    files: lintFiles,
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
  // Use TypeScript's JSON parser for every locale so the shared rules see object literals.
  {
    files: [ASSET_JSON],
    language: "@/js",
    languageOptions: {
      parser: {
        ...eslintTs.parser,
        /**
         * @param {string} text
         * @param {{ filePath: string }} options
         */
        parseForESLint(text, options) {
          // TypeScript also accepts JSON with comments and trailing commas.
          JSON.parse(text);
          // A JSON asset can be linted before any TypeScript module imports it.
          const { filePath } = options;
          const compilerOptions = {
            resolveJsonModule: true,
            noLib: true,
            types: [],
          };
          const host = ts.createCompilerHost(compilerOptions, true);
          host.readFile = (name) =>
            path.resolve(name) === filePath ? text : undefined;
          const program = ts.createProgram([filePath], compilerOptions, host);
          return assetParser.parseForESLint(text, {
            ...options,
            programs: [program],
          });
        },
      },
      parserOptions: { projectService: false },
    },
    rules: {
      "@typescript-eslint/no-unused-expressions": "off",
      "no-dupe-keys": "error",
      "no-unexpected-multiline": "error",
      "no-unused-vars": "error",
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
