import {
	type ButtonComponent,
	Modal,
	type Setting,
	type ValueComponent,
} from "obsidian"
import {
	DISABLED_TOOLTIP,
	DOMClasses,
	JSON_STRINGIFY_SPACE,
} from "sources/magic"
import type { DeepWritable, Writable } from "ts-essentials"
import {
	PROFILE_PRESETS,
	PROFILE_PRESET_ORDERED_KEYS,
} from "sources/settings/profile-presets"
import {
	UpdatableUI,
	useSettings,
	useSubsettings,
} from "sources/utils/obsidian"
import {
	clearProperties,
	cloneAsWritable,
	deepFreeze,
	identity,
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

export class ListModal<T> extends Modal {
	public static readonly editables = deepFreeze([
		"edit",
		"append",
		"prepend",
		"remove",
		"moveUp",
		"moveDown",
	] as const)

	protected readonly ui = new UpdatableUI()
	protected readonly data
	readonly #inputter
	readonly #callback
	readonly #editables
	readonly #title
	readonly #namer

	public constructor(
		protected readonly plugin: TerminalPlugin,
		protected readonly inputter: (
			setting: Setting,
			editable: boolean,
			getter: () => T,
			setter: (value: T) => unknown,
		) => void,
		protected readonly placeholder: () => T,
		data: readonly T[],
		options?: {
			readonly callback?: (data_: Writable<typeof data>) => unknown
			readonly editables?: typeof ListModal.editables
			readonly title?: () => string
			readonly namer?: (value: T, index: number, data: readonly T[]) => string
		},
	) {
		super(app)
		this.data = [...data]
		this.#inputter = inputter
		this.#callback = options?.callback ?? ((): void => { })
		this.#editables = deepFreeze([...options?.editables ?? ListModal.editables])
		this.#title = options?.title
		this.#namer = options?.namer ?? ((_0, index): string =>
			plugin.language.i18n.t("components.editable-list.name", {
				count: index + 1,
				ordinal: true,
			}))
	}

	public static stringInputter<T>(transformer: {
		readonly forth: (value: T) => string
		readonly back: (value: string) => T
	}) {
		return (
			setting: Setting,
			editable: boolean,
			getter: () => T,
			setter: (value: T) => unknown,
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
				.setValue(transformer.forth(getter()))
				.setDisabled(!editable)
				.onChange(value => setter(transformer.back(value))))
		}
	}

	public override onOpen(): void {
		super.onOpen()
		const { plugin, placeholder, data, ui } = this,
			[listEl, listElRemover] = useSettings(this.contentEl),
			{ language } = plugin,
			{ i18n } = language,
			editables = this.#editables,
			title = this.#title
		if (!isUndefined(title)) {
			ui.new(() => listEl.createEl("h1"), ele => {
				ele.textContent = title()
			})
		}
		ui.finally(listElRemover)
			.newSetting(listEl, setting => {
				if (!editables.includes("prepend")) {
					setting.settingEl.remove()
					return
				}
				setting
					.setName(i18n.t("components.editable-list.prepend"))
					.addButton(button => {
						button
							.setIcon(i18n.t("asset:components.editable-list.prepend-icon"))
							.setTooltip(i18n.t("components.editable-list.prepend"))
							.onClick(async () => {
								data.unshift(placeholder())
								this.#setupListSubUI()
								await this.postMutate()
							})
					})
			})
			.embed(() => {
				const subUI = new UpdatableUI(),
					ele = useSubsettings(listEl)
				this.#setupListSubUI = (): void => { this.setupListSubUI(subUI, ele) }
				this.#setupListSubUI()
				return subUI
			})
			.newSetting(listEl, setting => {
				if (!editables.includes("append")) {
					setting.settingEl.remove()
					return
				}
				setting
					.setName(i18n.t("components.editable-list.append"))
					.addButton(button => button
						.setIcon(i18n.t("asset:components.editable-list.append-icon"))
						.setTooltip(i18n.t("components.editable-list.append"))
						.onClick(async () => {
							data.push(placeholder())
							this.#setupListSubUI()
							await this.postMutate()
						}))
			})
			.finally(language.onChangeLanguage.listen(() => { ui.update() }))
	}

	public override onClose(): void {
		super.onClose()
		this.ui.destroy()
	}

	protected async postMutate(): Promise<void> {
		const { data, ui } = this,
			cb = this.#callback(typedStructuredClone(data))
		ui.update()
		await cb
	}

	protected setupListSubUI(ui: UpdatableUI, element: HTMLElement): void {
		const { plugin, data } = this,
			editables = this.#editables,
			namer = this.#namer,
			{ language } = plugin,
			{ i18n } = language
		ui.destroy()
		for (const [index, item] of data.entries()) {
			ui.newSetting(element, setting => {
				setting.setName(namer(item, index, data))
				this.#inputter(
					setting,
					editables.includes("edit"),
					() => item,
					async value => {
						data[index] = value
						await this.postMutate()
					},
				)
				if (editables.includes("remove")) {
					setting
						.addButton(button => button
							.setTooltip(i18n.t("components.editable-list.remove"))
							.setIcon(i18n.t("asset:components.editable-list.remove-icon"))
							.onClick(async () => {
								removeAt(data, index)
								this.#setupListSubUI()
								await this.postMutate()
							}))
				}
				if (editables.includes("moveUp")) {
					setting.addExtraButton(button => button
						.setTooltip(i18n.t("components.editable-list.move-up"))
						.setIcon(i18n.t("asset:components.editable-list.move-up-icon"))
						.onClick(async () => {
							if (index <= 0) { return }
							swap(data, index - 1, index)
							this.#setupListSubUI()
							await this.postMutate()
						}))
				}
				if (editables.includes("moveDown")) {
					setting.addExtraButton(button => button
						.setTooltip(i18n.t("components.editable-list.move-down"))
						.setIcon(i18n.t("asset:components.editable-list.move-down-icon"))
						.onClick(async () => {
							if (index >= data.length - 1) { return }
							swap(data, index, index + 1)
							this.#setupListSubUI()
							await this.postMutate()
						}))
				}
			})
		}
	}

	#setupListSubUI = (): void => { }
}

export class ProfileModal extends Modal {
	protected readonly ui = new UpdatableUI()
	protected readonly data
	readonly #callback
	readonly #presets
	#preset = NaN

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
		this.data = cloneAsWritable(data)
		this.#callback = callback
		this.#presets = presets
	}

	public override onOpen(): void {
		super.onOpen()
		const { plugin, ui, data } = this,
			[listEl, listElRemover] = useSettings(this.contentEl),
			profile = data,
			{ language } = plugin,
			{ i18n } = language
		let keepPreset = false
		ui.finally(listElRemover)
			.new(() => listEl.createEl("h1"), ele => {
				ele.textContent = i18n.t("components.profile.title", {
					name: Settings.Profile.name(profile),
				})
			})
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.profile.name"))
					.addText(linkSetting(
						() => Settings.Profile.name(profile),
						value => { profile.name = value },
						async () => this.postMutate(),
					))
					.addExtraButton(resetButton(
						plugin,
						i18n.t("asset:components.profile.name-icon"),
						() => {
							profile.name = Settings.Profile.DEFAULTS[profile.type].name
						},
						async () => this.postMutate(),
					))
			})
			.newSetting(listEl, setting => {
				if (!keepPreset) { this.#preset = NaN }
				keepPreset = false
				setting
					.setName(i18n.t("components.profile.preset"))
					.addDropdown(linkSetting(
						() => this.#preset.toString(),
						value => { this.#preset = Number(value) },
						async () => {
							const preset = this.#presets[this.#preset]
							if (isUndefined(preset)) { return }
							this.replaceData(cloneAsWritable(preset.value))
							this.#setupTypedUI()
							keepPreset = true
							await this.postMutate()
						},
						{
							pre: component => {
								component
									.addOption(NaN.toString(), i18n
										.t("components.dropdown.unselected"))
									.addOptions(Object.fromEntries(this.#presets
										.map((selection, index) => [index, selection.name])))
							},
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
								this.replaceData(cloneAsWritable(Settings.Profile
									.DEFAULTS[value]))
							},
						),
						async () => {
							this.#setupTypedUI()
							await this.postMutate()
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
					ele = useSubsettings(listEl)
				this.#setupTypedUI = (): void => {
					this.setupTypedUI(typedUI, ele)
				}
				this.#setupTypedUI()
				return typedUI
			}, null, () => { this.#setupTypedUI = (): void => { } })
			.finally(language.onChangeLanguage.listen(() => { ui.update() }))
	}

	public override onClose(): void {
		super.onClose()
		this.ui.destroy()
	}

	protected async postMutate(): Promise<void> {
		const { data, ui } = this,
			cb = this.#callback(typedStructuredClone(data))
		ui.update()
		await cb
	}

	protected replaceData(profile: DeepWritable<Settings.Profile>): void {
		const { data } = this,
			{ name } = data
		clearProperties(data)
		Object.assign(data, profile, {
			name,
		})
	}

	protected setupTypedUI(ui: UpdatableUI, element: HTMLElement): void {
		const { plugin, data } = this,
			profile = data,
			{ i18n } = plugin.language
		ui.destroy()
		switch (profile.type) {
			case "": {
				break
			}
			case "console": {
				break
			}
			case "external": {
				ui.newSetting(element, setting => {
					setting
						.setName(i18n.t(`components.profile.${profile.type}.executable`))
						.addText(linkSetting(
							() => profile.executable,
							value => { profile.executable = value },
							async () => this.postMutate(),
						))
						.addExtraButton(resetButton(
							plugin,
							i18n
								.t(`asset:components.profile.${profile.type}.executable-icon`),
							() => {
								profile.executable =
									Settings.Profile.DEFAULTS[profile.type].executable
							},
							async () => this.postMutate(),
						))
				}).newSetting(element, setting => {
					setting
						.setName(i18n.t(`components.profile.${profile.type}.arguments`))
						.setDesc(i18n.t("settings.list-description", {
							count: profile.args.length,
						}))
						.addButton(button => button
							.setIcon(i18n.t("asset:generic.edit-list-icon"))
							.setTooltip(i18n.t("generic.edit"))
							.onClick(() => {
								new ListModal(
									plugin,
									ListModal.stringInputter({ back: identity, forth: identity }),
									() => "",
									profile.args,
									{
										callback: async (value): Promise<void> => {
											profile.args = value
											await this.postMutate()
										},
										title: () =>
											i18n.t(`components.profile.${profile.type}.arguments`),
									},
								).open()
							}))
						.addExtraButton(resetButton(
							plugin,
							i18n.t(`asset:components.profile.${profile.type}.arguments-icon`),
							() => {
								profile.args =
									cloneAsWritable(Settings.Profile.DEFAULTS[profile.type].args)
							},
							async () => this.postMutate(),
						))
				})
				for (const platform of Pseudoterminal.SUPPORTED_PLATFORMS) {
					ui.newSetting(element, setting => {
						setting
							.setName(i18n.t(`types.platforms.${platform}`))
							.addToggle(linkSetting(
								() => profile.platforms[platform] ??
									Settings.Profile.DEFAULTS[profile.type].platforms[platform],
								value => {
									profile.platforms[platform] = value
								},
								async () => this.postMutate(),
							))
							.addExtraButton(resetButton(
								plugin,
								i18n.t(`asset:types.platforms.${platform}-icon`),
								() => {
									profile.platforms[platform] =
										Settings.Profile.DEFAULTS[profile.type].platforms[platform]
								},
								async () => this.postMutate(),
							))
					})
				}
				break
			}
			case "integrated": {
				ui.newSetting(element, setting => {
					setting
						.setName(i18n.t(`components.profile.${profile.type}.executable`))
						.addText(linkSetting(
							() => profile.executable,
							value => {
								profile.executable = value
							},
							async () => this.postMutate(),
						))
						.addExtraButton(resetButton(
							plugin,
							i18n
								.t(`asset:components.profile.${profile.type}.executable-icon`),
							() => {
								profile.executable =
									Settings.Profile.DEFAULTS[profile.type].executable
							},
							async () => this.postMutate(),
						))
				}).newSetting(element, setting => {
					setting
						.setName(i18n.t(`components.profile.${profile.type}.arguments`))
						.setDesc(i18n.t("settings.list-description", {
							count: profile.args.length,
						}))
						.addButton(button => button
							.setIcon(i18n.t("asset:generic.edit-list-icon"))
							.setTooltip(i18n.t("generic.edit"))
							.onClick(() => {
								new ListModal(
									plugin,
									ListModal.stringInputter({ back: identity, forth: identity }),
									() => "",
									profile.args,
									{
										callback: async (value): Promise<void> => {
											profile.args = value
											await this.postMutate()
										},
										title: () =>
											i18n.t(`components.profile.${profile.type}.arguments`),
									},
								).open()
							}))
						.addExtraButton(resetButton(
							plugin,
							i18n.t(`asset:components.profile.${profile.type}.arguments-icon`),
							() => {
								profile.args =
									cloneAsWritable(Settings.Profile.DEFAULTS[profile.type].args)
							},
							async () => this.postMutate(),
						))
				})
				for (const platform of Pseudoterminal.SUPPORTED_PLATFORMS) {
					ui.newSetting(element, setting => {
						setting
							.setName(i18n.t(`types.platforms.${platform}`))
							.addToggle(linkSetting(
								() => profile.platforms[platform] ??
									Settings.Profile.DEFAULTS[profile.type].platforms[platform],
								value => {
									profile.platforms[platform] = value
								},
								async () => this.postMutate(),
							))
							.addExtraButton(resetButton(
								plugin,
								i18n.t(`asset:types.platforms.${platform}-icon`),
								() => {
									profile.platforms[platform] =
										Settings.Profile.DEFAULTS[profile.type].platforms[platform]
								},
								async () => this.postMutate(),
							))
					})
				}
				ui.newSetting(element, setting => {
					setting
						.setName(i18n
							.t(`components.profile.${profile.type}.python-executable`))
						.setDesc(i18n.t(`components.profile.${profile
							.type}.python-executable-description`))
						.addText(linkSetting(
							() => profile.pythonExecutable,
							value => {
								profile.pythonExecutable = value
							},
							async () => this.postMutate(),
							{
								post: component => {
									component
										.setPlaceholder(i18n
											.t(`components.profile.${profile
												.type}.python-executable-placeholder`))
								},
							},
						))
						.addExtraButton(resetButton(
							plugin,
							i18n.t(`asset:components.profile.${profile
								.type}.python-executable-icon`),
							() => {
								profile.pythonExecutable =
									Settings.Profile.DEFAULTS[profile.type].pythonExecutable
							},
							async () => this.postMutate(),
						))
				}).newSetting(element, setting => {
					setting
						.setName(i18n

							.t(`components.profile.${profile
								.type}.enable-Windows-conhost-workaround`))
						.setDesc(i18n
							.t(`components.profile.${profile
								.type}.enable-Windows-conhost-workaround-description`))
						.addToggle(linkSetting(
							() => profile.enableWindowsConhostWorkaround ??
								Settings.Profile.DEFAULTS[profile.type]
									.enableWindowsConhostWorkaround,
							value => {
								profile.enableWindowsConhostWorkaround = value
							},
							async () => this.postMutate(),
						))
						.addExtraButton(resetButton(
							plugin,
							i18n
								.t(`asset:components.profile.${profile
									.type}.enable-Windows-conhost-workaround-icon`),
							() => {
								profile.enableWindowsConhostWorkaround =
									Settings.Profile.DEFAULTS[profile.type]
										.enableWindowsConhostWorkaround
							},
							async () => this.postMutate(),
						))
				})
				break
			}
			case "invalid": {
				ui.newSetting(element, setting => {
					setting
						.setName(i18n.t(`components.profile.${profile.type}.data`))
						.addTextArea(textArea => textArea
							.setValue(JSON.stringify(profile, null, JSON_STRINGIFY_SPACE))
							.setDisabled(true))
						.addExtraButton(resetButton(
							plugin,
							i18n.t(`asset:components.profile.${profile.type}.data-icon`),
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

	#setupTypedUI = (): void => { }
}

export class ProfileListModal extends Modal {
	protected readonly ui = new UpdatableUI()
	protected readonly data
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
		this.data = cloneAsWritable(data)
		this.#callback = callback
		this.#presets = presets
		this.#keygen = keygen
	}

	public override onOpen(): void {
		super.onOpen()
		const { plugin, ui, data } = this,
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
							this.addProfile(0, cloneAsWritable(value))
							this.#setupListSubUI()
							await this.postMutate()
						},
					))
			})
			.embed(() => {
				const subUI = new UpdatableUI(),
					ele = useSubsettings(listEl)
				this.#setupListSubUI = (): void => {
					this.setupListSubUI(subUI, ele)
				}
				this.#setupListSubUI()
				return subUI
			})
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.editable-list.append"))
					.addDropdown(dropdownSelect(
						i18n.t("components.dropdown.unselected"),
						this.#presets,
						async value => {
							this.addProfile(data.length, cloneAsWritable(value))
							this.#setupListSubUI()
							await this.postMutate()
						},
					))
			})
			.finally(language.onChangeLanguage.listen(() => { ui.update() }))
	}

	public override onClose(): void {
		super.onClose()
		this.ui.update()
	}

	protected async postMutate(): Promise<void> {
		const { data, ui } = this,
			cb = this.#callback(cloneAsWritable(data))
		ui.update()
		await cb
	}

	protected addProfile(
		index: number,
		profile: DeepWritable<Settings.Profile>,
	): void {
		const { data } = this
		insertAt(
			data,
			index,
			[randomNotIn(data.map(entry => entry[0]), this.#keygen), profile],
		)
	}

	protected setupListSubUI(ui: UpdatableUI, element: HTMLElement): void {
		const { plugin, data } = this,
			{ language } = plugin,
			{ i18n } = language
		ui.destroy()
		for (const [index, value] of data.entries()) {
			ui.newSetting(element, setting => {
				setting
					.setName(i18n.t("components.profile-list.name", {
						id: value[0],
						name: Settings.Profile.name(value[1]),
					}))
					.setDesc(i18n
						.t("components.profile-list.description", {
							id: value[0],
							name: Settings.Profile.name(value[1]),
						}))
					.addButton(button => button
						.setIcon(i18n.t("asset:generic.edit-icon"))
						.setTooltip(i18n.t("generic.edit"))
						.onClick(() => {
							new ProfileModal(
								plugin,
								value[1],
								async profile0 => {
									value[1] = profile0
									await this.postMutate()
								},
							).open()
						}))
					.addButton(button => button
						.setIcon(i18n.t("asset:components.editable-list.remove-icon"))
						.setTooltip(i18n.t("components.editable-list.remove"))
						.onClick(async () => {
							removeAt(data, index)
							this.#setupListSubUI()
							await this.postMutate()
						}))
					.addExtraButton(button => button
						.setTooltip(i18n.t("components.editable-list.move-up"))
						.setIcon(i18n.t("asset:components.editable-list.move-up-icon"))
						.onClick(async () => {
							if (index <= 0) { return }
							swap(data, index - 1, index)
							this.#setupListSubUI()
							await this.postMutate()
						}))
					.addExtraButton(button => button
						.setTooltip(i18n.t("components.editable-list.move-down"))
						.setIcon(i18n.t("asset:components.editable-list.move-down-icon"))
						.onClick(async () => {
							if (index >= data.length - 1) { return }
							swap(data, index, index + 1)
							this.#setupListSubUI()
							await this.postMutate()
						}))
			})
		}
	}

	#setupListSubUI = (): void => { }
}

export class DialogModal extends Modal {
	protected readonly modalUI = new UpdatableUI()
	readonly #cancel
	readonly #confirm
	readonly #draw
	readonly #drawUI = new UpdatableUI()
	readonly #doubleConfirmTimeout

	public constructor(
		protected readonly plugin: TerminalPlugin,
		options?: {
			cancel?: (close: () => void) => unknown
			confirm?: (close: () => void) => unknown
			draw?: (ui: UpdatableUI, self: DialogModal) => void
			doubleConfirmTimeout?: number
		},
	) {
		super(plugin.app)
		this.#doubleConfirmTimeout = options?.doubleConfirmTimeout
		this.#cancel = options?.cancel ?? ((close): void => { close() })
		this.#confirm = options?.confirm ?? ((close): void => { close() })
		this.#draw = options?.draw ?? ((): void => { })
	}

	public override onOpen(): void {
		super.onOpen()
		const { plugin, modalEl, scope, modalUI } = this,
			doubleConfirmTimeout = this.#doubleConfirmTimeout,
			{ language } = plugin,
			{ i18n } = language
		let confirmButton: ButtonComponent | null = null,
			preconfirmed = (doubleConfirmTimeout ?? 0) <= 0
		modalUI
			.newSetting(modalEl, setting => {
				setting
					.addButton(button => {
						button
							.setIcon(i18n.t("asset:components.dialog.confirm-icon"))
							.setTooltip(i18n.t("components.dialog.confirm"))
							.onClick(async () => this.confirm(this.#close))
						if (preconfirmed) {
							button.setCta()
						} else {
							button.setWarning()
						}
						confirmButton = button
					})
					.addButton(button => button
						.setIcon(i18n.t("asset:components.dialog.cancel-icon"))
						.setTooltip(i18n.t("components.dialog.cancel"))
						.onClick(async () => this.cancel(this.#close)))
			})
			// Hooking escape does not work as it is already registered
			.new(() => scope.register([], "enter", async event => {
				if (preconfirmed) {
					await this.confirm(this.#close)
				} else {
					window.setTimeout(() => {
						preconfirmed = false
						confirmButton?.removeCta().setWarning()
					}, doubleConfirmTimeout)
					preconfirmed = true
					confirmButton?.setCta().buttonEl.removeClass(DOMClasses.MOD_WARNING)
				}
				event.preventDefault()
				event.stopPropagation()
			}), null, ele => { scope.unregister(ele) })
			.finally(language.onChangeLanguage.listen(() => { modalUI.update() }))
		this.#draw(this.#drawUI, this)
	}

	public override onClose(): void {
		super.onClose()
		this.#drawUI.destroy()
		this.modalUI.destroy()
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

	protected async confirm(close: () => void): Promise<void> {
		await this.#confirm(close)
	}

	protected async cancel(close: () => void): Promise<void> {
		await this.#cancel(close)
	}

	readonly #close = (): void => { super.close() }
}
