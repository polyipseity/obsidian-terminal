/* eslint-disable @typescript-eslint/no-require-imports */
import { inSet, typedKeys } from "./utils/util"

const
	BUNDLE = Object.freeze({
		tmp: (): unknown => require("tmp"),
	} as const),
	MODULES = typedKeys<["tmp"]>()(BUNDLE)
// eslint-disable-next-line @typescript-eslint/require-await
export async function dynamicRequire<T>(module: string): Promise<T> {
	if (inSet(MODULES, module)) {
		return BUNDLE[module]() as T
	}
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require(module) as T
}
