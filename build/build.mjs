import { analyzeMetafile, context, formatMessages } from "esbuild"
import { isEmpty, isUndefined } from "lodash-es"
import { PATHS } from "./util.mjs"
import { argv } from "node:process"
import builtinModules from "builtin-modules"
import esbuildCompress from "esbuild-compress"
import esbuildPluginGlobals from "esbuild-plugin-globals"
import { writeFile } from "node:fs/promises"

const ARGV_PRODUCTION = 2,
	COMMENT = "// repository: https://github.com/polyipseity/obsidian-plugin-template",
	DEV = argv[ARGV_PRODUCTION] === "dev",
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
				// Cannot use `i18next` because it is too outdated to have formatters
				moment: "moment",
			}),
			esbuildCompress({
				lazy: true,
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
