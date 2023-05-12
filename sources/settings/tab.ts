import {
	EditDataModal,
	ListModal,
} from "sources/ui/modals"
import {
	cloneAsWritable,
	createChildElement,
	logError,
	unexpected,
} from "../utils/util"
import {
	closeSetting,
	linkSetting,
	resetButton,
	setTextToEnum,
	setTextToNumber,
} from "../ui/settings"
import { identity, isEmpty } from "lodash-es"
import { LANGUAGES } from "assets/locales"
import type { PLACEHOLDERPlugin } from "../main"
import { PluginSettingTab } from "obsidian"
import { Settings } from "./data"
import { UpdatableUI } from "sources/utils/obsidian"
import { openDocumentation } from "sources/documentation/load"
import semverLt from "semver/functions/lt"

export class SettingTab extends PluginSettingTab {
	protected readonly ui = new UpdatableUI()
	#onMutate = this.snapshot()

	public constructor(protected readonly plugin: PLACEHOLDERPlugin) {
		super(plugin.app, plugin)
		const { containerEl, ui } = this,
			{ language: { i18n, onChangeLanguage }, version } = plugin
		plugin.register(() => { ui.destroy() })
		ui.finally(onChangeLanguage.listen(() => { this.ui.update() }))
			.new(() => createChildElement(containerEl, "h1"), ele => {
				ele.textContent = i18n.t("name")
			})
			.new(() => createChildElement(containerEl, "div"), ele => {
				ele.textContent = i18n.t("settings.description")
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.language"))
					.setDesc(i18n.t("settings.language-description"))
					.addDropdown(linkSetting(
						(): string => plugin.settings.language,
						setTextToEnum(
							Settings.DEFAULTABLE_LANGUAGES,
							async value => plugin
								.mutateSettings(settingsM => { settingsM.language = value }),
						),
						() => { this.postMutate() },
						{
							pre: dropdown => {
								dropdown
									.addOption("", i18n.t("settings.language-default"))
									.addOptions(Object
										.fromEntries(LANGUAGES
											.map(lang => [lang, i18n.t(`language:${lang}`)])))
							},
						},
					))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.language-icon"),
						i18n.t("settings.reset"),
						async () => plugin
							.mutateSettings(settingsM => {
								settingsM.language = Settings.DEFAULT.language
							}),
						() => { this.postMutate() },
					))
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.documentation"))
					.addButton(button => button
						.setIcon(i18n.t("asset:settings.documentations.donate-icon"))
						.setTooltip(i18n.t("settings.documentations.donate"))
						.setCta()
						.onClick(() => {
							openDocumentation(plugin, "donate")
							closeSetting(containerEl)
						}))
					.addButton(button => button
						.setIcon(i18n.t("asset:settings.documentations.readme-icon"))
						.setTooltip(i18n.t("settings.documentations.readme"))
						.setCta()
						.onClick(() => {
							openDocumentation(plugin, "readme")
							closeSetting(containerEl)
						}))
					.addButton(button => {
						button
							.setIcon(i18n.t("asset:settings.documentations.changelog-icon"))
							.setTooltip(i18n.t("settings.documentations.changelog"))
							.onClick(() => {
								openDocumentation(plugin, "changelog")
								closeSetting(containerEl)
							})
						if (version === null ||
							semverLt(plugin.settings.lastReadChangelogVersion, version)) {
							button.setCta()
						}
					})
			})
			.newSetting(containerEl, setting => {
				// Disabling undo is required for its CTA status to work properly
				let undoable = false
				setting
					.setName(i18n.t("settings.all-settings"))
					.addButton(button => {
						button
							.setIcon(i18n.t("asset:settings.all-settings-actions.edit-icon"))
							.setTooltip(i18n.t("settings.all-settings-actions.edit"))
							.onClick(() => {
								new EditDataModal(
									plugin,
									plugin.settings,
									Settings.fix,
									{
										callback: async (settings): Promise<void> => {
											await plugin.mutateSettings(settingsM => {
												Object.assign(settingsM, settings)
											})
											this.postMutate()
										},
										title(): string {
											return i18n.t("settings.all-settings")
										},
									},
								).open()
							})
					})
					.addButton(button => {
						button
							.setIcon(i18n
								.t("asset:settings.all-settings-actions.recover-icon"))
							.setTooltip(i18n.t("settings.all-settings-actions.recover"))
							.onClick(() => {
								new ListModal(
									plugin,
									ListModal.stringInputter<readonly [string, string]>({
										back: unexpected,
										forth: value => value[1],
									}),
									unexpected,
									Object.entries(plugin.settings.recovery),
									{
										callback: async (recovery0): Promise<void> => {
											await plugin.mutateSettings(settingsM => {
												settingsM.recovery = Object.fromEntries(recovery0)
											})
											this.postMutate()
										},
										dynamicWidth: true,
										editables: ["remove"],
										namer: (value): string => value[0],
										title: (): string =>
											i18n.t("settings.all-settings-actions.recover"),
									},
								).open()
							})
						if (!isEmpty(plugin.settings.recovery)) {
							button.setCta()
						}
					})
					.addButton(resetButton(
						i18n.t("asset:settings.all-settings-actions.undo-icon"),
						i18n.t("settings.all-settings-actions.undo"),
						async () => {
							if (!undoable) { return false }
							await plugin.mutateSettings(async settingsM =>
								Object.assign(settingsM, await this.#onMutate))
							return true
						},
						() => {
							this.#onMutate = this.snapshot()
							this.postMutate()
						},
						{
							post: component => {
								this.#onMutate.then(() => {
									undoable = true
									component.setCta()
								}).catch(logError)
							},
						},
					))
					.addButton(resetButton(
						i18n.t("asset:settings.all-settings-actions.reload-icon"),
						i18n.t("settings.all-settings-actions.reload"),
						async () => plugin.mutateSettings(async settingsM =>
							plugin.loadSettings(settingsM)),
						() => { this.postMutate() },
					))
					.addButton(resetButton(
						i18n.t("asset:settings.all-settings-actions.reset-icon"),
						i18n.t("settings.all-settings-actions.reset"),
						async () => plugin
							.mutateSettings(settingsM =>
								Object.assign(settingsM, cloneAsWritable(Settings.DEFAULT))),
						() => { this.postMutate() },
					))
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.open-changelog-on-update"))
					.addToggle(linkSetting(
						() => plugin.settings.openChangelogOnUpdate,
						async value => plugin.mutateSettings(settingsM => {
							settingsM.openChangelogOnUpdate = value
						}),
						() => { this.postMutate() },
					))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.open-changelog-on-update-icon"),
						i18n.t("settings.reset"),
						async () => plugin.mutateSettings(settingsM => {
							settingsM.openChangelogOnUpdate =
								Settings.DEFAULT.openChangelogOnUpdate
						}),
						() => { this.postMutate() },
					))
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.notice-timeout"))
					.setDesc(i18n.t("settings.notice-timeout-description"))
					.addText(linkSetting(
						() => plugin.settings.noticeTimeout.toString(),
						setTextToNumber(async value => plugin.mutateSettings(settingsM => {
							settingsM.noticeTimeout = value
						})),
						() => { this.postMutate() },
					))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.notice-timeout-icon"),
						i18n.t("settings.reset"),
						async () => plugin.mutateSettings(settingsM => {
							settingsM.noticeTimeout = Settings.DEFAULT.noticeTimeout
						}),
						() => { this.postMutate() },
					))
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.error-notice-timeout"))
					.setDesc(i18n.t("settings.error-notice-timeout-description"))
					.addText(linkSetting(
						() => plugin.settings.errorNoticeTimeout.toString(),
						setTextToNumber(async value => plugin
							.mutateSettings(settingsM => {
								settingsM.errorNoticeTimeout = value
							})),
						() => { this.postMutate() },
					))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.error-notice-timeout-icon"),
						i18n.t("settings.reset"),
						async () => plugin.mutateSettings(settingsM => {
							settingsM.errorNoticeTimeout = Settings.DEFAULT.errorNoticeTimeout
						}),
						() => { this.postMutate() },
					))
			})
	}

	public display(): void {
		this.#onMutate = this.snapshot()
		this.ui.update()
	}

	protected async snapshot(): Promise<Settings.Persistent> {
		const { plugin } = this,
			snapshot = Settings.persistent(plugin.settings)
		return new Promise((resolve, reject) => {
			const unregister = plugin.on("mutate-settings", identity, () => {
				try {
					resolve(snapshot)
				} catch (error) {
					reject(error)
				} finally {
					unregister()
				}
			})
		})
	}

	protected postMutate(): void {
		const { plugin, ui } = this
		plugin.saveSettings().catch(logError)
		ui.update()
	}
}
