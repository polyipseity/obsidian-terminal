import { DEFAULT_SETTINGS, Settings } from "./data"
import { ListModal, ProfileListModal } from "sources/ui/modals"
import {
	capitalize,
	cloneAsWritable,
	executeParanoidly,
	identity,
	length,
	unexpected,
} from "../utils/util"
import {
	linkSetting,
	resetButton,
	setTextToEnum,
	setTextToNumber,
} from "../ui/settings"
import { LANGUAGES } from "assets/locales"
import { PluginSettingTab } from "obsidian"
import type { TerminalPlugin } from "../main"
import { UpdatableUI } from "sources/utils/obsidian"

export class SettingTab extends PluginSettingTab {
	protected readonly ui = new UpdatableUI()
	#onMutate = this.snapshot()

	public constructor(protected readonly plugin: TerminalPlugin) {
		super(plugin.app, plugin)
		const { containerEl, ui } = this,
			{ language } = plugin,
			{ i18n } = language
		plugin.register(() => { ui.clear() })
		ui
			.new(() => containerEl.createEl("h1"), ele => {
				ele.textContent = i18n.t("name")
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
						plugin,
						i18n.t("asset:settings.language-icon"),
						async () => plugin
							.mutateSettings(settingsM => {
								settingsM.language = DEFAULT_SETTINGS.language
							}),
						() => { this.postMutate() },
					))
			})
			.newSetting(containerEl, setting => {
				// Disabling undo is required for its CTA status to work properly
				let undoable = false
				setting
					.setName(i18n.t("settings.all-settings"))
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
									Object.entries(plugin.settings.recovery ?? {}),
									{
										callback: async (recovery0): Promise<void> => {
											await plugin.mutateSettings(settingsM => {
												settingsM.recovery = Object.fromEntries(recovery0)
											})
											this.postMutate()
										},
										editables: ["remove"],
										namer: (value): string => value[0],
										title: (): string =>
											i18n.t("settings.all-settings-actions.recover"),
									},
								).open()
							})
						if (length(plugin.settings.recovery ?? {}) > 0) {
							button.setCta()
						}
					})
					.addButton(resetButton(
						plugin,
						i18n.t("asset:settings.all-settings-actions.undo-icon"),
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
								component
									.setTooltip(i18n.t("settings.all-settings-actions.undo"))
								this.#onMutate.then(() => {
									undoable = true
									component.setCta()
								}).catch(error => { console.error(error) })
							},
						},
					))
					.addButton(resetButton(
						plugin,
						i18n.t("asset:settings.all-settings-actions.reload-icon"),
						async () => plugin.mutateSettings(async settingsM =>
							plugin.loadSettings(settingsM)),
						() => { this.postMutate() },
						{
							post: component => {
								component
									.setTooltip(i18n.t("settings.all-settings-actions.reload"))
							},
						},
					))
					.addButton(resetButton(
						plugin,
						i18n.t("asset:settings.all-settings-actions.reset-icon"),
						async () => plugin
							.mutateSettings(settingsM =>
								Object.assign(settingsM, cloneAsWritable(DEFAULT_SETTINGS))),
						() => { this.postMutate() },
						{
							post: component => {
								component
									.setTooltip(i18n.t("settings.all-settings-actions.reset"))
							},
						},
					))
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.add-to-command"))
					.addToggle(linkSetting(
						() => plugin.settings.addToCommand,
						async value => plugin
							.mutateSettings(settingsM => { settingsM.addToCommand = value }),
						() => { this.postMutate() },
					))
					.addExtraButton(resetButton(
						plugin,
						i18n.t("asset:settings.add-to-command-icon"),
						async () => plugin
							.mutateSettings(settingsM => {
								settingsM.addToCommand = DEFAULT_SETTINGS.addToCommand
							}),
						() => { this.postMutate() },
					))
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.add-to-context-menu"))
					.addToggle(linkSetting(
						() => plugin.settings.addToContextMenu,
						async value => plugin.mutateSettings(settingsM => {
							settingsM.addToContextMenu = value
						}),
						() => { this.postMutate() },
					))
					.addExtraButton(resetButton(
						plugin,
						i18n.t("asset:settings.add-to-context-menu-icon"),
						async () => plugin
							.mutateSettings(settingsM => {
								settingsM.addToContextMenu = DEFAULT_SETTINGS.addToContextMenu
							}),
						() => { this.postMutate() },
					))
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.hide-status-bar"))
					.addDropdown(linkSetting(
						(): string => plugin.settings.hideStatusBar,
						setTextToEnum(
							Settings.HIDE_STATUS_BAR_OPTIONS,
							async value => plugin.mutateSettings(settingsM => {
								settingsM.hideStatusBar = value
							}),
						),
						() => { this.postMutate() },
						{
							pre: dropdown => {
								dropdown
									.addOptions(Object
										.fromEntries(Settings.HIDE_STATUS_BAR_OPTIONS
											.map(value => [
												value,
												i18n.t(`settings.hide-status-bar-options.${value}`),
											])))
							},
						},
					))
					.addExtraButton(resetButton(
						plugin,
						i18n.t("asset:settings.hide-status-bar-icon"),
						async () => plugin.mutateSettings(settingsM => {
							settingsM.hideStatusBar = DEFAULT_SETTINGS.hideStatusBar
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
						plugin,
						i18n.t("asset:settings.notice-timeout-icon"),
						async () => plugin.mutateSettings(settingsM => {
							settingsM.noticeTimeout = DEFAULT_SETTINGS.noticeTimeout
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
						plugin,
						i18n.t("asset:settings.error-notice-timeout-icon"),
						async () => plugin.mutateSettings(settingsM => {
							settingsM.errorNoticeTimeout = DEFAULT_SETTINGS.errorNoticeTimeout
						}),
						() => { this.postMutate() },
					))
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.profiles"))
					.setDesc(i18n.t("settings.list-description", {
						count: length(plugin.settings.profiles),
					}))
					.addButton(button => button
						.setIcon(i18n.t("asset:generic.edit-list-icon"))
						.setTooltip(i18n.t("generic.edit"))
						.onClick(() => {
							new ProfileListModal(
								plugin,
								Object.entries(plugin.settings.profiles),
								async data => {
									await plugin.mutateSettings(settingsM => {
										settingsM.profiles = Object.fromEntries(data)
									})
									this.postMutate()
								},
							).open()
						}))
					.addExtraButton(resetButton(
						plugin,
						i18n.t("asset:settings.profiles-icon"),
						async () => plugin.mutateSettings(settingsM => {
							settingsM.profiles = cloneAsWritable(DEFAULT_SETTINGS.profiles)
						}),
						() => { this.postMutate() },
					))
			})
			.new(() => containerEl.createEl("h2"), ele => {
				ele.textContent = i18n.t("settings.advanced-settings")
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.preferred-renderer"))
					.addDropdown(linkSetting(
						(): string => plugin.settings.preferredRenderer,
						setTextToEnum(
							Settings.PREFERRED_RENDERER_OPTIONS,
							async value => plugin.mutateSettings(settingsM => {
								settingsM.preferredRenderer = value
							}),
						),
						() => { this.postMutate() },
						{
							pre: dropdown => {
								dropdown
									.addOptions(Object
										.fromEntries(Settings.PREFERRED_RENDERER_OPTIONS
											.map(value => [
												value,
												capitalize(
													i18n.t(`types.renderers.${value}`),
													language.language,
												),
											])))
							},
						},
					))
					.addExtraButton(resetButton(
						plugin,
						i18n.t("asset:settings.preferred-renderer-icon"),
						async () => plugin.mutateSettings(settingsM => {
							settingsM.preferredRenderer = DEFAULT_SETTINGS.preferredRenderer
						}),
						() => { this.postMutate() },
					))
			})
			.finally(language.onChangeLanguage.listen(() => { this.display() }))
	}

	public override hide(): void {
		super.hide()
		this.#onMutate = this.snapshot()
	}

	public display(): void {
		this.ui.update()
	}

	protected async snapshot(): Promise<Settings> {
		const { plugin } = this,
			snapshot = cloneAsWritable(plugin.settings)
		delete snapshot.recovery
		return new Promise<Settings>(executeParanoidly((
			resolve,
			reject,
		) => {
			const unregister = plugin.on("mutate-settings", identity, () => {
				try {
					resolve(snapshot)
				} catch (error) {
					reject(error)
				} finally {
					unregister()
				}
			})
			plugin.register(unregister)
		}))
	}

	protected postMutate(): void {
		this.plugin.saveSettings().catch(error => { console.error(error) })
		this.display()
	}
}
