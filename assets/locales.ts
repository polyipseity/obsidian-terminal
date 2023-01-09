import * as asset from "assets/locales/en/asset.json"
import * as en from "assets/locales/en/translation.json"
import * as language from "assets/locales/en/language.json"
import * as zhHans from "assets/locales/zh-Hans/translation.json"
import * as zhHant from "assets/locales/zh-Hant/translation.json"

export const RETURN_NULL = false
export const DEFAULT_NAMESPACE = "translation"
export const DEFAULT_LANGUAGE = "en"
export const FALLBACK_LANGUAGES = {
	"default": [DEFAULT_LANGUAGE],
	zh: ["zh-Hans", DEFAULT_LANGUAGE],
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"zh-CN": ["zh-Hans", "zh", DEFAULT_LANGUAGE],
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"zh-TW": ["zh-Hant", "zh", DEFAULT_LANGUAGE],
} as const
export const RESOURCES = {
	en: {
		[DEFAULT_NAMESPACE]: en,
		asset,
		language,
	},
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"zh-Hans": {
		[DEFAULT_NAMESPACE]: zhHans,
	},
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"zh-Hant": {
		[DEFAULT_NAMESPACE]: zhHant,
	},
} as const
