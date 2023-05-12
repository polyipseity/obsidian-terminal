import {
	DOUBLE_ACTION_WAIT,
	FileExtensions,
	JSON_STRINGIFY_SPACE,
} from "sources/magic"
import {
	addCommand,
	cleanFrontmatterCache,
	printError,
} from "sources/utils/obsidian"
import {
	anyToError,
	clearProperties,
	createChildElement,
	logError,
} from "sources/utils/util"
import { DialogModal } from "sources/ui/modals"
import type { PLACEHOLDERPlugin } from "sources/main"
import { SettingTab } from "./tab"
import deepEqual from "deep-equal"
import { isEmpty } from "lodash-es"

export function loadSettings(plugin: PLACEHOLDERPlugin): void {
	const { app, language } = plugin,
		{ workspace, metadataCache, fileManager } = app,
		{ i18n } = language
	plugin.addSettingTab(new SettingTab(plugin))
	addCommand(plugin, () => i18n.t("commands.export-settings-clipboard"), {
		callback() {
			(async (): Promise<void> => {
				try {
					await self.activeWindow.navigator.clipboard.writeText(JSON.stringify(
						plugin.settings,
						null,
						JSON_STRINGIFY_SPACE,
					))
				} catch (error) {
					printError(anyToError(error), () =>
						i18n.t("errors.error-exporting-settings"), plugin)
				}
			})()
		},
		icon: i18n.t("asset:commands.export-settings-clipboard-icon"),
		id: "export-settings.clipboard",
	})
	addCommand(plugin, () => i18n.t("commands.export-settings-current-file"), {
		checkCallback(checking) {
			const file = workspace.getActiveFile()
			if (file?.extension !== FileExtensions.MARKDOWN) { return false }
			if (!checking) {
				const cachedFm =
					cleanFrontmatterCache(metadataCache.getFileCache(file)?.frontmatter),
					process = (): void => {
						fileManager.processFrontMatter(file, (fm: object) => {
							if (!deepEqual(fm, cachedFm, { strict: true })) {
								throw new Error(i18n.t("errors.retry-outdated-frontmatter"))
							}
							clearProperties(fm)
							Object.assign(fm, plugin.settings)
						}).catch(error => {
							printError(anyToError(error), () => i18n.t(
								"errors.error-processing-frontmatter",
								{
									file,
									interpolation: { escapeValue: false },
								},
							), plugin)
						})
					}
				if (isEmpty(cachedFm)) {
					process()
				} else {
					new DialogModal(plugin, {
						confirm(close): void {
							close()
							process()
						},
						doubleConfirmTimeout: DOUBLE_ACTION_WAIT,
						draw(ui, element): void {
							ui.new(() => createChildElement(element, "div"), ele => {
								ele.textContent =
									i18n.t("dialogs.overwrite-existing-frontmatter")
							}, ele => { ele.remove() })
						},
						title(): string {
							return i18n.t("commands.export-settings-current-file")
						},
					}).open()
				}
			}
			return true
		},
		icon: i18n.t("asset:commands.export-settings-current-file-icon"),
		id: "export-settings.current-file",
	})
	addCommand(plugin, () => i18n.t("commands.import-settings-clipboard"), {
		callback() {
			(async (): Promise<void> => {
				try {
					await plugin.mutateSettings(async settings =>
						plugin.loadSettings(settings, async () => {
							const ret: unknown = JSON.parse(
								await self.activeWindow.navigator.clipboard.readText(),
							)
							return ret
						}))
					plugin.saveSettings().catch(logError)
				} catch (error) {
					printError(anyToError(error), () =>
						i18n.t("errors.error-importing-settings"), plugin)
				}
			})()
		},
		icon: i18n.t("asset:commands.import-settings-clipboard-icon"),
		id: "import-settings.clipboard",
	})
	addCommand(plugin, () =>
		i18n.t("commands.import-settings-current-file"), {
		checkCallback(checking) {
			const file = workspace.getActiveFile()
			if (file?.extension !== FileExtensions.MARKDOWN) { return false }
			if (!checking) {
				(async (): Promise<void> => {
					try {
						await plugin.mutateSettings(async settings =>
							plugin.loadSettings(settings, () =>
								cleanFrontmatterCache(
									metadataCache.getFileCache(file)?.frontmatter,
								)))
						plugin.saveSettings().catch(logError)
					} catch (error) {
						printError(anyToError(error), () =>
							i18n.t("errors.error-importing-settings"), plugin)
					}
				})()
			}
			return true
		},
		icon: i18n.t("asset:commands.import-settings-current-file-icon"),
		id: "import-settings.current-file",
	})
}
