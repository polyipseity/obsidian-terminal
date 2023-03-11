import { copyFile, mkdir } from "node:fs/promises"
import { PATHS } from "./util.mjs"
import process from "node:process"

const ARGV_DESTINATION = 2,
	DESTINATION_PREFIX = ".obsidian/plugins/terminal",
	DESTINATION = `${process.argv[ARGV_DESTINATION] ?? "."}/${DESTINATION_PREFIX}`

await mkdir(DESTINATION, { recursive: true })
await Promise.all([PATHS.manifest, PATHS.main, PATHS.styles]
	.map(file => copyFile(file, `${DESTINATION}/${file}`)))
