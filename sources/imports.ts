/* eslint-disable @typescript-eslint/no-require-imports */
import { inSet, typedKeys } from "./utils/util"

const
	BUNDLE = Object.freeze({
		tmp: (): unknown => require("tmp"),
	} as const),
	MODULES = typedKeys<["tmp"]>()(BUNDLE)

// eslint-disable-next-line @typescript-eslint/require-await
export async function dynamicRequire<T>(module: string): Promise<T> {
	return dynamicRequireSync(module) as T
}

export function dynamicRequireSync(module: string): unknown {
	if (inSet(MODULES, module)) {
		return BUNDLE[module]()
	}
	return require(module)
}

export function importable(module: string): boolean {
	try {
		dynamicRequireSync(module)
		return true
	} catch {
		return false
	}
}
