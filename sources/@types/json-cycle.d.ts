declare module "json-cycle" {
	export function stringify(
		value: unknown,
		replacer?: (number | string)[] | ((
			this: unknown,
			key: string,
			value: unknown,
		) => unknown) | null,
		space?: number | string,
	): string
	export function parse(
		text: string,
		reviver?: (this: unknown, key: string, value: unknown) => unknown,
	): unknown
	export function decycle(object: unknown): unknown
	export function retrocycle(object: unknown): unknown
}
