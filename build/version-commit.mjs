import { spawnSync } from "child_process"

function check(ret) {
	if (ret.error !== undefined) throw ret.error
}
function log(ret) {
	console.log(ret.stdout)
	console.error(ret.stderr)
}

let ret
ret = spawnSync("git", ["tag", "--points-at"], { encoding: "utf-8", })
check(ret)
const tag = ret.stdout.split("\n", 1)[0]

ret = spawnSync("git", ["tag", "--list", "--format=%(contents:subject)\n%(contents:body)", tag], { encoding: "utf-8" })
check(ret)
const tag_msg = ret.stdout.trim()

ret = spawnSync("git", ["commit", "--amend", "--no-edit", "--gpg-sign", "--signoff"], { encoding: "utf-8", })
log(ret)
check(ret)

ret = spawnSync("git", ["tag", "--sign", "--force", "--file=-", tag], { encoding: "utf-8", input: tag_msg, })
log(ret)
check(ret)
