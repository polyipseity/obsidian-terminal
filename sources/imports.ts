/* eslint-disable @typescript-eslint/no-require-imports */
import { deepFreeze, inSet, isNullish, typedKeys } from "./utils/util"

const
	BUNDLE = deepFreeze({
		tmp: (): unknown => require("tmp"),
	} as const),
	MODULES = typedKeys<readonly ["tmp"]>()(BUNDLE)

export async function dynamicRequire<T>(module: string): Promise<T> {
	return Promise.resolve()
		.then(() => dynamicRequireSync(module) as T)
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
	} catch (error) {
		console.debug(error)
		return false
	}
}
