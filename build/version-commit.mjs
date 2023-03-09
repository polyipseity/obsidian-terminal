import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileP = promisify(execFile)

function check(ret) {
	if (typeof ret.error !== "undefined") {
		throw ret.error
	}
}
function log(ret) {
	console.log(ret.stdout)
	console.error(ret.stderr)
}

let ret = await execFileP("git", ["tag", "--points-at"], { encoding: "utf-8" })
check(ret)
const [tag] = ret.stdout.split("\n", 1)

ret = await execFileP(
	"git",
	["tag", "--list", "--format=%(contents:subject)\n%(contents:body)", tag],
	{ encoding: "utf-8" },
)
check(ret)
const tagMessage = ret.stdout.trim()

ret = await execFileP(
	"git",
	["commit", "--amend", "--no-edit", "--gpg-sign", "--signoff"],
	{ encoding: "utf-8" },
)
log(ret)
check(ret)

ret = await execFileP("git", ["tag", "--sign", "--force", "--file=-", tag], {
	encoding: "utf-8",
	input: tagMessage,
})
log(ret)
check(ret)
