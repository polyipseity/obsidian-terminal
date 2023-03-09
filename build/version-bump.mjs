import { readFile, writeFile } from "node:fs/promises"

const MANIFEST_MAP =
	Object.freeze({
		author: "author",
		description: "description",
		version: "version",
	}),
	aPack = readFile("package.json", "utf-8").then(data => JSON.parse(data))

await Promise.all([
	writeFile(
		"manifest.json",
		JSON.stringify(await (async () => {
			const manifest =
				JSON.parse(await readFile("manifest.json", { encoding: "utf-8" })),
				pack = await aPack
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
		"versions.json",
		JSON.stringify(await (async () => {
			const versions =
				JSON.parse(await readFile("versions.json", { encoding: "utf-8" })),
				pack = await aPack
			versions[pack.version] = pack.obsidian.minAppVersion
			return versions
		})(), null, "\t"),
		{ encoding: "utf-8" },
	),
])
