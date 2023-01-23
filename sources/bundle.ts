/* eslint-disable @typescript-eslint/no-require-imports */
import { inSet, typedKeys } from "./util"

const BUNDLE = {
	tmp: (): unknown => require("tmp"),
}
export async function dynamicRequire<T>(module: string): Promise<T> {
	return Promise.resolve().then(() => {
		if (inSet(typedKeys(BUNDLE), module)) {
			return BUNDLE[module]() as T
		}
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require(module) as T
	})
}
