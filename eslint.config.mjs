// @ts-check
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import { includeIgnoreFile } from "@eslint/compat";
import path from "node:path";
import { fileURLToPath } from "node:url";
import globals from "globals"; // provide Node/browser globals for file-level overrides

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default [
	...defineConfig(eslint.configs.recommended, tseslint.configs.recommended),
	includeIgnoreFile(path.join(__dirname, ".gitignore")),
	{
		rules: {
			"@typescript-eslint/no-namespace": "off",
		},
	},
	// Build scripts run on Node.js — provide Node globals so `console` is defined
	{
		files: ["build/**"],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
	},
];
