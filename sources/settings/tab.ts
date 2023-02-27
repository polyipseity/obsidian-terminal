import { DOMClasses, JSON_STRINGIFY_SPACE } from "sources/magic"
import {
	ListModal,
	ProfileListModal,
	makeModalDynamicWidth,
} from "sources/ui/modals"
import { Modal, PluginSettingTab } from "obsidian"
import { UpdatableUI, useSettings } from "sources/utils/obsidian"
import {
	clearProperties,
	cloneAsWritable,
	createChildElement,
	logError,
	typedStructuredClone,
	unexpected,
} from "../utils/util"
import {
	closeSetting,
	linkSetting,
	resetButton,
	setTextToEnum,
	setTextToNumber,
} from "../ui/settings"
import { identity, isEmpty, size } from "lodash-es"
import type { DeepWritable } from "ts-essentials"
import { LANGUAGES } from "assets/locales"
import { Settings } from "./data"
import type { TerminalPlugin } from "../main"
import { lt } from "semver"
import { openDocumentation } from "sources/documentation/load"

export class EditSettingsModal extends Modal {
	protected readonly modalUI = new UpdatableUI()
	protected readonly ui = new UpdatableUI()
	protected readonly data
	#dataText
	readonly #callback

	public constructor(
		protected readonly plugin: TerminalPlugin,
		protected readonly protodata: Settings,
		callback?: (data: DeepWritable<typeof protodata>) => unknown,
	) {
		super(plugin.app)
		this.data = cloneAsWritable(protodata)
		this.#dataText = JSON.stringify(this.data, null, JSON_STRINGIFY_SPACE)
		this.#callback = callback ?? ((): void => { })
	}

	public override onOpen(): void {
		super.onOpen()
		const { modalUI, ui, modalEl, titleEl, plugin, data, protodata } = this,
			{ element: listEl, remover: listElRemover } = useSettings(this.contentEl),
			{ language } = plugin,
			{ i18n, onChangeLanguage } = language
		modalUI.finally(onChangeLanguage.listen(() => { modalUI.update() }))
		ui.finally(listElRemover)
			.finally(onChangeLanguage.listen(() => { ui.update() }))
		makeModalDynamicWidth(modalUI, modalEl)
		modalUI.new(() => titleEl, ele => {
			ele.textContent = i18n.t("settings.edit-settings.title")
		}, ele => { ele.textContent = null })
		let errorEl: HTMLElement = listEl.ownerDocument.createElement("a")
		const resetDataText = (): void => {
			this.#dataText = JSON.stringify(data, null, JSON_STRINGIFY_SPACE)
			errorEl.textContent = null
			ui.update()
		}
		ui.finally(resetDataText)
			.new(() => {
				errorEl = createChildElement(listEl, "div", ele => {
					ele.classList.add(DOMClasses.MOD_WARNING)
				})
				return errorEl
			})
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("settings.edit-settings.export"))
					.addButton(button => button
						.setIcon(i18n
							.t("asset:settings.edit-settings.export-to-clipboard-icon"))
						.setTooltip(i18n.t("settings.edit-settings.export-to-clipboard"))
						.onClick(async () => {
							try {
								await navigator.clipboard.writeText(this.#dataText)
								errorEl.textContent = null
							} catch (error) {
								console.debug(error)
								errorEl.textContent = String(error)
							}
						}))
			})
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("settings.edit-settings.import"))
					.addButton(button => button
						.setIcon(i18n
							.t("asset:settings.edit-settings.import-from-clipboard-icon"))
						.setTooltip(i18n.t("settings.edit-settings.import-from-clipboard"))
						.onClick(async () => {
							try {
								const { value: parsed, valid } =
									Settings.fix(JSON.parse(await navigator.clipboard.readText()))
								if (!valid) {
									throw new Error(i18n.t("errors.malformed-data"))
								}
								this.replaceData(parsed)
								errorEl.textContent = null
							} catch (error) {
								console.debug(error)
								errorEl.textContent = String(error)
								return
							}
							resetDataText()
							await this.postMutate()
						}))
			})
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("settings.edit-settings.data"))
					.addTextArea(linkSetting(
						() => this.#dataText,
						value => { this.#dataText = value },
						async value => {
							try {
								const { value: parsed, valid } = Settings.fix(JSON.parse(value))
								if (!valid) {
									throw new Error(i18n.t("errors.malformed-data"))
								}
								this.replaceData(parsed)
								errorEl.textContent = null
							} catch (error) {
								console.debug(error)
								errorEl.textContent = String(error)
								return
							}
							await this.postMutate()
						},
					))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.edit-settings.data-icon"),
						i18n.t("settings.reset"),
						() => { this.replaceData(cloneAsWritable(protodata)) },
						async () => {
							resetDataText()
							await this.postMutate()
						},
					))
			})
	}

	public override onClose(): void {
		super.onClose()
		this.modalUI.destroy()
		this.ui.destroy()
	}

	protected async postMutate(): Promise<void> {
		const { data, modalUI, ui } = this,
			cb = this.#callback(typedStructuredClone(data))
		modalUI.update()
		ui.update()
		await cb
	}

	protected replaceData(data: DeepWritable<typeof this.data>): void {
		clearProperties(this.data)
		Object.assign(this.data, data)
	}
}

export class SettingTab extends PluginSettingTab {
	protected readonly ui = new UpdatableUI()
	#onMutate = this.snapshot()

	public constructor(protected readonly plugin: TerminalPlugin) {
		super(plugin.app, plugin)
		const { containerEl, ui } = this,
			{ language, version } = plugin,
			{ i18n } = language
		plugin.register(() => { ui.destroy() })
		ui.finally(language.onChangeLanguage.listen(() => { this.ui.update() }))
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
							lt(plugin.settings.lastReadChangelogVersion, version)) {
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
								new EditSettingsModal(
									plugin,
									plugin.settings,
									async settings => {
										await plugin.mutateSettings(settingsM => {
											Object.assign(settingsM, settings)
										})
										this.postMutate()
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
					.setName(i18n.t("settings.add-to-command"))
					.addToggle(linkSetting(
						() => plugin.settings.addToCommand,
						async value => plugin
							.mutateSettings(settingsM => { settingsM.addToCommand = value }),
						() => { this.postMutate() },
					))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.add-to-command-icon"),
						i18n.t("settings.reset"),
						async () => plugin
							.mutateSettings(settingsM => {
								settingsM.addToCommand = Settings.DEFAULT.addToCommand
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
						i18n.t("asset:settings.add-to-context-menu-icon"),
						i18n.t("settings.reset"),
						async () => plugin
							.mutateSettings(settingsM => {
								settingsM.addToContextMenu = Settings.DEFAULT.addToContextMenu
							}),
						() => { this.postMutate() },
					))
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.profiles"))
					.setDesc(i18n.t("settings.profiles-description", {
						count: size(plugin.settings.profiles),
						interpolation: { escapeValue: false },
					}))
					.addButton(button => button
						.setIcon(i18n.t("asset:settings.profiles-edit-icon"))
						.setTooltip(i18n.t("settings.profiles-edit"))
						.onClick(() => {
							new ProfileListModal(
								plugin,
								Object.entries(plugin.settings.profiles),
								{
									callback: async (data): Promise<void> => {
										await plugin.mutateSettings(settingsM => {
											settingsM.profiles = Object.fromEntries(data)
										})
										this.postMutate()
									},
									description: (): string =>
										i18n.t("settings.profile-list.description"),
								},
							).open()
						}))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.profiles-icon"),
						i18n.t("settings.reset"),
						async () => plugin.mutateSettings(settingsM => {
							settingsM.profiles = cloneAsWritable(Settings.DEFAULT.profiles)
						}),
						() => { this.postMutate() },
					))
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.new-instance-behavior"))
					.addDropdown(linkSetting(
						(): string => plugin.settings.newInstanceBehavior,
						setTextToEnum(
							Settings.NEW_INSTANCE_BEHAVIORS,
							async value => plugin.mutateSettings(settingsM => {
								settingsM.newInstanceBehavior = value
							}),
						),
						() => { this.postMutate() },
						{
							pre: dropdown => {
								dropdown
									.addOptions(Object.fromEntries(Settings.NEW_INSTANCE_BEHAVIORS
										.map(value => [
											value,
											i18n.t(`settings.new-instance-behaviors.${value}`),
										])))
							},
						},
					))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.new-instance-behavior-icon"),
						i18n.t("settings.reset"),
						async () => plugin.mutateSettings(settingsM => {
							settingsM.newInstanceBehavior =
								Settings.DEFAULT.newInstanceBehavior
						}),
						() => { this.postMutate() },
					))
			})
			.newSetting(containerEl, setting => {
				setting
					.setName(i18n.t("settings.create-instance-near-existing-ones"))
					.setDesc(i18n
						.t("settings.create-instance-near-existing-ones-description"))
					.addToggle(linkSetting(
						() => plugin.settings.createInstanceNearExistingOnes,
						async value => plugin.mutateSettings(settingsM => {
							settingsM.createInstanceNearExistingOnes = value
						}),
						() => { this.postMutate() },
					))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.create-instance-near-existing-ones-icon"),
						i18n.t("settings.reset"),
						async () => plugin.mutateSettings(settingsM => {
							settingsM.createInstanceNearExistingOnes =
								Settings.DEFAULT.createInstanceNearExistingOnes
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
						i18n.t("asset:settings.hide-status-bar-icon"),
						i18n.t("settings.reset"),
						async () => plugin.mutateSettings(settingsM => {
							settingsM.hideStatusBar = Settings.DEFAULT.hideStatusBar
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
			.new(() => createChildElement(containerEl, "h2"), ele => {
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
											.map(type => [
												type,
												i18n.t("settings.preferred-renderer-options", {
													interpolation: { escapeValue: false },
													type,
												}),
											])))
							},
						},
					))
					.addExtraButton(resetButton(
						i18n.t("asset:settings.preferred-renderer-icon"),
						i18n.t("settings.reset"),
						async () => plugin.mutateSettings(settingsM => {
							settingsM.preferredRenderer = Settings.DEFAULT.preferredRenderer
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
			plugin.register(unregister)
		})
	}

	protected postMutate(): void {
		const { plugin, ui } = this
		plugin.saveSettings().catch(logError)
		ui.update()
	}
}
