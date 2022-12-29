/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import * as assets from "assets/locales/en/assets.json"
import * as en from "assets/locales/en/translations.json"

export const DEFAULT_NAMESPACE = "translation"
export const DEFAULT_LANGUAGE = "en"
export const RESOURCES = {
	en: {
		[DEFAULT_NAMESPACE]: en,
		assets,
	},
} as const
