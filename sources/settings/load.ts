import {
	DOUBLE_ACTION_TIMEOUT,
	FileExtensions,
	JSON_STRINGIFY_SPACE,
} from "sources/magic"
import {
	addCommand,
	cleanFrontmatterCache,
	printError,
} from "sources/utils/obsidian"
import { anyToError, clearProperties, length } from "sources/utils/util"
import { DialogModal } from "sources/ui/modals"
import { SettingTab } from "./tab"
import type { TerminalPlugin } from "sources/main"
import deepEqual from "deep-equal"

export function loadSettings(plugin: TerminalPlugin): void {
	const { app, language } = plugin,
		{ workspace, metadataCache, fileManager } = app,
		{ i18n } = language
	plugin.addSettingTab(new SettingTab(plugin))
	addCommand(plugin, () => i18n.t("commands.export-settings-to-clipboard"), {
		callback() {
			(async (): Promise<void> => {
				try {
					await navigator.clipboard.writeText(JSON.stringify(
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
		id: "export-settings-to-clipboard",
	})
	addCommand(plugin, () => i18n.t("commands.export-settings-to-current-file"), {
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
								{ file },
							), plugin)
						})
					}
				if (length(cachedFm) === 0) {
					process()
				} else {
					new DialogModal(plugin, {
						confirm(close): void {
							close()
							process()
						},
						doubleConfirmTimeout: DOUBLE_ACTION_TIMEOUT,
						draw(ui, self): void {
							ui.new(() => self.contentEl.createEl("div"), ele => {
								ele.textContent =
									i18n.t("dialogs.overwrite-existing-frontmatter")
							})
						},
					}).open()
				}
			}
			return true
		},
		id: "export-settings-to-current-file",
	})
	addCommand(plugin, () => i18n.t("commands.import-settings-from-clipboard"), {
		callback() {
			(async (): Promise<void> => {
				try {
					await plugin.mutateSettings(async settings =>
						plugin.loadSettings(settings, async () => {
							const ret: unknown =
								JSON.parse(await navigator.clipboard.readText())
							return ret
						}))
				} catch (error) {
					printError(anyToError(error), () =>
						i18n.t("errors.error-importing-settings"), plugin)
				}
			})()
		},
		id: "import-settings-from-clipboard",
	})
	addCommand(plugin, () =>
		i18n.t("commands.import-settings-from-current-file"), {
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
					} catch (error) {
						printError(anyToError(error), () =>
							i18n.t("errors.error-importing-settings"), plugin)
					}
				})()
			}
			return true
		},
		id: "import-settings-from-current-file",
	})
}
