import "i18next"
import type { DEFAULT_LANGUAGE, DEFAULT_NAMESPACE, RESOURCES } from "assets/locales"

declare module "i18next" {
	interface CustomTypeOptions {
		readonly defaultNS: typeof DEFAULT_NAMESPACE
		readonly resources: typeof RESOURCES[typeof DEFAULT_LANGUAGE]
		readonly returnNull: false
	}
}
