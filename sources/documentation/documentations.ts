import changelogMd from "CHANGELOG.md"
import readmeMd from "README.md"
import { typedKeys } from "sources/utils/util"

export const DOCUMENTATIONS = Object.freeze({
	changelog: changelogMd,
	readme: readmeMd,
} as const)
export type DocumentationKeys = readonly ["changelog", "readme"]
export const DOCUMENTATION_KEYS = typedKeys<DocumentationKeys>()(DOCUMENTATIONS)
