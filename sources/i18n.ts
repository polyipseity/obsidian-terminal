import { defaultLanguage, defaultNamespace, resources } from "assets/locales"
import i18next from "i18next"

export const i18n = i18next.createInstance({
	cleanCode: true,
	defaultNS: defaultNamespace,
	fallbackLng: defaultLanguage,
	initImmediate: false,
	nonExplicitSupportedLngs: true,
	resources,
	returnNull: false,
}, error => {
	if (error as boolean) {
		console.error("i18n error", error)
	}
})
