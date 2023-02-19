import { DOCUMENTATIONS, type DocumentationKey } from "./documentations"
import {
	addCommand,
	newCollabrativeState,
	printError,
} from "sources/utils/obsidian"
import { DocumentationMarkdownView } from "./view"
import type { TerminalPlugin } from "sources/main"
import { anyToError } from "sources/utils/util"

export function loadDocumentation(plugin: TerminalPlugin): void {
	const { language } = plugin,
		{ i18n } = language
	plugin.registerView(
		DocumentationMarkdownView.type.namespaced(plugin),
		leaf => new DocumentationMarkdownView(plugin, leaf),
	)
	addCommand(plugin, () => i18n.t("commands.open-readme"), {
		callback() { openDocumentation(plugin, "readme") },
		icon: i18n.t("asset:commands.open-readme-icon"),
		id: "open-readme",
	})
	addCommand(plugin, () => i18n.t("commands.open-changelog"), {
		callback() { openDocumentation(plugin, "changelog") },
		icon: i18n.t("asset:commands.open-changelog-icon"),
		id: "open-changelog",
	})
}

export function openDocumentation(
	plugin: TerminalPlugin,
	key: DocumentationKey,
	active = true,
): void {
	const { app, language, version } = plugin,
		{ workspace } = app,
		{ i18n } = language;
	(async (): Promise<void> => {
		try {
			await workspace.getLeaf("tab").setViewState({
				active,
				state: newCollabrativeState(plugin, new Map([
					[
						DocumentationMarkdownView.type, {
							data: DOCUMENTATIONS[key],
						} satisfies DocumentationMarkdownView.State,
					],
				])),
				type: DocumentationMarkdownView.type.namespaced(plugin),
			})
			if (key === "changelog" && version !== null) {
				await plugin.mutateSettings(settings => {
					settings.lastReadChangelogVersion = version
				})
				await plugin.saveSettings()
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
