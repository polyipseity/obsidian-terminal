import { DEFAULT_SETTINGS, Settings } from "./data"
import { PluginSettingTab, Setting } from "obsidian"
import {
	capitalize,
	cloneAsMutable,
	length,
} from "../utils/util"
import {
	linkSetting,
	resetButton,
	setTextToEnum,
	setTextToNumber,
} from "./util"
import { LANGUAGES } from "assets/locales"
import { PROFILE_DEFAULTS } from "./profile-presets"
import { ProfilesModal } from "./profiles"
import type { TerminalPlugin } from "../main"

export class SettingTab extends PluginSettingTab {
	public constructor(protected readonly plugin: TerminalPlugin) {
		super(plugin.app, plugin)
		plugin.register(plugin.language.onChangeLanguage
			.listen(() => { this.display() }))
	}

	public display(): void {
		const { containerEl, plugin } = this,
			{ settings, language } = plugin,
			{ i18n } = language
		containerEl.empty()
		containerEl.createEl("h1", { text: i18n.t("name") })

		new Setting(containerEl)
			.setName(i18n.t("settings.language"))
			.setDesc(i18n.t("settings.language-description"))
			.addDropdown(linkSetting(
				plugin,
				(): string => settings.language,
				setTextToEnum(
					Settings.DEFAULTABLE_LANGUAGES,
					async value => plugin
						.mutateSettings(settingsM => { settingsM.language = value }),
				),
				{
					pre: dropdown => {
						dropdown
							.addOption("", i18n.t("settings.language-default"))
							.addOptions(Object
								.fromEntries(Object
									.entries(LANGUAGES)
									.filter(entry => entry
										.every(half => typeof half === "string"))))
					},
				},
			))
			.addExtraButton(resetButton(
				plugin,
				this.display.bind(this),
				async () => plugin
					.mutateSettings(settingsM => {
						settingsM.language = DEFAULT_SETTINGS.language
					}),
				i18n.t("asset:settings.language-icon"),
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.reset-all"))
			.addButton(resetButton(
				plugin,
				this.display.bind(this),
				async () => plugin
					.mutateSettings(settingsM =>
						Object.assign(settingsM, cloneAsMutable(DEFAULT_SETTINGS))),
			))

		new Setting(containerEl)
			.setName(i18n.t("settings.add-to-command"))
			.addToggle(linkSetting(
				plugin,
				() => settings.addToCommand,
				async value => plugin
					.mutateSettings(settingsM => { settingsM.addToCommand = value }),
			))
			.addExtraButton(resetButton(
				plugin,
				this.display.bind(this),
				async () => plugin
					.mutateSettings(settingsM => {
						settingsM.addToCommand = DEFAULT_SETTINGS.addToCommand
					}),
				i18n.t("asset:settings.add-to-command-icon"),
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.add-to-context-menu"))
			.addToggle(linkSetting(
				plugin,
				() => settings.addToContextMenu,
				async value => plugin
					.mutateSettings(settingsM => { settingsM.addToContextMenu = value }),
			))
			.addExtraButton(resetButton(
				plugin,
				this.display.bind(this),
				async () => plugin
					.mutateSettings(settingsM => {
						settingsM.addToContextMenu = DEFAULT_SETTINGS.addToContextMenu
					}),
				i18n.t("asset:settings.add-to-context-menu-icon"),
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.hide-status-bar"))
			.addDropdown(linkSetting(
				plugin,
				(): string => settings.hideStatusBar,
				setTextToEnum(
					Settings.HIDE_STATUS_BAR_OPTIONS,
					async value => plugin.mutateSettings(settingsM => {
						settingsM.hideStatusBar = value
					}),
				),
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
				this.display.bind(this),
				async () => plugin.mutateSettings(settingsM => {
					settingsM.hideStatusBar = DEFAULT_SETTINGS.hideStatusBar
				}),
				i18n.t("asset:settings.hide-status-bar-icon"),
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.notice-timeout"))
			.setDesc(i18n.t("settings.notice-timeout-description"))
			.addText(linkSetting(
				plugin,
				() => settings.noticeTimeout.toString(),
				setTextToNumber(async value => plugin
					.mutateSettings(settingsM => { settingsM.noticeTimeout = value })),
			))
			.addExtraButton(resetButton(
				plugin,
				this.display.bind(this),
				async () => plugin.mutateSettings(settingsM => {
					settingsM.noticeTimeout = DEFAULT_SETTINGS.noticeTimeout
				}),
				i18n.t("asset:settings.notice-timeout-icon"),
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.error-notice-timeout"))
			.setDesc(i18n.t("settings.error-notice-timeout-description"))
			.addText(linkSetting(
				plugin,
				() => settings.errorNoticeTimeout.toString(),
				setTextToNumber(async value => plugin
					.mutateSettings(settingsM => {
						settingsM.errorNoticeTimeout = value
					})),
			))
			.addExtraButton(resetButton(
				plugin,
				this.display.bind(this),
				async () => plugin.mutateSettings(settingsM => {
					settingsM.noticeTimeout = DEFAULT_SETTINGS.noticeTimeout
				}),
				i18n.t("asset:settings.error-notice-timeout-icon"),
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.profiles"))
			.setDesc(i18n.t("settings.list-description", {
				count: length(settings.profiles),
			}))
			.addButton(button => button
				.setIcon(i18n.t("asset:settings.profiles-edit-icon"))
				.onClick(() => {
					const modal = new ProfilesModal(plugin),
						onClose = modal.onClose.bind(modal)
					modal.onClose = (): void => {
						try {
							onClose()
						} finally {
							try {
								this.display()
							} catch (error) {
								console.error(error)
							}
						}
					}
					modal.open()
				}))
			.addExtraButton(resetButton(
				plugin,
				this.display.bind(this),
				async () => plugin.mutateSettings(settingsM => {
					settingsM.profiles = cloneAsMutable(PROFILE_DEFAULTS)
				}),
				i18n.t("asset:settings.profiles-icon"),
			))
		containerEl.createEl("h2", { text: i18n.t("settings.advanced-settings") })
		new Setting(containerEl)
			.setName(i18n.t("settings.preferred-renderer"))
			.addDropdown(linkSetting(
				plugin,
				(): string => settings.preferredRenderer,
				setTextToEnum(
					Settings.PREFERRED_RENDERER_OPTIONS,
					async value => plugin.mutateSettings(settingsM => {
						settingsM.preferredRenderer = value
					}),
				),
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
				this.display.bind(this),
				async () => plugin.mutateSettings(settingsM => {
					settingsM.preferredRenderer = DEFAULT_SETTINGS.preferredRenderer
				}),
				i18n.t("asset:settings.preferred-renderer-icon"),
			))
	}
}
