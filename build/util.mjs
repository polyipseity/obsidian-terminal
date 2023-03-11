import { execFile } from "child_process"
import { promisify } from "util"

const execFileP = promisify(execFile)

export const PATHS = Object.freeze({
	main: "main.js",
	manifest: "manifest.json",
	"package": "package.json",
	packageLock: "package-lock.json",
	styles: "styles.css",
	versions: "versions.json",
})
export async function execute(...args) {
	const { stdout, stderr } = await execFileP(...args)
	if (stdout) {
		console.log(stdout)
	}
	if (stderr) {
		console.error(stderr)
		throw new Error(stderr)
	}
	return stdout
}
