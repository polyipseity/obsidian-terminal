/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-require-imports */
export const BUNDLE = {
	tmp: () => require("tmp") as unknown,
} as const
export const BUNDLE_KEYS = Object.keys(BUNDLE) as (keyof typeof BUNDLE)[]
