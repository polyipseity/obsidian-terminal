import type {
	DEFAULT_NAMESPACE,
	DefaultResources,
	RETURN_NULL,
} from "assets/locales"

declare module "i18next" {
	interface CustomTypeOptions {
		readonly defaultNS: typeof DEFAULT_NAMESPACE
		readonly resources: DefaultResources
		readonly returnNull: typeof RETURN_NULL
	}
}
