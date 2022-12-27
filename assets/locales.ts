/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import * as en from "assets/locales/en.json"

export const defaultNamespace = "translation"
export const defaultLanguage = "en"
export const resources = {
	en: {
		[defaultNamespace]: en,
	},
} as const
