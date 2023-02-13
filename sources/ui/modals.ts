import type { AsyncOrSync, DeepWritable, Writable } from "ts-essentials"
import { DISABLED_TOOLTIP, JSON_STRINGIFY_SPACE } from "sources/magic"
import { Modal, type Setting, type ValueComponent } from "obsidian"
import {
	PROFILE_PRESETS,
	PROFILE_PRESET_ORDERED_KEYS,
} from "sources/settings/profile-presets"
import { UpdatableUI, useSettings } from "sources/utils/obsidian"
import {
	clearProperties,
	cloneAsWritable,
	insertAt,
	isUndefined,
	randomNotIn,
	removeAt,
	swap,
	typedStructuredClone,
	unexpected,
} from "sources/utils/util"
import {
	dropdownSelect,
	linkSetting,
	resetButton,
	setTextToEnum,
} from "./settings"
import { PROFILE_PROPERTIES } from "sources/settings/profile-properties"
import { Pseudoterminal } from "sources/terminal/pseudoterminal"
import { Settings } from "sources/settings/data"
import type { TerminalPlugin } from "sources/main"

export class EditableListModal<T> extends Modal {
	protected readonly ui = new UpdatableUI()
	readonly #data
	readonly #inputter
	readonly #callback
	readonly #title

	public constructor(
		protected readonly plugin: TerminalPlugin,
		protected readonly inputter: (
			setting: Setting,
			getter: () => T,
			setter: (value: T) => unknown,
		) => void,
		protected readonly placeholder: T,
		data: readonly T[],
		callback: (data_: Writable<typeof data>) => unknown,
		title?: () => string,
	) {
		super(app)
		this.#inputter = inputter
		this.#data = [...data]
		this.#callback = callback
		this.#title = title
	}

	public static readonly stringInputter = (
		setting: Setting,
		getter: () => string,
		setter: (value: string) => unknown,
		input: (
			setting: Setting,
			callback: (component: ValueComponent<string> & {
				readonly onChange: (callback: (value: string) => unknown) => unknown
			}) => unknown,
		) => void = (setting0, callback): void => {
			setting0.addTextArea(callback)
		},
	): void => {
		input(setting, text => text
			.setValue(getter())
			.onChange(setter))
	}

	public override onOpen(): void {
		super.onOpen()
		const { plugin, placeholder, ui } = this,
			[listEl, listElRemover] = useSettings(this.contentEl),
			{ language } = plugin,
			{ i18n } = language,
			title = this.#title
		if (!isUndefined(title)) {
			ui.new(() => listEl.createEl("h1"), ele => {
				ele.textContent = title()
			})
		}
		ui.finally(listElRemover)
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.editable-list.prepend"))
					.addButton(button => {
						button
							.setIcon(i18n.t("asset:components.editable-list.prepend-icon"))
							.setTooltip(i18n.t("components.editable-list.prepend"))
							.onClick(async () => {
								this.#data.unshift(placeholder)
								this.#setupListSubUI0()
								await this.#postMutate()
							})
					})
			})
			.embed(() => {
				const subUI = new UpdatableUI(),
					ele = listEl.createEl("div")
				this.#setupListSubUI0 = (): void => { this.#setupListSubUI(subUI, ele) }
				this.#setupListSubUI0()
				return subUI
			})
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.editable-list.append"))
					.addButton(button => button
						.setIcon(i18n.t("asset:components.editable-list.append-icon"))
						.setTooltip(i18n.t("components.editable-list.append"))
						.onClick(async () => {
							this.#data.push(placeholder)
							this.#setupListSubUI0()
							await this.#postMutate()
						}))
			})
			.finally(language.onChangeLanguage.listen(() => { ui.update() }))
	}

	public override onClose(): void {
		super.onClose()
		this.ui.clear()
	}

	async #postMutate(): Promise<void> {
		const cb = this.#callback(typedStructuredClone(this.#data))
		this.ui.update()
		await cb
	}

	#setupListSubUI0 = (): void => { }
	#setupListSubUI(ui: UpdatableUI, element: HTMLElement): void {
		ui.clear()
		const { plugin } = this,
			{ language } = plugin,
			{ i18n } = language
		ui.finally(() => { element.replaceChildren() })
		for (const [index, item] of this.#data.entries()) {
			ui.newSetting(element, setting => {
				setting.setName(i18n.t("components.editable-list.name", {
					count: index + 1,
					ordinal: true,
				}))
				this.#inputter(
					setting,
					() => item,
					async value => {
						this.#data[index] = value
						await this.#postMutate()
					},
				)
				setting
					.addButton(button => button
						.setTooltip(i18n.t("components.editable-list.remove"))
						.setIcon(i18n.t("asset:components.editable-list.remove-icon"))
						.onClick(async () => {
							removeAt(this.#data, index)
							this.#setupListSubUI0()
							await this.#postMutate()
						}))
					.addExtraButton(button => button
						.setTooltip(i18n.t("components.editable-list.move-up"))
						.setIcon(i18n.t("asset:components.editable-list.move-up-icon"))
						.onClick(async () => {
							if (index <= 0) { return }
							swap(this.#data, index - 1, index)
							this.#setupListSubUI0()
							await this.#postMutate()
						}))
					.addExtraButton(button => button
						.setTooltip(i18n.t("components.editable-list.move-down"))
						.setIcon(i18n.t("asset:components.editable-list.move-down-icon"))
						.onClick(async () => {
							if (index >= this.#data.length - 1) { return }
							swap(this.#data, index, index + 1)
							this.#setupListSubUI0()
							await this.#postMutate()
						}))
			})
		}
	}
}

export class ProfileModal extends Modal {
	protected readonly ui = new UpdatableUI()
	readonly #data
	readonly #callback
	readonly #presets

	public constructor(
		protected readonly plugin: TerminalPlugin,
		data: Settings.Profile,
		callback: (data_: DeepWritable<typeof data>) => unknown,
		presets: readonly {
			readonly name: string
			readonly value: Settings.Profile
		}[] = PROFILE_PRESET_ORDERED_KEYS
			.map(key => ({
				get name(): string {
					return plugin.language.i18n.t(`types.profile-presets.${key}`)
				},
				value: PROFILE_PRESETS[key],
			})),
	) {
		super(plugin.app)
		this.#data = cloneAsWritable(data)
		this.#callback = callback
		this.#presets = presets
	}

	public override onOpen(): void {
		super.onOpen()
		const { plugin, ui } = this,
			[listEl, listElRemover] = useSettings(this.contentEl),
			profile = this.#data,
			{ language } = plugin,
			{ i18n } = language
		ui.finally(listElRemover)
			.new(() => listEl.createEl("h1"), ele => {
				ele.textContent = i18n.t("components.profile.title", {
					name: Settings.Profile.name(profile),
					profile,
				})
			})
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.profile.name"))
					.addText(linkSetting(
						() => Settings.Profile.name(profile),
						value => { profile.name = value },
						async () => this.#postMutate(),
					))
					.addExtraButton(resetButton(
						plugin,
						i18n.t("asset:components.profile.name-icon"),
						() => {
							profile.name = Settings.Profile.DEFAULTS[profile.type].name
						},
						async () => this.#postMutate(),
					))
			})
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.profile.preset"))
					.addDropdown(dropdownSelect(
						i18n.t("components.dropdown.unselected"),
						this.#presets,
						async value => {
							this.#replaceData(cloneAsWritable(value))
							this.#setupTypedUI0()
							await this.#postMutate()
						},
					))
			})
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.profile.type"))
					.addDropdown(linkSetting(
						(): string => profile.type,
						setTextToEnum(
							Settings.Profile.TYPES,
							value => {
								this.#replaceData(cloneAsWritable(Settings.Profile
									.DEFAULTS[value]))
							},
						),
						async () => {
							this.#setupTypedUI0()
							await this.#postMutate()
						},
						{
							pre: dropdown => {
								dropdown
									.addOptions(Object
										.fromEntries(Settings.Profile.TYPES
											.filter(type0 => PROFILE_PROPERTIES[type0].valid)
											.map(type0 => [
												type0,
												i18n.t(`types.profiles.${type0}`),
											])))
							},
						},
					))
					.addExtraButton(resetButton(
						plugin,
						i18n.t("asset:components.profile.type-icon"),
						unexpected,
						unexpected,
						{
							post: button => {
								button.setTooltip(DISABLED_TOOLTIP).setDisabled(true)
							},
						},
					))
			})
			.embed(() => {
				const typedUI = new UpdatableUI(),
					el = listEl.createEl("div")
				this.#setupTypedUI0 = (): void => {
					this.#setupTypedUI(typedUI, el)
				}
				this.#setupTypedUI0()
				return typedUI
			}, null, () => { this.#setupTypedUI0 = (): void => { } })
			.finally(language.onChangeLanguage.listen(() => { ui.update() }))
	}

	public override onClose(): void {
		super.onClose()
		this.ui.clear()
	}

	async #postMutate(): Promise<void> {
		const cb = this.#callback(typedStructuredClone(this.#data))
		this.ui.update()
		await cb
	}

	#replaceData(profile: DeepWritable<Settings.Profile>): void {
		const { name } = this.#data
		clearProperties(this.#data)
		Object.assign(
			this.#data,
			profile,
			{ name },
		)
	}

	#setupTypedUI0 = (): void => { }
	#setupTypedUI(ui: UpdatableUI, element: HTMLElement): void {
		ui.clear()
		const { plugin } = this,
			profile = this.#data,
			{ i18n } = plugin.language,
			{ type } = profile
		ui.finally(() => { element.replaceChildren() })
		switch (type) {
			case "": {
				break
			}
			case "console": {
				break
			}
			case "external": {
				ui.newSetting(element, setting => {
					setting
						.setName(i18n.t(`components.profile.${type}.executable`))
						.addText(linkSetting(
							() => profile.executable,
							value => { profile.executable = value },
							async () => this.#postMutate(),
						))
						.addExtraButton(resetButton(
							plugin,
							i18n.t(`asset:components.profile.${type}.executable-icon`),
							() => {
								profile.executable = Settings.Profile.DEFAULTS[type].executable
							},
							async () => this.#postMutate(),
						))
				}).newSetting(element, setting => {
					setting
						.setName(i18n.t(`components.profile.${type}.arguments`))
						.setDesc(i18n.t("settings.list-description", {
							count: profile.args.length,
						}))
						.addButton(button => button
							.setIcon(i18n.t("asset:generic.edit-list-icon"))
							.setTooltip(i18n.t("generic.edit"))
							.onClick(() => {
								new EditableListModal(
									plugin,
									EditableListModal.stringInputter,
									"",
									profile.args,
									async value => {
										profile.args = value
										await this.#postMutate()
									},
									() => i18n.t(`components.profile.${type}.arguments`),
								).open()
							}))
						.addExtraButton(resetButton(
							plugin,
							i18n.t(`asset:components.profile.${type}.arguments-icon`),
							() => {
								profile.args =
									cloneAsWritable(Settings.Profile.DEFAULTS[type].args)
							},
							async () => this.#postMutate(),
						))
				})
				for (const platform of Pseudoterminal.SUPPORTED_PLATFORMS) {
					ui.newSetting(element, setting => {
						setting
							.setName(i18n.t(`types.platforms.${platform}`))
							.addToggle(linkSetting(
								() => profile.platforms[platform] ??
									Settings.Profile.DEFAULTS[type].platforms[platform],
								value => {
									profile.platforms[platform] = value
								},
								async () => this.#postMutate(),
							))
							.addExtraButton(resetButton(
								plugin,
								i18n.t(`asset:types.platforms.${platform}-icon`),
								() => {
									profile.platforms[platform] =
										Settings.Profile.DEFAULTS[type].platforms[platform]
								},
								async () => this.#postMutate(),
							))
					})
				}
				break
			}
			case "integrated": {
				ui.newSetting(element, setting => {
					setting
						.setName(i18n.t(`components.profile.${type}.executable`))
						.addText(linkSetting(
							() => profile.executable,
							value => {
								profile.executable = value
							},
							async () => this.#postMutate(),
						))
						.addExtraButton(resetButton(
							plugin,
							i18n.t(`asset:components.profile.${type}.executable-icon`),
							() => {
								profile.executable = Settings.Profile.DEFAULTS[type].executable
							},
							async () => this.#postMutate(),
						))
				}).newSetting(element, setting => {
					setting
						.setName(i18n.t(`components.profile.${type}.arguments`))
						.setDesc(i18n.t("settings.list-description", {
							count: profile.args.length,
						}))
						.addButton(button => button
							.setIcon(i18n.t("asset:generic.edit-list-icon"))
							.setTooltip(i18n.t("generic.edit"))
							.onClick(() => {
								new EditableListModal(
									plugin,
									EditableListModal.stringInputter,
									"",
									profile.args,
									async value => {
										profile.args = value
										await this.#postMutate()
									},
									() => i18n.t(`components.profile.${type}.arguments`),
								).open()
							}))
						.addExtraButton(resetButton(
							plugin,
							i18n.t(`asset:components.profile.${type}.arguments-icon`),
							() => {
								profile.args =
									cloneAsWritable(Settings.Profile.DEFAULTS[type].args)
							},
							async () => this.#postMutate(),
						))
				})
				for (const platform of Pseudoterminal.SUPPORTED_PLATFORMS) {
					ui.newSetting(element, setting => {
						setting
							.setName(i18n.t(`types.platforms.${platform}`))
							.addToggle(linkSetting(
								() => profile.platforms[platform] ??
									Settings.Profile.DEFAULTS[type].platforms[platform],
								value => {
									profile.platforms[platform] = value
								},
								async () => this.#postMutate(),
							))
							.addExtraButton(resetButton(
								plugin,
								i18n.t(`asset:types.platforms.${platform}-icon`),
								() => {
									profile.platforms[platform] =
										Settings.Profile.DEFAULTS[type].platforms[platform]
								},
								async () => this.#postMutate(),
							))
					})
				}
				ui.newSetting(element, setting => {
					setting
						.setName(i18n.t(`components.profile.${type}.python-executable`))
						.setDesc(i18n
							.t(`components.profile.${type}.python-executable-description`))
						.addText(linkSetting(
							() => profile.pythonExecutable,
							value => {
								profile.pythonExecutable = value
							},
							async () => this.#postMutate(),
							{
								post: component => {
									component
										.setPlaceholder(i18n
											// eslint-disable-next-line max-len
											.t(`components.profile.${type}.python-executable-placeholder`))
								},
							},
						))
						.addExtraButton(resetButton(
							plugin,
							i18n.t(`asset:components.profile.${type}.python-executable-icon`),
							() => {
								profile.pythonExecutable =
									Settings.Profile.DEFAULTS[type].pythonExecutable
							},
							async () => this.#postMutate(),
						))
				}).newSetting(element, setting => {
					setting
						.setName(i18n
							// eslint-disable-next-line max-len
							.t(`components.profile.${type}.enable-Windows-conhost-workaround`))
						.setDesc(i18n
							// eslint-disable-next-line max-len
							.t(`components.profile.${type}.enable-Windows-conhost-workaround-description`))
						.addToggle(linkSetting(
							() => profile.enableWindowsConhostWorkaround ??
								Settings.Profile.DEFAULTS[type].enableWindowsConhostWorkaround,
							value => {
								profile.enableWindowsConhostWorkaround = value
							},
							async () => this.#postMutate(),
						))
						.addExtraButton(resetButton(
							plugin,
							i18n
								// eslint-disable-next-line max-len
								.t(`asset:components.profile.${type}.enable-Windows-conhost-workaround-icon`),
							() => {
								profile.enableWindowsConhostWorkaround =
									Settings.Profile.DEFAULTS[type].enableWindowsConhostWorkaround
							},
							async () => this.#postMutate(),
						))
				})
				break
			}
			case "invalid": {
				ui.newSetting(element, setting => {
					setting
						.setName(i18n.t(`components.profile.${type}.data`))
						.addTextArea(textArea => textArea
							.setValue(JSON.stringify(profile, null, JSON_STRINGIFY_SPACE))
							.setDisabled(true))
						.addExtraButton(resetButton(
							plugin,
							i18n.t(`asset:components.profile.${type}.data-icon`),
							unexpected,
							unexpected,
							{
								post: button => {
									button.setTooltip(DISABLED_TOOLTIP).setDisabled(true)
								},
							},
						))
				})
				break
			}
			// No default
		}
	}
}

export class ProfileListModal extends Modal {
	protected readonly ui = new UpdatableUI()
	readonly #data
	readonly #callback
	readonly #presets
	readonly #keygen

	public constructor(
		protected readonly plugin: TerminalPlugin,
		data: readonly Settings.Profile.Entry[],
		callback: (data_: DeepWritable<typeof data>) => unknown,
		presets: readonly {
			readonly name: string
			readonly value: Settings.Profile
		}[] = PROFILE_PRESET_ORDERED_KEYS
			.map(key => ({
				get name(): string {
					return plugin.language.i18n.t(`types.profile-presets.${key}`)
				},
				value: PROFILE_PRESETS[key],
			})),
		keygen = (): string => crypto.randomUUID(),
	) {
		super(plugin.app)
		this.#data = cloneAsWritable(data)
		this.#callback = callback
		this.#presets = presets
		this.#keygen = keygen
	}

	public override onOpen(): void {
		super.onOpen()
		const { plugin, ui } = this,
			[listEl, listElRemover] = useSettings(this.contentEl),
			{ language } = plugin,
			{ i18n } = language
		ui.finally(listElRemover)
			.new(() => listEl.createEl("h1"), ele => {
				ele.textContent = i18n.t("components.profile-list.title")
			})
			.new(() => listEl.createEl("div"), ele => {
				ele.textContent = i18n.t("components.profile-list.content")
			})
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.editable-list.prepend"))
					.addDropdown(dropdownSelect(
						i18n.t("components.dropdown.unselected"),
						this.#presets,
						async value => {
							this.#addProfile(0, cloneAsWritable(value))
							this.#setupListSubUI0()
							await this.#postMutate()
						},
					))
			})
			.embed(() => {
				const subUI = new UpdatableUI(),
					el = listEl.createEl("div")
				this.#setupListSubUI0 = (): void => {
					this.#setupListSubUI(subUI, el)
				}
				this.#setupListSubUI0()
				return subUI
			})
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.editable-list.append"))
					.addDropdown(dropdownSelect(
						i18n.t("components.dropdown.unselected"),
						this.#presets,
						async value => {
							this.#addProfile(this.#data.length, cloneAsWritable(value))
							this.#setupListSubUI0()
							await this.#postMutate()
						},
					))
			})
			.finally(language.onChangeLanguage.listen(() => { ui.update() }))
	}

	public override onClose(): void {
		super.onClose()
		this.ui.update()
	}

	async #postMutate(): Promise<void> {
		const cb = this.#callback(cloneAsWritable(this.#data))
		this.ui.update()
		await cb
	}

	#addProfile(
		index: number,
		profile: DeepWritable<Settings.Profile>,
	): void {
		insertAt(
			this.#data,
			index,
			[randomNotIn(this.#data.map(entry => entry[0]), this.#keygen), profile],
		)
	}

	#setupListSubUI0 = (): void => { }
	#setupListSubUI(ui: UpdatableUI, element: HTMLElement): void {
		ui.clear()
		const { plugin } = this,
			{ language } = plugin,
			{ i18n } = language
		ui.finally(() => { element.replaceChildren() })
		for (const [index, [id, profile]] of this.#data.entries()) {
			ui.newSetting(element, setting => {
				setting
					.setName(i18n.t("components.profile-list.name", { profile }))
					.setDesc(i18n
						.t("components.profile-list.description", { id, profile }))
					.addButton(button => button
						.setIcon(i18n.t("asset:generic.edit-icon"))
						.setTooltip(i18n.t("generic.edit"))
						.onClick(() => {
							new ProfileModal(
								plugin,
								profile,
								async profile0 => {
									this.#data[index] = [id, profile0]
									await this.#postMutate()
								},
							).open()
						}))
					.addButton(button => button
						.setIcon(i18n.t("asset:components.editable-list.remove-icon"))
						.setTooltip(i18n.t("components.editable-list.remove"))
						.onClick(async () => {
							removeAt(this.#data, index)
							this.#setupListSubUI0()
							await this.#postMutate()
						}))
					.addExtraButton(button => button
						.setTooltip(i18n.t("components.editable-list.move-up"))
						.setIcon(i18n.t("asset:components.editable-list.move-up-icon"))
						.onClick(async () => {
							if (index <= 0) { return }
							swap(this.#data, index - 1, index)
							this.#setupListSubUI0()
							await this.#postMutate()
						}))
					.addExtraButton(button => button
						.setTooltip(i18n.t("components.editable-list.move-down"))
						.setIcon(i18n.t("asset:components.editable-list.move-down-icon"))
						.onClick(async () => {
							if (index >= this.#data.length - 1) { return }
							swap(this.#data, index, index + 1)
							this.#setupListSubUI0()
							await this.#postMutate()
						}))
			})
		}
	}
}

export class DialogModal extends Modal {
	protected readonly modalUI = new UpdatableUI()

	public constructor(protected readonly plugin: TerminalPlugin) {
		super(plugin.app)
	}

	public override onOpen(): void {
		super.onOpen()
		const { plugin, modalEl, scope, modalUI } = this,
			{ language } = plugin,
			{ i18n } = language
		modalUI
			.newSetting(modalEl, setting => {
				setting
					.addButton(button => button
						.setIcon(i18n.t("asset:components.dialog.cancel-icon"))
						.setTooltip(i18n.t("components.dialog.cancel"))
						.onClick(async () => { await this.cancel(this.#close) }))
					.addButton(button => button
						.setIcon(i18n.t("asset:components.dialog.confirm-icon"))
						.setTooltip(i18n.t("components.dialog.confirm"))
						.setCta()
						.onClick(async () => { await this.confirm(this.#close) }))
			})
			// Hooking escape does not work as it is already registered
			.new(() => scope.register([], "enter", async event => {
				await this.confirm(this.#close)
				event.preventDefault()
				event.stopPropagation()
			}), null, ele => { scope.unregister(ele) })
			.finally(language.onChangeLanguage.listen(() => { modalUI.update() }))
	}

	public override onClose(): void {
		super.onClose()
		this.modalUI.clear()
	}

	public override close(): void {
		(async (): Promise<void> => {
			try {
				await this.cancel(this.#close)
			} catch (error) {
				console.error(error)
			}
		})()
	}

	protected confirm(close: () => void): AsyncOrSync<void> {
		close()
	}

	protected cancel(close: () => void): AsyncOrSync<void> {
		close()
	}

	readonly #close = (): void => { super.close() }
}
