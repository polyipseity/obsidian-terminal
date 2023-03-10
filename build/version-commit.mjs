import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileP = promisify(execFile)
async function run(...args) {
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

const
	tag = (await run(
		"git",
		["tag", "--points-at"],
		{ encoding: "utf-8" },
	)).split("\n", 1)[0].trim(),
	tagMessage = (await run(
		"git",
		["tag", "--list", "--format=%(contents:subject)\n%(contents:body)", tag],
		{ encoding: "utf-8" },
	)).trim()
await run(
	"git",
	["commit", "--amend", "--no-edit", "--gpg-sign", "--signoff"],
	{ encoding: "utf-8" },
)
await run(
	"git",
	["tag", "--sign", "--force", `--message=${tagMessage}`, tag],
	{ encoding: "utf-8" },
)
