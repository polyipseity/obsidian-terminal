import { type DEFAULT_LANGUAGE, DEFAULT_NAMESPACE, FALLBACK_LANGUAGES, RESOURCES, RETURN_NULL } from "assets/locales"
import i18next from "i18next"
import { printError } from "./util"

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
		printError(error, () => "i18n error")
		throw error
	})
