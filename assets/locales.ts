import * as am from "assets/locales/am/translation.json"
import * as asset from "assets/locales/en/asset.json"
import * as cs from "assets/locales/cs/translation.json"
import * as da from "assets/locales/da/translation.json"
import * as de from "assets/locales/de/translation.json"
import * as en from "assets/locales/en/translation.json"
import * as es from "assets/locales/es/translation.json"
import * as fa from "assets/locales/fa/translation.json"
import * as fr from "assets/locales/fr/translation.json"
import * as id from "assets/locales/id/translation.json"
import * as it from "assets/locales/it/translation.json"
import * as ja from "assets/locales/ja/translation.json"
import * as ko from "assets/locales/ko/translation.json"
import * as language from "assets/locales/en/language.json"
import * as nl from "assets/locales/nl/translation.json"
import * as no from "assets/locales/no/translation.json"
import * as pl from "assets/locales/pl/translation.json"
import * as pt from "assets/locales/pt/translation.json"
import * as ptBR from "assets/locales/pt-BR/translation.json"
import * as ro from "assets/locales/ro/translation.json"
import * as ru from "assets/locales/ru/translation.json"
import * as sq from "assets/locales/sq/translation.json"
import * as th from "assets/locales/th/translation.json"
import * as tr from "assets/locales/tr/translation.json"
import * as zhHans from "assets/locales/zh-Hans/translation.json"
import * as zhHant from "assets/locales/zh-Hant/translation.json"

function checkSynchronized(translation: typeof en): typeof en {
	return translation
}

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
// Add those with ✅ in https://github.com/obsidianmd/obsidian-translations#existing-languages
export const RESOURCES = {
	am: { [DEFAULT_NAMESPACE]: checkSynchronized(am) },
	cs: { [DEFAULT_NAMESPACE]: checkSynchronized(cs) },
	da: { [DEFAULT_NAMESPACE]: checkSynchronized(da) },
	de: { [DEFAULT_NAMESPACE]: checkSynchronized(de) },
	en: {
		[DEFAULT_NAMESPACE]: checkSynchronized(en),
		asset,
		language,
	},
	es: { [DEFAULT_NAMESPACE]: checkSynchronized(es) },
	fa: { [DEFAULT_NAMESPACE]: checkSynchronized(fa) },
	fr: { [DEFAULT_NAMESPACE]: checkSynchronized(fr) },
	id: { [DEFAULT_NAMESPACE]: checkSynchronized(id) },
	it: { [DEFAULT_NAMESPACE]: checkSynchronized(it) },
	ja: { [DEFAULT_NAMESPACE]: checkSynchronized(ja) },
	ko: { [DEFAULT_NAMESPACE]: checkSynchronized(ko) },
	nl: { [DEFAULT_NAMESPACE]: checkSynchronized(nl) },
	no: { [DEFAULT_NAMESPACE]: checkSynchronized(no) },
	pl: { [DEFAULT_NAMESPACE]: checkSynchronized(pl) },
	pt: { [DEFAULT_NAMESPACE]: checkSynchronized(pt) },
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"pt-BR": { [DEFAULT_NAMESPACE]: checkSynchronized(ptBR) },
	ro: { [DEFAULT_NAMESPACE]: checkSynchronized(ro) },
	ru: { [DEFAULT_NAMESPACE]: checkSynchronized(ru) },
	sq: { [DEFAULT_NAMESPACE]: checkSynchronized(sq) },
	th: { [DEFAULT_NAMESPACE]: checkSynchronized(th) },
	tr: { [DEFAULT_NAMESPACE]: checkSynchronized(tr) },
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"zh-Hans": { [DEFAULT_NAMESPACE]: checkSynchronized(zhHans) },
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"zh-Hant": { [DEFAULT_NAMESPACE]: checkSynchronized(zhHant) },
} as const;
(function checkLanguage(_language: {
	readonly [key in keyof typeof RESOURCES]: string
}): void {
	// NOOP
}(RESOURCES[DEFAULT_LANGUAGE].language))
