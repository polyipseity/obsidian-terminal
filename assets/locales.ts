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
} as const)
export const FORMATTERS: Readonly<Record<string, (
	lng?: string,
	options?: unknown,
) => (value: unknown) => string>> = deepFreeze({
	capitalize: lng => value => capitalize(String(value), lng),
	uncapitalize: lng => value => uncapitalize(String(value), lng),
} as const)

// Add those with ✅ in https://github.com/obsidianmd/obsidian-translations#existing-languages
export const RESOURCES = deepFreeze({
	am: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/am/translation.json")).default),
	},
	cs: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/cs/translation.json")).default),
	},
	da: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/da/translation.json")).default),
	},
	de: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/de/translation.json")).default),
	},
	en: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/en/translation.json")).default),
		asset: async () =>
			(await import("assets/locales/en/asset.json")).default,
		language: async () =>
			(await import("assets/locales/en/language.json")).default,
	},
	es: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/es/translation.json")).default),
	},
	fa: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/fa/translation.json")).default),
	},
	fr: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/fr/translation.json")).default),
	},
	id: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/id/translation.json")).default),
	},
	it: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/it/translation.json")).default),
	},
	ja: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/ja/translation.json")).default),
	},
	ko: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/ko/translation.json")).default),
	},
	nl: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/nl/translation.json")).default),
	},
	no: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/no/translation.json")).default),
	},
	pl: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/pl/translation.json")).default),
	},
	pt: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/pt/translation.json")).default),
	},
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"pt-BR": {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/pt-BR/translation.json")).default),
	},
	ro: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/ro/translation.json")).default),
	},
	ru: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/ru/translation.json")).default),
	},
	sq: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/sq/translation.json")).default),
	},
	th: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/th/translation.json")).default),
	},
	tr: {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/tr/translation.json")).default),
	},
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"zh-Hans": {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/zh-Hans/translation.json")).default),
	},
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"zh-Hant": {
		[DEFAULT_NAMESPACE]: async () =>
			sync((await import("assets/locales/zh-Hant/translation.json")).default),
	},
} as const)
export type DefaultResources = {
	[K in
	keyof typeof RESOURCES[
	typeof DEFAULT_LANGUAGE]]: Awaited<ReturnType<typeof RESOURCES[
		typeof DEFAULT_LANGUAGE][K]>>
}
export type Namespaces = readonly ["translation", "language", "asset"]
export const NAMESPACES = typedKeys<Namespaces>()(RESOURCES[DEFAULT_LANGUAGE])
export type Languages = readonly [
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
]
export const LANGUAGES = typedKeys<keyof Awaited<ReturnType<
	typeof RESOURCES[typeof DEFAULT_LANGUAGE]["language"]
>> extends Languages[number] ? Languages : never>()(RESOURCES)
