/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-require-imports */
import { typedKeys } from "./util"

export const BUNDLE = {
	tmp: () => require("tmp") as unknown,
} as const
export const BUNDLE_KEYS = typedKeys(BUNDLE)
