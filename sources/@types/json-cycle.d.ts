declare module "json-cycle" {
	export function stringify(
		value: any,
		replacer?: (number | string)[] | ((
			this: any,
			key: string,
			value: any,
		) => any) | null,
		space?: number | string,
	): string
	export function parse(
		text: string,
		reviver?: (this: any, key: string, value: any) => any,
	): any
	export function decycle(object: any): any
	export function retrocycle(object: any): any
}
