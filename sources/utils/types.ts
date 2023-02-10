import type { DeepReadonly, DeepWritable } from "ts-essentials"

export function simplify<T>(value: DeepWritable<DeepReadonly<T>
>): DeepWritable<T>
export function simplify<T>(value: DeepReadonly<DeepWritable<T>
>): DeepReadonly<T>
export function simplify<T>(value: T): T {
	return value
}
