import { defineConfig } from "eslint/config"

export default defineConfig([
	{
		extends: [
			"eslint:recommended",
			"plugin:@typescript-eslint/recommended",
		],
		files: ["**/*.{js,ts,jsx,tsx,mjs,cjs,mts,cts}"],
		plugins: ["@typescript-eslint"],
		languageOptions: {
			parser: "@typescript-eslint/parser",
			ecmaVersion: "latest",
			sourceType: "module",
		},
	},
	{
		extends: ["plugin:markdownlint/recommended"],
		files: ["**/*.md", ".changeset/**/*.md"],
	},
	/*
	For Svelte linting, add to `devDependencies`:

	```JSON
	"eslint-plugin-svelte": "^2.32.0",
	"svelte-eslint-parser": "^0.33.0",
	```

	Then uncomment below to enable Svelte support.
	*/
	// {
	// 	extends: [
	// 		"plugin:svelte/recommended"
	// 	],
	// 	files: ["**/*.svelte"],
	// 	languageOptions: {
	// 		parser: "svelte-eslint-parser",
	// 		parserOptions: {
	// 			parser: "@typescript-eslint/parser",
	// 		},
	// 	},
	// },
])
