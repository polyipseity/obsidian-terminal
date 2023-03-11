import { readFile, writeFile } from "node:fs/promises"
import { execute } from "./util.mjs"

const
	TRIM_END_FILES = Object.freeze([
		"package-lock.json",
		"package.json",
	]),
	[{ tag, tagMessage }] = await Promise.all([
		(async () => {
			const tag0 = (await execute(
				"git",
				["tag", "--points-at"],
				{ encoding: "utf-8" },
			)).split("\n", 1)[0].trim()
			return {
				tag: tag0,
				tagMessage: (await execute(
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
		(async () => {
			await Promise.all(TRIM_END_FILES
				.map(async file => writeFile(
					file,
					(await readFile(file, { encoding: "utf-8" })).trimEnd(),
					{ encoding: "utf-8" },
				)))
			await execute(
				"git",
				["add", ...TRIM_END_FILES],
				{ encoding: "utf-8" },
			)
		})(),
	])
await execute(
	"git",
	["commit", "--amend", "--no-edit", "--gpg-sign", "--signoff"],
	{ encoding: "utf-8" },
)
await execute(
	"git",
	["tag", "--sign", "--force", `--message=${tagMessage}`, tag],
	{ encoding: "utf-8" },
)
