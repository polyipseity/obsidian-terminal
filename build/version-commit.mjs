import { readFile, writeFile } from "node:fs/promises"
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

const [{ tag, tagMessage }] = await Promise.all([
	(async () => {
		const tag0 = (await run(
			"git",
			["tag", "--points-at"],
			{ encoding: "utf-8" },
		)).split("\n", 1)[0].trim()
		return {
			tag: tag0,
			tagMessage: (await run(
				"git",
				[
					"tag",
					"--list",
					"--format=%(contents:subject)\n%(contents:body)",
					tag0,
				],
				{ encoding: "utf-8" },
			)).trim(),
		}
	})(),
	...["package-lock.json", "package.json"]
		.map(async file => writeFile(
			file,
			(await readFile(file, { encoding: "utf-8" })).trimEnd(),
			{ encoding: "utf-8" },
		)),
])
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
