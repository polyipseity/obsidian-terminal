import type { PluginLocales } from "../../assets/locales.js"

declare module "i18next" {
	interface CustomTypeOptions {
		readonly defaultNS: typeof PluginLocales.DEFAULT_NAMESPACE
		readonly resources: PluginLocales.Resources
		readonly returnNull: typeof PluginLocales.RETURN_NULL
	}
}
