import {
	DOCUMENTATIONS,
	DOCUMENTATION_KEYS,
	type DocumentationKeys,
} from "./documentations"
import { addCommand, printError } from "sources/utils/obsidian"
import { anyToError, logError } from "sources/utils/util"
import { DocumentationMarkdownView } from "./view"
import type { PLACEHOLDERPlugin } from "sources/main"
import semverLt from "semver/functions/lt"

export function loadDocumentation(
	plugin: PLACEHOLDERPlugin,
	readme = false,
): void {
	const { language, version } = plugin,
		{ i18n } = language
	plugin.registerView(
		DocumentationMarkdownView.type.namespaced(plugin),
		leaf => new DocumentationMarkdownView(plugin, leaf),
	)
	for (const doc of DOCUMENTATION_KEYS) {
		addCommand(plugin, () => i18n.t(`commands.open-documentation-${doc}`), {
			callback() { openDocumentation(plugin, doc) },
			icon: i18n.t(`asset:commands.open-documentation-${doc}-icon`),
			id: `open-documentation.${doc}`,
		})
	}
	if (readme) { openDocumentation(plugin, "readme", false) }
	if (version !== null &&
		plugin.settings.openChangelogOnUpdate &&
		semverLt(plugin.settings.lastReadChangelogVersion, version)) {
		openDocumentation(plugin, "changelog", false)
	}
}

export function openDocumentation(
	plugin: PLACEHOLDERPlugin,
	key: DocumentationKeys[number],
	active = true,
): void {
	const { version, language: { i18n } } = plugin;
	(async (): Promise<void> => {
		try {
			await DOCUMENTATIONS[key](plugin, active)
			if (key === "changelog" && version !== null) {
				plugin.mutateSettings(settings => {
					settings.lastReadChangelogVersion = version
				}).then(async () => plugin.saveSettings())
					.catch(logError)
			}
		} catch (error) {
			printError(
				anyToError(error),
				() => i18n.t("errors.error-opening-documentation"),
				plugin,
			)
		}
	})()
}
