// @ts-check
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import { includeIgnoreFile } from "@eslint/compat";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default [
	...defineConfig(eslint.configs.recommended, tseslint.configs.recommended),
	includeIgnoreFile(path.join(__dirname, ".gitignore")),
];
