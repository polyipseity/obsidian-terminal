import { copyFile, mkdir, readFile } from "node:fs/promises"
import { PATHS } from "./util.mjs"
import process from "node:process"

const ARGV_DESTINATION = 2,
	DESTINATION_PREFIX = `.obsidian/plugins/${JSON
		.parse(await readFile(PATHS.manifest, { encoding: "utf-8" })).id}`,
	DESTINATION = `${process.argv[ARGV_DESTINATION] ?? "."}/${DESTINATION_PREFIX}`

await mkdir(DESTINATION, { recursive: true })
await Promise.all([PATHS.manifest, PATHS.main, PATHS.styles]
	.map(file => copyFile(file, `${DESTINATION}/${file}`)))
