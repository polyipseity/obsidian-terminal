import "i18next"
import type { defaultLanguage, defaultNamespace, resources } from "assets/locales"

declare module "i18next" {
	interface CustomTypeOptions {
		defaultNS: typeof defaultNamespace
		resources: typeof resources[typeof defaultLanguage]
		returnNull: false
	}
}
