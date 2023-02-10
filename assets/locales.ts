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
import { deepFreeze, typedKeys } from "sources/utils/util"
import type { Exact } from "ts-essentials"

function sanitize<T extends object>(value: T): T {
	return Object.freeze(Object.fromEntries(Object.entries(value)
		.filter(([_0, val]) => typeof val === "string")) as T)
}

type FilterKey<K> = K extends `${infer K0}_${string}` ? K0 : K
type SyncNorm<T> = {
	readonly [key in keyof T as FilterKey<key>]: SyncNorm<T[key]>
}
function sync<T>(translation: Exact<SyncNorm<T>, SyncNorm<typeof en>
> extends never ? never : T): T {
	// Odd bug: does not check more than 2 layers
	return translation
}

export const RETURN_NULL = false
export const DEFAULT_NAMESPACE = "translation"
export const DEFAULT_LANGUAGE = "en"
export const FALLBACK_LANGUAGES = deepFreeze({
	"default": [DEFAULT_LANGUAGE],
	zh: ["zh-Hans", DEFAULT_LANGUAGE],
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"zh-CN": ["zh-Hans", "zh", DEFAULT_LANGUAGE],
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"zh-TW": ["zh-Hant", "zh", DEFAULT_LANGUAGE],
} as const)
// Add those with ✅ in https://github.com/obsidianmd/obsidian-translations#existing-languages
export const RESOURCES = deepFreeze({
	am: { [DEFAULT_NAMESPACE]: sync(am) },
	cs: { [DEFAULT_NAMESPACE]: sync(cs) },
	da: { [DEFAULT_NAMESPACE]: sync(da) },
	de: { [DEFAULT_NAMESPACE]: sync(de) },
	en: {
		[DEFAULT_NAMESPACE]: sync(en),
		asset,
		language: sanitize(language),
	},
	es: { [DEFAULT_NAMESPACE]: sync(es) },
	fa: { [DEFAULT_NAMESPACE]: sync(fa) },
	fr: { [DEFAULT_NAMESPACE]: sync(fr) },
	id: { [DEFAULT_NAMESPACE]: sync(id) },
	it: { [DEFAULT_NAMESPACE]: sync(it) },
	ja: { [DEFAULT_NAMESPACE]: sync(ja) },
	ko: { [DEFAULT_NAMESPACE]: sync(ko) },
	nl: { [DEFAULT_NAMESPACE]: sync(nl) },
	no: { [DEFAULT_NAMESPACE]: sync(no) },
	pl: { [DEFAULT_NAMESPACE]: sync(pl) },
	pt: { [DEFAULT_NAMESPACE]: sync(pt) },
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"pt-BR": { [DEFAULT_NAMESPACE]: sync(ptBR) },
	ro: { [DEFAULT_NAMESPACE]: sync(ro) },
	ru: { [DEFAULT_NAMESPACE]: sync(ru) },
	sq: { [DEFAULT_NAMESPACE]: sync(sq) },
	th: { [DEFAULT_NAMESPACE]: sync(th) },

	tr: { [DEFAULT_NAMESPACE]: sync(tr) },
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"zh-Hans": { [DEFAULT_NAMESPACE]: sync(zhHans) },
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"zh-Hant": { [DEFAULT_NAMESPACE]: sync(zhHant) },
} as const)
export const LANGUAGES = typedKeys<[
	"am",
	"cs",
	"da",
	"de",
	"en",
	"es",
	"fa",
	"fr",
	"id",
	"it",
	"ja",
	"ko",
	"nl",
	"no",
	"pl",
	"pt",
	"pt-BR",
	"ro",
	"ru",
	"sq",
	"th",
	"tr",
	"zh-Hans",
	"zh-Hant",
]>()(RESOURCES[DEFAULT_LANGUAGE].language);
(function selectable(_languages: readonly (keyof typeof RESOURCES)[]): void {
	// NOOP
}(LANGUAGES))
export type Language = typeof LANGUAGES[number]
