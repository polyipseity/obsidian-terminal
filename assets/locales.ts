/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import * as assets from "assets/locales/en/assets.json"
import * as en from "assets/locales/en/translations.json"

export const defaultNamespace = "translation"
export const defaultLanguage = "en"
export const resources = {
	en: {
		assets,
		[defaultNamespace]: en,
	},
} as const
