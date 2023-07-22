import { PATHS, PLUGIN_ID } from "./util.mjs"
import { analyzeMetafile, context, formatMessages } from "esbuild"
import { constant, isEmpty, isUndefined, kebabCase } from "lodash-es"
import { argv } from "node:process"
import builtinModules from "builtin-modules"
import esbuildCompress from "esbuild-compress"
import esbuildPluginGlobals from "esbuild-plugin-globals"
import esbuildSvelte from "esbuild-svelte"
import sveltePreprocess from "svelte-preprocess"
import { writeFile } from "node:fs/promises"

const ARGV_PRODUCTION = 2,
	COMMENT = "// repository: https://github.com/polyipseity/obsidian-plugin-template",
	DEV = argv[ARGV_PRODUCTION] === "dev",
	PLUGIN_ID0 = await PLUGIN_ID,
	BUILD = await context({
		alias: {},
		banner: { js: COMMENT },
		bundle: true,
		color: true,
		drop: [],
		entryPoints: ["sources/main.ts", "sources/styles.css"],
		external: [
			"@codemirror/*",
			"@lezer/*",
			"electron",
			"node:*",
			"obsidian",
			...builtinModules,
		],
		footer: { js: COMMENT },
		format: "cjs",
		inject: ["@polyipseity/obsidian-plugin-library/inject"],
		jsx: "transform",
		legalComments: "inline",
		loader: {
			".json": "compressed-json",
			".md": "compressed-text",
		},
		logLevel: "info",
		logLimit: 0,
		metafile: true,
		minify: !DEV,
		outdir: PATHS.outDir,
		platform: "browser",
		plugins: [
			esbuildPluginGlobals({
				i18next: "i18next",
				moment: "moment",
			}),
			esbuildCompress({
				lazy: true,
			}),
			esbuildSvelte({
				cache: "overzealous",
				compilerOptions: {
					accessors: false,
					css: "injected",
					cssHash({ name }) {
						return `${PLUGIN_ID0}-svelte-${kebabCase(name)}`
					},
					customElement: false,
					dev: DEV,
					enableSourcemap: {
						css: DEV,
						js: true,
					},
					errorMode: "throw",
					format: "esm",
					generate: "dom",
					hydratable: false,
					immutable: true,
					legacy: false,
					loopGuardTimeout: 0,
					preserveComments: false,
					preserveWhitespace: false,
					varsReport: "full",
				},
				filterWarnings: constant(true),
				fromEntryFile: false,
				include: /\.svelte$/u,
				preprocess: [
					sveltePreprocess({
						aliases: [],
						globalStyle: {
							sourceMap: DEV,
						},
						preserve: [],
						replace: [],
						sourceMap: false,
						typescript: {
							compilerOptions: {},
							handleMixedImports: true,
							reportDiagnostics: true,
							tsconfigDirectory: "./",
							tsconfigFile: "./tsconfig.json",
						},
					}),
				],
			}),
		],
		sourcemap: DEV ? "inline" : false,
		sourcesContent: true,
		target: "ES2018",
		treeShaking: true,
	})

async function esbuild() {
	if (DEV) {
		await BUILD.watch({})
	} else {
		try {
			// Await https://github.com/evanw/esbuild/issues/2886
			const { errors, warnings, metafile } = await BUILD.rebuild()
			await Promise.all([
				(async () => {
					if (!isUndefined(metafile)) {
						console.log(await analyzeMetafile(metafile, {
							color: true,
							verbose: true,
						}))
					}
					for await (const logging of [
						{
							data: warnings,
							kind: "warning",
							log: console.warn.bind(console),
						},
						{
							data: errors,
							kind: "error",
							log: console.error.bind(console),
						},
					]
						.filter(({ data }) => !isEmpty(data))
						.map(async ({ data, kind, log }) => {
							const message = (await formatMessages(data, {
								color: true,
								kind,
							})).join("\n")
							return () => log(message)
						})) {
						logging()
					}
				})(),
				isUndefined(metafile)
					? null
					: writeFile(
						PATHS.metafile,
						JSON.stringify(metafile, null, "\t"),
						{ encoding: "utf-8" },
					),
			])
		} finally {
			await BUILD.dispose()
		}
	}
}
await esbuild()
