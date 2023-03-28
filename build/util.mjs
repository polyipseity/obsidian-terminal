import { execFile } from "child_process"
import { promisify } from "util"

const execFileP = promisify(execFile)

export const PATHS = Object.freeze({
	main: "main.js",
	manifest: "manifest.json",
	manifestBeta: "manifest-beta.json",
	metafile: "metafile.json",
	obsidianPlugins: ".obsidian/plugins",
	"package": "package.json",
	packageLock: "package-lock.json",
	styles: "styles.css",
	versions: "versions.json",
})
export async function execute(...args) {
	const process = execFileP(...args),
		{ stdout, stderr } = await process
	if (stdout) {
		console.log(stdout)
	}
	if (stderr) {
		console.error(stderr)
	}
	const { exitCode } = process.child
	if (exitCode !== 0) {
		throw new Error(String(exitCode))
	}
	return stdout
}
