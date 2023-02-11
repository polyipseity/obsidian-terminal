import { DEFAULT_SETTINGS, Settings } from "./data"
import { PluginSettingTab, Setting } from "obsidian"
import {
	capitalize,
	cloneAsWritable,
	executeParanoidly,
	identity,
	length,
} from "../utils/util"
import {
	linkSetting,
	resetButton,
	setTextToEnum,
	setTextToNumber,
} from "../ui/settings"
import { LANGUAGES } from "assets/locales"
import { PROFILE_DEFAULTS } from "./profile-presets"
import { ProfilesModal } from "sources/ui/modals"
import type { TerminalPlugin } from "../main"

export class SettingTab extends PluginSettingTab {
	#onMutation = this.#snapshot()

	public constructor(protected readonly plugin: TerminalPlugin) {
		super(plugin.app, plugin)
		plugin.register(plugin.language.onChangeLanguage
			.listen(() => { this.display() }))
	}

	public override hide(): void {
		super.hide()
		this.#onMutation = this.#snapshot()
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
				(): string => settings.language,
				setTextToEnum(
					Settings.DEFAULTABLE_LANGUAGES,
					async value => plugin
						.mutateSettings(settingsM => { settingsM.language = value }),
				),
				this.#postMutate.bind(this, false),
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
				this.#postMutate.bind(this, true),
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.all-settings"))
			.addButton(resetButton(
				plugin,
				i18n.t("asset:settings.all-settings-actions.undo-icon"),
				async () => plugin.mutateSettings(async settingsM =>
					Object.assign(settingsM, await this.#onMutation)),
				() => {
					this.#onMutation = this.#snapshot()
					this.#postMutate(true)
				},
				{
					post: component => {
						component
							.setTooltip(i18n.t("settings.all-settings-actions.undo"))
							.setDisabled(true)
						this.#onMutation.then(() => {
							component.setDisabled(false).setCta()
						}).catch(error => { console.error(error) })
					},
				},
			))
			.addButton(resetButton(
				plugin,
				i18n.t("asset:settings.all-settings-actions.reload-icon"),
				async () => plugin.mutateSettings(plugin.loadSettings.bind(plugin)),
				this.#postMutate.bind(this, true),
				{
					post: component => {
						component.setTooltip(i18n.t("settings.all-settings-actions.reload"))
					},
				},
			))
			.addButton(resetButton(
				plugin,
				i18n.t("asset:settings.all-settings-actions.reset-icon"),
				async () => plugin
					.mutateSettings(settingsM =>
						Object.assign(settingsM, cloneAsWritable(DEFAULT_SETTINGS))),
				this.#postMutate.bind(this, true),
				{
					post: component => {
						component.setTooltip(i18n.t("settings.all-settings-actions.reset"))
					},
				},
			))

		new Setting(containerEl)
			.setName(i18n.t("settings.add-to-command"))
			.addToggle(linkSetting(
				() => settings.addToCommand,
				async value => plugin
					.mutateSettings(settingsM => { settingsM.addToCommand = value }),
				this.#postMutate.bind(this, false),
			))
			.addExtraButton(resetButton(
				plugin,
				i18n.t("asset:settings.add-to-command-icon"),
				async () => plugin
					.mutateSettings(settingsM => {
						settingsM.addToCommand = DEFAULT_SETTINGS.addToCommand
					}),
				this.#postMutate.bind(this, true),
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.add-to-context-menu"))
			.addToggle(linkSetting(
				() => settings.addToContextMenu,
				async value => plugin
					.mutateSettings(settingsM => { settingsM.addToContextMenu = value }),
				this.#postMutate.bind(this, false),
			))
			.addExtraButton(resetButton(
				plugin,
				i18n.t("asset:settings.add-to-context-menu-icon"),
				async () => plugin
					.mutateSettings(settingsM => {
						settingsM.addToContextMenu = DEFAULT_SETTINGS.addToContextMenu
					}),
				this.#postMutate.bind(this, true),
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.hide-status-bar"))
			.addDropdown(linkSetting(
				(): string => settings.hideStatusBar,
				setTextToEnum(
					Settings.HIDE_STATUS_BAR_OPTIONS,
					async value => plugin.mutateSettings(settingsM => {
						settingsM.hideStatusBar = value
					}),
				),
				this.#postMutate.bind(this, false),
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
				this.#postMutate.bind(this, true),
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.notice-timeout"))
			.setDesc(i18n.t("settings.notice-timeout-description"))
			.addText(linkSetting(
				() => settings.noticeTimeout.toString(),
				setTextToNumber(async value => plugin
					.mutateSettings(settingsM => { settingsM.noticeTimeout = value })),
				this.#postMutate.bind(this, false),
			))
			.addExtraButton(resetButton(
				plugin,
				i18n.t("asset:settings.notice-timeout-icon"),
				async () => plugin.mutateSettings(settingsM => {
					settingsM.noticeTimeout = DEFAULT_SETTINGS.noticeTimeout
				}),
				this.#postMutate.bind(this, true),
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.error-notice-timeout"))
			.setDesc(i18n.t("settings.error-notice-timeout-description"))
			.addText(linkSetting(
				() => settings.errorNoticeTimeout.toString(),
				setTextToNumber(async value => plugin
					.mutateSettings(settingsM => {
						settingsM.errorNoticeTimeout = value
					})),
				this.#postMutate.bind(this, false),
			))
			.addExtraButton(resetButton(
				plugin,
				i18n.t("asset:settings.error-notice-timeout-icon"),
				async () => plugin.mutateSettings(settingsM => {
					settingsM.noticeTimeout = DEFAULT_SETTINGS.noticeTimeout
				}),
				this.#postMutate.bind(this, true),
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.profiles"))
			.setDesc(i18n.t("settings.list-description", {
				count: length(settings.profiles),
			}))
			.addButton(button => button
				.setIcon(i18n.t("asset:settings.profiles-edit-icon"))
				.setTooltip(i18n.t("settings.edit"))
				.onClick(() => {
					new ProfilesModal(
						plugin,
						Object.entries(settings.profiles),
						async data => {
							await plugin.mutateSettings(settingsM => {
								settingsM.profiles = Object.fromEntries(data)
							})
							this.#postMutate(true)
						},
					).open()
				}))
			.addExtraButton(resetButton(
				plugin,
				i18n.t("asset:settings.profiles-icon"),
				async () => plugin.mutateSettings(settingsM => {
					settingsM.profiles = cloneAsWritable(PROFILE_DEFAULTS)
				}),
				this.#postMutate.bind(this, true),
			))
		containerEl.createEl("h2", { text: i18n.t("settings.advanced-settings") })
		new Setting(containerEl)
			.setName(i18n.t("settings.preferred-renderer"))
			.addDropdown(linkSetting(
				(): string => settings.preferredRenderer,
				setTextToEnum(
					Settings.PREFERRED_RENDERER_OPTIONS,
					async value => plugin.mutateSettings(settingsM => {
						settingsM.preferredRenderer = value
					}),
				),
				this.#postMutate.bind(this, false),
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
				this.#postMutate.bind(this, true),
			))
	}

	async #snapshot(): Promise<Settings> {
		const { plugin } = this,
			{ settings: snapshot } = plugin
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

	#postMutate(redraw = false): void {
		this.plugin.saveSettings().catch(error => { console.error(error) })
		if (redraw) { this.display() }
	}
}
