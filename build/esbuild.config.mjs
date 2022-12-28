import esbuild from "esbuild"
import process from "process"
import builtins from "builtin-modules"

const prod = process.argv[2] === "production"

esbuild.build({
	banner: {
		js: `/*
THIS IS A GENERATED/BUNDLED FILE BY ESBUILD.
If you want to view the source, please visit the repository of this plugin.
*/`,
	},
	entryPoints: ["sources/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		"node:*",
		...builtins],
	format: "cjs",
	watch: !prod,
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
}).catch(() => process.exit(1))
