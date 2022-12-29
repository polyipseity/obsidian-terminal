import "i18next"
import type { defaultLanguage, defaultNamespace, resources } from "assets/locales"

declare module "i18next" {
	interface CustomTypeOptions {
		readonly defaultNS: typeof defaultNamespace
		readonly resources: typeof resources[typeof defaultLanguage]
		readonly returnNull: false
	}
}
