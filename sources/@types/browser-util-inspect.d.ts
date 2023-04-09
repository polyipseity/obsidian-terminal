declare module "browser-util-inspect" {
	export = inspect

	function inspect(obj: unknown, opts: inspect.Options): string

	namespace inspect {
		interface Options {
			readonly showHidden?: boolean
			readonly depth?: number
			readonly colors?: boolean
			readonly customInspect?: boolean
			readonly stylize?: (str: string, styleType: StyleType) => string
		}

		type StyleType =
			"boolean"
			| "date"
			| "name"
			| "null"
			| "number"
			| "regexp"
			| "special"
			| "string"
			| "undefined"
	}
}
