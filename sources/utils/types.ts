import type { DeepReadonly, DeepWritable } from "ts-essentials"

export type AnyObject = Readonly<Record<number | string | symbol, unknown>>
export type Contains<T, U> = T & U extends never ? false : true
export type Sized<T extends readonly unknown[]> =
	number extends T["length"] ? never : T
export type Unchecked<T> = { readonly [_ in keyof T]?: unknown }

export function contravariant<T>(value: readonly T[]): readonly T[] {
	return value
}

export function launderUnchecked<T extends object>(value: unknown): Unchecked<T
> {
	const ret = {}
	Object.assign(ret, value)
	return ret
}

export function simplifyType<T>(value: DeepWritable<DeepReadonly<T>
>): DeepWritable<T>
export function simplifyType<T>(value: DeepReadonly<DeepWritable<T>
>): DeepReadonly<T>
export function simplifyType<T>(value: T): T {
	return value
}
