/* eslint-disable @typescript-eslint/no-require-imports */
import {
	deepFreeze,
	inSet,
	lazyProxy,
	typedKeys,
} from "./utils/util"
import PLazy from "p-lazy"
import { isNil } from "lodash-es"

const
	// Needed for bundler
	BUNDLE = deepFreeze({
	}),
	MODULES = typedKeys<readonly [
	]>()(BUNDLE)

export async function dynamicRequire<T>(module: string): Promise<T> {
	return PLazy.from(() => dynamicRequireSync(module))
}

export function dynamicRequireLazy<T extends object>(module: string): T {
	return lazyProxy(() => dynamicRequireSync(module))
}

export function dynamicRequireSync<T>(module: string): T {
	const ret: unknown = inSet(MODULES, module)
		? BUNDLE[module]
		: require(module)
	if (isNil(ret)) { throw new Error(module) }
	return ret as T
}

export function importable(module: string): boolean {
	try {
		dynamicRequireSync(module)
		return true
	} catch (error) {
		self.console.debug(error)
		return false
	}
}
