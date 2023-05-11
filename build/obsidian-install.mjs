import { PATHS, PLUGIN_ID } from "./util.mjs"
import { copyFile, mkdir } from "node:fs/promises"
import { argv } from "node:process"

const ARGV_DESTINATION = 2,
	DESTINATION_PREFIX = `${PATHS.obsidianPlugins}/${await PLUGIN_ID}`,
	DESTINATION = `${argv[ARGV_DESTINATION] ?? "."}/${DESTINATION_PREFIX}`

await mkdir(DESTINATION, { recursive: true })
await Promise.all([PATHS.manifest, PATHS.main, PATHS.styles]
	.map(file => copyFile(file, `${DESTINATION}/${file}`)))
