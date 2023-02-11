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
