/* eslint-disable @typescript-eslint/no-require-imports */
import { inSet, typedKeys } from "./utils/util"

const
	BUNDLE = Object.freeze({
		tmp: (): unknown => require("tmp"),
	} as const),
	MODULES = typedKeys<["tmp"]>()(BUNDLE)
export function dynamicRequireSync(module: string): unknown {
	if (inSet(MODULES, module)) {
		return BUNDLE[module]()
	}
	return require(module)
}
// eslint-disable-next-line @typescript-eslint/require-await
export async function dynamicRequire<T>(module: string): Promise<T> {
	return dynamicRequireSync(module) as T
}
