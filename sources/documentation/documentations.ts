import { deepFreeze, typedKeys } from "sources/utils/util"
import changelogMd from "CHANGELOG.md"
import readmeMd from "README.md"

export const DOCUMENTATIONS = deepFreeze({
	changelog: changelogMd,
	readme: readmeMd,
} as const)
export const DOCUMENTATION_KEYS = typedKeys<readonly [
	"changelog",
	"readme",
]>()(DOCUMENTATIONS)
export type DocumentationKey = typeof DOCUMENTATION_KEYS[number]
