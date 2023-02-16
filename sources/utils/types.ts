import type { DeepReadonly, DeepWritable } from "ts-essentials"

export type Sized<T extends readonly unknown[]> =
	number extends T["length"] ? never : T

export function simplifyType<T>(value: DeepWritable<DeepReadonly<T>
>): DeepWritable<T>
export function simplifyType<T>(value: DeepReadonly<DeepWritable<T>
>): DeepReadonly<T>
export function simplifyType<T>(value: T): T {
	return value
}

export function contravariant<T>(value: readonly T[]): readonly T[] {
	return value
}
