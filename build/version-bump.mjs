import { readFileSync, writeFileSync } from "node:fs"

const manifestMap =
{
	author: "author",
	description: "description",
	version: "version",
},
	pack = JSON.parse(readFileSync("package.json", "utf-8")),

	// Read minAppVersion from manifest.json and bump version to target version
	manifest = JSON.parse(readFileSync("manifest.json", "utf-8"))
for (const [key, value] of Object.entries(manifestMap)) {
	manifest[key] = pack[value]
}
for (const [key, value] of Object.entries(pack.obsidian)) {
	manifest[key] = value
}
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"))

// Update versions.json with target version and minAppVersion from manifest.json
const versions = JSON.parse(readFileSync("versions.json", "utf-8"))
versions[manifest.version] = manifest.minAppVersion

writeFileSync("versions.json", JSON.stringify(versions, null, "\t"))
