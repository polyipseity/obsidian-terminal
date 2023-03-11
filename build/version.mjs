import { PATHS, execute } from "./util.mjs"
import { readFile, writeFile } from "node:fs/promises"

const MANIFEST_MAP =
	Object.freeze({
		author: "author",
		description: "description",
		version: "version",
	}),
	aPackage = readFile(PATHS.package, "utf-8").then(data => JSON.parse(data))

await Promise.all([
	writeFile(
		PATHS.manifest,
		JSON.stringify(await (async () => {
			const manifest =
				JSON.parse(await readFile(PATHS.manifest, { encoding: "utf-8" })),
				pack = await aPackage
			for (const [key, value] of Object.entries(MANIFEST_MAP)) {
				manifest[key] = pack[value]
			}
			for (const [key, value] of Object.entries(pack.obsidian)) {
				manifest[key] = value
			}
			return manifest
		})(), null, "\t"),
		{ encoding: "utf-8" },
	),
	writeFile(
		PATHS.versions,
		JSON.stringify(await (async () => {
			const versions =
				JSON.parse(await readFile(PATHS.versions, { encoding: "utf-8" })),
				pack = await aPackage
			versions[pack.version] = pack.obsidian.minAppVersion
			return versions
		})(), null, "\t"),
		{ encoding: "utf-8" },
	),
])
await execute(
	"git",
	["add", PATHS.manifest, PATHS.versions],
	{ encoding: "utf-8" },
)
