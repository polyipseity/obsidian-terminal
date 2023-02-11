/* eslint-disable @typescript-eslint/no-require-imports */
import { inSet, isNullish, typedKeys } from "./utils/util"

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
	const ret: unknown = inSet(MODULES, module)
		? BUNDLE[module]()
		: require(module)
	if (isNullish(ret)) {
		throw new Error(module)
	}
	return ret
}

export function importable(module: string): boolean {
	try {
		dynamicRequireSync(module)
		return true
	} catch {
		return false
	}
}
