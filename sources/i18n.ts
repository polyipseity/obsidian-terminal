import {
	type DEFAULT_LANGUAGE,
	DEFAULT_NAMESPACE,
	FALLBACK_LANGUAGES,
	RESOURCES,
	RETURN_NULL,
} from "assets/locales"
import { anyToError, printError } from "./util"
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

export const I18N = Promise.resolve(i18next.createInstance({
	cleanCode: true,
	defaultNS: DEFAULT_NAMESPACE,
	fallbackLng: FALLBACK_LANGUAGES,
	initImmediate: true,
	nonExplicitSupportedLngs: true,
	resources: RESOURCES,
	returnNull: RETURN_NULL,
}))
	.then(async i18n => {
		await i18n.init()
		return i18n
	})
	.catch(error => {
		printError(anyToError(error), () => "i18n error")
		throw error
	})

export class LanguageManager {
	#i18n = i18next
	readonly #uses: (() => unknown)[] = []
	public constructor(protected readonly plugin: TerminalPlugin) { }

	public get i18n(): i18n {
		return this.#i18n
	}

	public async load(): Promise<void> {
		this.#i18n = await I18N
		await this.changeLanguage(this.plugin.settings.language)
	}

	public async changeLanguage(language: string): Promise<void> {
		await this.i18n.changeLanguage(language === ""
			? moment.locale()
			: language)
		await Promise.all(this.#uses.map(use => use()))
	}

	public registerUse(use: () => unknown): () => void {
		this.#uses.push(use)
		return () => { this.#uses.remove(use) }
	}
}
