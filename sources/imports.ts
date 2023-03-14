/* eslint-disable @typescript-eslint/no-require-imports */
import { deepFreeze, inSet, isNullish, lazyInit, typedKeys } from "./utils/util"
import PLazy from "p-lazy"

const
	// Needed for bundler
	BUNDLE = deepFreeze({
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"tmp-promise": (): unknown => require("tmp-promise"),
		xterm: (): unknown => require("xterm"),
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"xterm-addon-canvas": (): unknown => require("xterm-addon-canvas"),
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"xterm-addon-fit": (): unknown => require("xterm-addon-fit"),
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"xterm-addon-ligatures": (): unknown => require("xterm-addon-ligatures"),
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"xterm-addon-search": (): unknown => require("xterm-addon-search"),
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"xterm-addon-serialize": (): unknown => require("xterm-addon-serialize"),
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"xterm-addon-unicode11": (): unknown => require("xterm-addon-unicode11"),
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"xterm-addon-web-links": (): unknown => require("xterm-addon-web-links"),
		// eslint-disable-next-line @typescript-eslint/naming-convention
		"xterm-addon-webgl": (): unknown => require("xterm-addon-webgl"),
	} as const),
	MODULES = typedKeys<readonly [
		"tmp-promise",
		"xterm",
		"xterm-addon-canvas",
		"xterm-addon-fit",
		"xterm-addon-ligatures",
		"xterm-addon-search",
		"xterm-addon-serialize",
		"xterm-addon-unicode11",
		"xterm-addon-web-links",
		"xterm-addon-webgl",
	]>()(BUNDLE)

// eslint-disable-next-line @typescript-eslint/promise-function-async
export function dynamicRequire<T>(module: string): PLazy<T> {
	return PLazy.from(() => dynamicRequireSync(module) as T)
}

export function dynamicRequireLazy<T>(module: string): () => T {
	return lazyInit(() => dynamicRequireSync(module) as T)
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
