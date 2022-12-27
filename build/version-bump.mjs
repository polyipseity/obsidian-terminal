import { readFileSync, writeFileSync } from "fs"

const manifest_map = {
	"id": "name",
	"name": "displayName",
	"version": "version",
	"description": "description",
	"author": "author",
}
const pack = JSON.parse(readFileSync("package.json", "utf-8"))

// read minAppVersion from manifest.json and bump version to target version
let manifest = JSON.parse(readFileSync("manifest.json", "utf-8"))
for (const [key, value] of Object.entries(manifest_map)) manifest[key] = pack[value]
for (const [key, value] of Object.entries(pack.obsidian)) manifest[key] = value
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"))

// update versions.json with target version and minAppVersion from manifest.json
let versions = JSON.parse(readFileSync("versions.json", "utf-8"))
versions[manifest.version] = manifest.minAppVersion
writeFileSync("versions.json", JSON.stringify(versions, null, "\t"))
