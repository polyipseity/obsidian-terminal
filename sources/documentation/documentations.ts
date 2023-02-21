import { deepFreeze, typedKeys } from "sources/utils/util"
import changelogMd from "CHANGELOG.md"
import readmeMd from "README.md"

export const DOCUMENTATIONS = deepFreeze({
	changelog: changelogMd,
	readme: readmeMd,
} as const)
export type DocumentationKeys = readonly ["changelog", "readme"]
export const DOCUMENTATION_KEYS = typedKeys<DocumentationKeys>()(DOCUMENTATIONS)
