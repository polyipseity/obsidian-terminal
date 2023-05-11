import type { Builtin, IsUnknown } from "ts-essentials"
import {
	capitalize,
	deepFreeze,
	typedKeys,
	uncapitalize,
} from "sources/utils/util"
import type { Exact } from "sources/utils/types"
import type en from "assets/locales/en/translation.json"

type SyncNorm<T> = T extends Builtin ? T
	// eslint-disable-next-line @typescript-eslint/ban-types
	: T extends {} ? {
		[K in keyof T as K extends `${infer K0}_${string}` ? K0 : K]: SyncNorm<T[K]>
	} : IsUnknown<T> extends true ? unknown : T
function sync<T>(translation: Exact<SyncNorm<T>, SyncNorm<typeof en>
> extends false ? never : T): T {
	// TypeScript does not check more than 2 layers...
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
})
export const FORMATTERS: Readonly<Record<string, (
	lng?: string,
	options?: unknown,
) => (value: unknown) => string>> = deepFreeze({
	capitalize: lng => value => capitalize(String(value), lng),
	uncapitalize: lng => value => uncapitalize(String(value), lng),
})

function resource<T>(importer: () => PromiseLike<{
	// eslint-disable-next-line @typescript-eslint/no-magic-numbers
	readonly default: Parameters<typeof sync<T>>[0]
}>): { readonly [DEFAULT_NAMESPACE]: () => Promise<T> } {
	return { [DEFAULT_NAMESPACE]: async () => sync((await importer()).default) }
}
// Sync with https://github.com/obsidianmd/obsidian-translations#existing-languages (e266f1f2171102e8b8c607fec7c8b494e22b25b4)
export const RESOURCES = deepFreeze({
	af: resource(async () => import("assets/locales/af/translation.json")),
	am: resource(async () => import("assets/locales/am/translation.json")),
	ar: resource(async () => import("assets/locales/ar/translation.json")),
	be: resource(async () => import("assets/locales/be/translation.json")),
	bg: resource(async () => import("assets/locales/bg/translation.json")),
	bn: resource(async () => import("assets/locales/bn/translation.json")),
	ca: resource(async () => import("assets/locales/ca/translation.json")),
	cs: resource(async () => import("assets/locales/cs/translation.json")),
	da: resource(async () => import("assets/locales/da/translation.json")),
	de: resource(async () => import("assets/locales/de/translation.json")),
	el: resource(async () => import("assets/locales/el/translation.json")),
	en: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/en/translation.json")).default),
		asset: async () => (await import("assets/locales/en/asset.json")).default,
		language: async () =>
			(await import("assets/locales/en/language.json")).default,
	},
	eo: resource(async () => import("assets/locales/eo/translation.json")),
	es: resource(async () => import("assets/locales/es/translation.json")),
	eu: resource(async () => import("assets/locales/eu/translation.json")),
	fa: resource(async () => import("assets/locales/fa/translation.json")),
	fi: resource(async () => import("assets/locales/fi/translation.json")),
	fr: resource(async () => import("assets/locales/fr/translation.json")),
	gl: resource(async () => import("assets/locales/gl/translation.json")),
	he: resource(async () => import("assets/locales/he/translation.json")),
	hi: resource(async () => import("assets/locales/hi/translation.json")),
	hu: resource(async () => import("assets/locales/hu/translation.json")),
	id: resource(async () => import("assets/locales/id/translation.json")),
	it: resource(async () => import("assets/locales/it/translation.json")),
	ja: resource(async () => import("assets/locales/ja/translation.json")),
	ko: resource(async () => import("assets/locales/ko/translation.json")),
	lv: resource(async () => import("assets/locales/lv/translation.json")),
	ml: resource(async () => import("assets/locales/ml/translation.json")),
	ms: resource(async () => import("assets/locales/ms/translation.json")),
	nl: resource(async () => import("assets/locales/nl/translation.json")),
	no: resource(async () => import("assets/locales/no/translation.json")),
	oc: resource(async () => import("assets/locales/oc/translation.json")),
	pl: resource(async () => import("assets/locales/pl/translation.json")),
	pt: resource(async () => import("assets/locales/pt/translation.json")),
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"pt-BR": resource(async () =>
		import("assets/locales/pt-BR/translation.json")),
	ro: resource(async () => import("assets/locales/ro/translation.json")),
	ru: resource(async () => import("assets/locales/ru/translation.json")),
	se: resource(async () => import("assets/locales/se/translation.json")),
	sk: resource(async () => import("assets/locales/sk/translation.json")),
	sq: resource(async () => import("assets/locales/sq/translation.json")),
	sr: resource(async () => import("assets/locales/sr/translation.json")),
	ta: resource(async () => import("assets/locales/ta/translation.json")),
	te: resource(async () => import("assets/locales/te/translation.json")),
	th: resource(async () => import("assets/locales/th/translation.json")),
	tr: resource(async () => import("assets/locales/tr/translation.json")),
	uk: resource(async () => import("assets/locales/uk/translation.json")),
	ur: resource(async () => import("assets/locales/ur/translation.json")),
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"zh-Hans": resource(async () =>
		import("assets/locales/zh-Hans/translation.json")),
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"zh-Hant": resource(async () =>
		import("assets/locales/zh-Hant/translation.json")),
})
export type DefaultResources = {
	[K in
	keyof typeof RESOURCES[
	typeof DEFAULT_LANGUAGE]]: Awaited<ReturnType<typeof RESOURCES[
		typeof DEFAULT_LANGUAGE][K]>>
}
export type Namespaces = readonly ["translation", "language", "asset"]
export const NAMESPACES = typedKeys<Namespaces>()(RESOURCES[DEFAULT_LANGUAGE])
export type Languages = readonly [
	"af",
	"am",
	"ar",
	"be",
	"bg",
	"bn",
	"ca",
	"cs",
	"da",
	"de",
	"el",
	"en",
	"eo",
	"es",
	"eu",
	"fa",
	"fi",
	"fr",
	"gl",
	"he",
	"hi",
	"hu",
	"id",
	"it",
	"ja",
	"ko",
	"lv",
	"ml",
	"ms",
	"nl",
	"no",
	"oc",
	"pl",
	"pt",
	"pt-BR",
	"ro",
	"ru",
	"se",
	"sk",
	"sq",
	"sr",
	"ta",
	"te",
	"th",
	"tr",
	"uk",
	"ur",
	"zh-Hans",
	"zh-Hant",
]
export const LANGUAGES = typedKeys<keyof Awaited<ReturnType<
	typeof RESOURCES[typeof DEFAULT_LANGUAGE]["language"]
>> extends Languages[number] ? Languages : never>()(RESOURCES)
