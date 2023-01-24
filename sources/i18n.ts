import {
	type DEFAULT_LANGUAGE,
	DEFAULT_NAMESPACE,
	FALLBACK_LANGUAGES,
	RESOURCES,
	RETURN_NULL,
} from "assets/locales"
import { EventEmitterLite, anyToError, printError } from "./util"
import i18next, { type i18n } from "i18next"
import type TerminalPlugin from "./main"
import { moment } from "obsidian"

declare module "i18next" {
	interface CustomTypeOptions {
		readonly defaultNS: typeof DEFAULT_NAMESPACE
		readonly resources: typeof RESOURCES[typeof DEFAULT_LANGUAGE]
		readonly returnNull: typeof RETURN_NULL
	}
}

export const I18N = Promise.resolve().then(async () => {
	try {
		const ret = i18next.createInstance({
			cleanCode: true,
			defaultNS: DEFAULT_NAMESPACE,
			fallbackLng: FALLBACK_LANGUAGES,
			initImmediate: true,
			nonExplicitSupportedLngs: true,
			resources: RESOURCES,
			returnNull: RETURN_NULL,
		})
		await ret.init()
		return ret
	} catch (error) {
		printError(anyToError(error), () => "i18n error")
		throw error
	}
})

export class LanguageManager {
	public readonly onChangeLanguage = new EventEmitterLite<[]>()
	#i18n = i18next
	public constructor(protected readonly plugin: TerminalPlugin) { }

	public get i18n(): i18n {
		return this.#i18n
	}

	public get language(): string {
		const { language } = this.plugin.settings
		return language === "" ? moment.locale() : language
	}

	public async load(): Promise<void> {
		this.#i18n = await I18N
		await this.#changeLanguage(this.language)
		this.plugin.register(this.plugin.on(
			"mutate-settings",
			() => this.language,
			async cur => this.#changeLanguage(cur),
		))
	}

	async #changeLanguage(language: string): Promise<void> {
		await this.i18n.changeLanguage(language)
		await this.onChangeLanguage.emit()
	}
}
