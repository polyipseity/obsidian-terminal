import {
	DOCUMENTATIONS,
	DOCUMENTATION_KEYS,
	type DocumentationKeys,
} from "./documentations"
import {
	addCommand,
	newCollabrativeState,
	printError,
} from "sources/utils/obsidian"
import { anyToError, logError } from "sources/utils/util"
import { DocumentationMarkdownView } from "./view"
import type { TerminalPlugin } from "sources/main"
import semverLt from "semver/functions/lt"

export function loadDocumentation(
	plugin: TerminalPlugin,
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
	plugin: TerminalPlugin,
	key: DocumentationKeys[number],
	active = true,
): void {
	const { app, language, version } = plugin,
		{ workspace } = app,
		{ i18n } = language
	workspace.onLayoutReady(async () => {
		try {
			await workspace.getLeaf("tab").setViewState({
				active,
				state: newCollabrativeState(plugin, new Map([
					[
						DocumentationMarkdownView.type, {
							data: await DOCUMENTATIONS[key],
							displayTextI18nKey: `generic.documentations.${key}`,
							iconI18nKey: `asset:generic.documentations.${key}-icon`,
						} satisfies DocumentationMarkdownView.State,
					],
				])),
				type: DocumentationMarkdownView.type.namespaced(plugin),
			})
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
	})
}
