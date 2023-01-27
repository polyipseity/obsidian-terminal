import type { Mutable } from "sources/util"

export const enum Direction {
	next = 0,
	previous = 1,
}
export interface Params {
	readonly caseSensitive: boolean
	readonly findText: string
	readonly regex: boolean
	readonly wholeWord: boolean
}
export function copyParams(params: Partial<Mutable<Params>>): Params {
	return {
		caseSensitive: params.caseSensitive ?? false,
		findText: params.findText ?? "",
		regex: params.regex ?? false,
		wholeWord: params.wholeWord ?? false,
	}
}
