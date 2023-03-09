import { copyFile, mkdir } from "node:fs/promises"
import process from "node:process"

const ARGV_DESTINATION = 2,
	DESTINATION_PREFIX = ".obsidian/plugins/terminal",
	DESTINATION = `${process.argv[ARGV_DESTINATION] ?? "."}/${DESTINATION_PREFIX}`

await mkdir(DESTINATION, { recursive: true })
await Promise.all(["manifest.json", "main.js", "styles.css"]
	.map(file => copyFile(file, `${DESTINATION}/${file}`)))
