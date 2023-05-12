import {
	DEFAULT_NAMESPACE,
	FALLBACK_LANGUAGES,
	FORMATTERS, LANGUAGES,
	NAMESPACES,
	RESOURCES,
	RETURN_NULL,
} from "assets/locales"
import { EventEmitterLite, anyToError, inSet, typedIn } from "./utils/util"
import i18next, {
	type TFuncKey,
	type TypeOptions,
	createInstance,
	type i18n,
} from "i18next"
import type { PLACEHOLDERPlugin } from "./main"
import { moment } from "obsidian"
import { printError } from "./utils/obsidian"
import resourcesToBackend from "i18next-resources-to-backend"

export type NamespacedTranslationKey =
	TFuncKey<(keyof TypeOptions["resources"])[]>

export const I18N = (async (): Promise<i18n> => {
	try {
		const missingTranslationKey = "errors.missing-translation"
		let missingInterpolationHandlerReentrant = false
		const ret = createInstance({
			cleanCode: true,
			defaultNS: DEFAULT_NAMESPACE,
			fallbackLng: FALLBACK_LANGUAGES,
			initImmediate: true,
			missingInterpolationHandler(text, value: RegExpExecArray) {
				if (missingInterpolationHandlerReentrant) {
					self.console.warn(value, text)
				} else {
					missingInterpolationHandlerReentrant = true
					try {
						self.console.warn(ret.t("errors.missing-interpolation", {
							interpolation: { escapeValue: false },
							name: value[1],
							text,
							value: value[0],
						}))
					} finally {
						missingInterpolationHandlerReentrant = false
					}
				}
				return value[0]
			},
			nonExplicitSupportedLngs: true,
			ns: NAMESPACES,
			parseMissingKeyHandler(key, defaultValue) {
				if (key === missingTranslationKey) {
					self.console.warn(key, defaultValue)
				} else {
					self.console.warn(ret.t(missingTranslationKey, {
						interpolation: { escapeValue: false },
						key,
						value: defaultValue ?? key,
					}))
				}
				return defaultValue ?? key
			},
			returnNull: RETURN_NULL,
		}).use(resourcesToBackend(async (
			language: string,
			namespace: string,
		) => {
			if (inSet(LANGUAGES, language)) {
				const lngRes = RESOURCES[language],
					res = typedIn(lngRes, namespace)
				if (res) { return res()() }
			}
			return null
		}))
		await ret.init()
		const { services } = ret,
			{ formatter } = services
		for (const [key, value] of Object.entries(FORMATTERS)) {
			formatter?.addCached(key, value)
		}
		return ret
	} catch (error) {
		printError(anyToError(error), () => "i18n error")
		throw error
	}
})()

export class LanguageManager {
	public readonly onChangeLanguage = new EventEmitterLite<readonly [string]>()
	#i18n = i18next
	public constructor(protected readonly plugin: PLACEHOLDERPlugin) { }

	public get i18n(): i18n {
		return this.#i18n
	}

	public get language(): string {
		return LanguageManager.interpretLanguage(this.plugin.settings.language)
	}

	protected static interpretLanguage(language: string): string {
		return language || moment.locale() || language
	}

	public async load(): Promise<void> {
		this.#i18n = await I18N
		const { plugin, language } = this
		plugin.register(plugin.on(
			"mutate-settings",
			settings => settings.language,
			async cur => this.changeLanguage(cur),
		))
		await this.changeLanguage(language)
	}

	protected async changeLanguage(language: string): Promise<void> {
		const lng = LanguageManager.interpretLanguage(language)
		await this.i18n.changeLanguage(lng)
		await this.onChangeLanguage.emit(lng)
	}
}
