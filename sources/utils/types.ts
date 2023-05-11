import type {
	DeepReadonly,
	DeepWritable,
	Opaque,
	WithOpaque,
} from "ts-essentials"
import SemVer from "semver/classes/semver"
import { isUndefined } from "lodash-es"

export type AnyObject = Readonly<Record<keyof any, unknown>>
export type CodePoint =
	Opaque<string, "2af98ef6-0537-4fd3-a1e1-269517bca44d"> & {
		readonly codePointAt: (pos: 0) => number
	}
export type Constructor<T> = new (...args: readonly unknown[]) => T
export type Contains<T, U> = T & U extends never ? false : true
export type Deopaque<T> = T extends WithOpaque<infer U>
	? T extends Opaque<infer V, U> ? V : never : never
export type Exact<T, U> =
	(<G>() => G extends T ? 1 : -1) extends
	(<G>() => G extends U ? 1 : -1) ? true : false
export type ReadonlyTuple<Type = unknown> =
	readonly [] | readonly [Type, ...Type[]]
export type SemVerString =
	Opaque<string, "fec54e0c-8342-4418-bc4b-57ea4d92c3d4">
export type Unchecked<T> = { readonly [_ in keyof T]?: unknown }

export const NULL_SEM_VER_STRING = semVerString("0.0.0")

export function contravariant<T>(value: readonly T[]): readonly T[] {
	return value
}

export function correctType(value: Window): Window & typeof globalThis {
	return value as Window & typeof globalThis
}

export function deopaque<T>(value: T): Deopaque<T> {
	return value as Deopaque<T>
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
		self.console.debug(error)
		return defaultValue
	}
}
export function codePoint(value: string): CodePoint {
	const cp = value.codePointAt(0)
	if (isUndefined(cp) || String.fromCharCode(cp) !== value) {
		throw new TypeError(value)
	}
	return value as CodePoint
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
