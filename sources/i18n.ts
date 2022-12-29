import { DEFAULT_LANGUAGE, DEFAULT_NAMESPACE, RESOURCES } from "assets/locales"
import i18next from "i18next"

export const I18N = i18next.createInstance({
	cleanCode: true,
	defaultNS: DEFAULT_NAMESPACE,
	fallbackLng: DEFAULT_LANGUAGE,
	initImmediate: false,
	nonExplicitSupportedLngs: true,
	resources: RESOURCES,
	returnNull: false,
}, error => {
	if (error as boolean) {
		console.error("i18n error", error)
	}
})
