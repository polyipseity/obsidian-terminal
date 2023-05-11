/* eslint-disable @typescript-eslint/indent */
import { contravariant } from "./types"

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
export const PRIMITIVE_TYPES = Object.freeze([
	"string",
	"number",
	"bigint",
	"boolean",
	"symbol",
	"undefined",
	"function",
	"object",
]) satisfies readonly PrimitiveType[]

export function genericTypeofGuard<T extends PrimitiveType>(
	types: readonly T[],
	value: unknown,
): value is TypeofMap[T] {
	return contravariant<PrimitiveType>(types).includes(typeof value)
}
export function primitiveOf<T>(value: T): PrimitiveOf<T> {
	return value as PrimitiveOf<T>
}

export type InverseTypeofMapE<T> = T extends null ? "null" : InverseTypeofMap<T>
export interface TypeofMapE extends TypeofMap {
	null: null
	object: object
}
export type PrimitiveOfE<T> = TypeofMapE[InverseTypeofMapE<T>]
export type PrimitiveTypeE = keyof TypeofMapE
export const PRIMITIVE_TYPES_E = Object.freeze([
	...PRIMITIVE_TYPES,
	"null",
]) satisfies readonly PrimitiveTypeE[]

export function typeofE(value: unknown): PrimitiveTypeE {
	return value === null ? "null" : typeof value
}
export function genericTypeofGuardE<T extends PrimitiveTypeE>(
	types: readonly T[],
	value: unknown,
): value is TypeofMapE[T] {
	return contravariant<PrimitiveTypeE>(types).includes(typeofE(value))
}
export function primitiveOfE<T>(value: T): PrimitiveOfE<T> {
	return value as PrimitiveOfE<T>
}
