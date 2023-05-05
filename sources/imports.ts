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
	}),
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

export async function dynamicRequire<T>(module: string): Promise<T> {
	return PLazy.from(() => dynamicRequireSync(module))
}

export function dynamicRequireLazy<T extends object>(module: string): T {
	return lazyProxy(() => dynamicRequireSync(module))
}

export function dynamicRequireSync<T>(module: string): T {
	const ret: unknown = inSet(MODULES, module)
		? BUNDLE[module]()
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
