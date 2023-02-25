module "eastasianwidth" {
	declare namespace eastasianwidth {
		function eastAsianWidth(character: string): string
		function characterLength(character: string): number
		function length(string: string): number
		function slice(text: string, start = 0, end = 1): string
	}
	export = { ...eastasianwidth }
}
