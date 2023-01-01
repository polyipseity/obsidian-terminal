import * as assets from "assets/locales/en/assets.json"
import * as en from "assets/locales/en/translation.json"
import * as languages from "assets/locales/en/languages.json"

export const DEFAULT_NAMESPACE = "translation"
export const DEFAULT_LANGUAGE = "en"
export const FALLBACK_LANGUAGES = {
	"default": [DEFAULT_LANGUAGE],
} as const
export const RESOURCES = {
	en: {
		[DEFAULT_NAMESPACE]: en,
		assets,
		languages,
	},
} as const
