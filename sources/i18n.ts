import { DEFAULT_LANGUAGE, DEFAULT_NAMESPACE, RESOURCES } from "assets/locales"
import i18next from "i18next"
import { printError } from "./util"

declare module "i18next" {
	interface CustomTypeOptions {
		readonly defaultNS: typeof DEFAULT_NAMESPACE
		readonly resources: typeof RESOURCES[typeof DEFAULT_LANGUAGE]
		readonly returnNull: false
	}
}

const I18N = Promise.resolve(i18next.createInstance({
	cleanCode: true,
	defaultNS: DEFAULT_NAMESPACE,
	fallbackLng: DEFAULT_LANGUAGE,
	initImmediate: true,
	nonExplicitSupportedLngs: true,
	resources: RESOURCES,
	returnNull: false,
}))
	.then(async i18n => {
		await i18n.init()
		return i18n
	})
	.catch(error => {
		printError(error, "i18n error")
		throw error
	})
export default I18N
