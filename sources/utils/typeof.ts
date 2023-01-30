/* eslint-disable @typescript-eslint/indent */
export type InverseTypeofMap<T> =
	T extends string ? "string"
	: T extends number ? "number"
	: T extends bigint ? "bigint"
	: T extends boolean ? "boolean"
	: T extends symbol ? "symbol"
	: T extends undefined ? "undefined"
	// eslint-disable-next-line @typescript-eslint/ban-types
	: T extends Function ? "function"
	: T extends never ? never
	: "object"
export interface TypeofMap {
	string: string
	number: number
	bigint: bigint
	boolean: boolean
	symbol: symbol
	undefined: undefined
	// eslint-disable-next-line @typescript-eslint/ban-types
	function: Function
	object: object | null
}
export type PrimitiveOf<T> = TypeofMap[InverseTypeofMap<T>]
export type PrimitiveType = keyof TypeofMap
export const PRIMITIVE_TYPES: readonly PrimitiveType[] =
	[
		"string",
		"number",
		"bigint",
		"boolean",
		"symbol",
		"undefined",
		"function",
		"object",
	]

export function genericTypeofGuard<T extends PrimitiveType>(
	type: T,
	value: unknown,
): value is TypeofMap[T] {
	return typeof value === type
}
export function primitiveOf<T>(value: T): PrimitiveOf<T> {
	return value as PrimitiveOf<T>
}
