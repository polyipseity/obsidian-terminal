import type { DeepReadonly, DeepWritable, Opaque } from "ts-essentials"
import { SemVer } from "semver"

export type AnyObject = Readonly<Record<number | string | symbol, unknown>>
export type Contains<T, U> = T & U extends never ? false : true
export type Exact<T, U> =
	(<G>() => G extends T ? 1 : -1) extends
	(<G>() => G extends U ? 1 : -1) ? true : false
export type SemVerString =
	Opaque<string, "fec54e0c-8342-4418-bc4b-57ea4d92c3d4">
export type Sized<T extends readonly unknown[]> =
	number extends T["length"] ? never : T
export type Unchecked<T> = { readonly [_ in keyof T]?: unknown }

export const NULL_SEM_VER_STRING = semVerString("0.0.0")

export function contravariant<T>(value: readonly T[]): readonly T[] {
	return value
}

export function correctType(value: Window): Window & typeof globalThis {
	return value as Window & typeof globalThis
}

export function launderUnchecked<T extends object>(value: unknown): Unchecked<T
> {
	const ret = {}
	Object.assign(ret, value)
	return ret
}

export function opaqueOrDefault<T, I extends string, D>(
	type: (value: T) => Opaque<T, I>,
	value: T,
	defaultValue: D,
): D | Opaque<T, I> {
	try {
		return type(value)
	} catch (error) {
		console.debug(error)
		return defaultValue
	}
}
export function semVerString(value: string): SemVerString {
	return new SemVer(value).version as SemVerString
}

export function simplifyType<T>(value: DeepWritable<DeepReadonly<T>
>): DeepWritable<T>
export function simplifyType<T>(value: DeepReadonly<DeepWritable<T>
>): DeepReadonly<T>
export function simplifyType<T>(value: T): T {
	return value
}
