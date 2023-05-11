import {
	type ButtonComponent,
	Modal,
	type Setting,
	type ValueComponent,
} from "obsidian"
import {
	CHECK_EXECUTABLE_WAIT,
	DEFAULT_PYTHONIOENCODING,
	DISABLED_TOOLTIP,
	DOMClasses,
	JSON_STRINGIFY_SPACE,
	SI_PREFIX_SCALE,
} from "sources/magic"
import {
	PROFILE_PRESETS,
	PROFILE_PRESET_ORDERED_KEYS,
} from "sources/settings/profile-presets"
import {
	UpdatableUI,
	notice2,
	printError,
	statusUI,
	useSettings,
	useSubsettings,
} from "sources/utils/obsidian"
import {
	anyToError,
	bracket,
	clearProperties,
	cloneAsWritable,
	consumeEvent,
	createChildElement,
	deepFreeze,
	randomNotIn,
	removeAt,
	requireNonNil,
	swap,
	typedStructuredClone,
	unexpected,
} from "sources/utils/util"
import { constant, identity, isUndefined } from "lodash-es"
import {
	dropdownSelect,
	linkSetting,
	resetButton,
	setTextToEnum,
} from "./settings"
import type { DeepWritable } from "ts-essentials"
import type { Fixed } from "./fixers"
import { PROFILE_PROPERTIES } from "sources/settings/profile-properties"
import { Platform } from "sources/utils/platforms"
import { Pseudoterminal } from "sources/terminal/pseudoterminal"
import SemVer from "semver/classes/semver"
import { Settings } from "sources/settings/data"
import type { TerminalPlugin } from "sources/main"
import { dynamicRequire } from "sources/imports"
import semverCoerce from "semver/functions/coerce"

const
	childProcess =
		dynamicRequire<typeof import("node:child_process")>("node:child_process"),
	process = dynamicRequire<typeof import("node:process")>("node:process"),
	util = dynamicRequire<typeof import("node:util")>("node:util"),
	// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
	execFileP = (async () =>
		(await util).promisify((await childProcess).execFile))()

export function makeModalDynamicWidth(
	ui: UpdatableUI,
	element: HTMLElement,
): void {
	const { width } = element.style
	element.style.width = "unset"
	ui.finally(() => { element.style.width = width })
}

export class ListModal<T> extends Modal {
	protected readonly modalUI = new UpdatableUI()
	protected readonly ui = new UpdatableUI()
	protected readonly data
	readonly #inputter
	readonly #callback
	readonly #editables
	readonly #title
	readonly #description
	readonly #namer
	readonly #descriptor
	readonly #presets
	readonly #presetPlaceholder
	readonly #dynamicWidth

	public constructor(
		protected readonly plugin: TerminalPlugin,
		protected readonly inputter: (
			setting: Setting,
			editable: boolean,
			getter: () => T,
			setter: (setter: (
				item: T,
				index: number,
				data: T[],
			) => unknown) => unknown,
		) => void,
		protected readonly placeholder: () => T,
		data: readonly T[],
		options?: ListModal.Options<T>,
	) {
		const { app, language } = plugin,
			{ i18n } = language
		super(app)
		this.data = [...data]
		this.#inputter = inputter
		this.#callback = options?.callback ?? ((): void => { })
		this.#editables = deepFreeze([...options?.editables ?? ListModal.EDITABLES])
		this.#title = options?.title
		this.#description = options?.description
		this.#namer = options?.namer ?? ((_0, index): string =>
			i18n.t("components.list.name", {
				count: index + 1,
				interpolation: { escapeValue: false },
				ordinal: true,
			}))
		this.#descriptor = options?.descriptor ?? ((): string => "")
		this.#presets = options?.presets
		this.#presetPlaceholder = options?.presetPlaceholder ?? ((): string =>
			i18n.t("components.list.preset-placeholder"))
		this.#dynamicWidth = options?.dynamicWidth ?? false
	}

	public static stringInputter<T>(transformer: {
		readonly forth: (value: T) => string
		readonly back: (value: string) => T
	}) {
		return (
			setting: Setting,
			editable: boolean,
			getter: () => T,
			setter: (setter: (
				item: T,
				index: number,
				data: T[],
			) => unknown) => unknown,
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
				.onChange(value => setter((_0, index, data) => {
					data[index] = transformer.back(value)
				})))
		}
	}

	public override onOpen(): void {
		super.onOpen()
		const { plugin, placeholder, data, ui, titleEl, modalUI, modalEl } = this,
			{ element: listEl, remover: listElRemover } = useSettings(this.contentEl),
			{ language } = plugin,
			{ i18n, onChangeLanguage } = language,
			editables = this.#editables,
			title = this.#title,
			description = this.#description,
			presets = this.#presets,
			presetPlaceholder = this.#presetPlaceholder
		modalUI.finally(onChangeLanguage.listen(() => { modalUI.update() }))
		ui.finally(listElRemover)
			.finally(onChangeLanguage.listen(() => { ui.update() }))
		if (this.#dynamicWidth) { makeModalDynamicWidth(modalUI, modalEl) }
		if (title) {
			modalUI.new(constant(titleEl), ele => {
				ele.textContent = title()
			}, ele => { ele.textContent = null })
		}
		if (description) {
			ui.new(() => createChildElement(listEl, "div"), ele => {
				ele.textContent = description()
			})
		}
		ui.newSetting(listEl, setting => {
			if (!editables.includes("prepend")) {
				setting.settingEl.remove()
				return
			}
			if (presets) {
				setting
					.setName(i18n.t("components.list.prepend"))
					.addDropdown(dropdownSelect(
						presetPlaceholder("prepend"),
						presets,
						async value => {
							data.unshift(value)
							this.#setupListSubUI()
							await this.postMutate()
						},
					))
					.addExtraButton(resetButton(
						i18n.t("asset:components.list.prepend-icon"),
						DISABLED_TOOLTIP,
						unexpected,
						unexpected,
						{ post(component) { component.setDisabled(true) } },
					))
				return
			}
			setting
				.setName(i18n.t("components.list.prepend"))
				.addButton(button => {
					button
						.setIcon(i18n.t("asset:components.list.prepend-icon"))
						.setTooltip(i18n.t("components.list.prepend"))
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
				if (presets) {
					setting
						.setName(i18n.t("components.list.append"))
						.addDropdown(dropdownSelect(
							presetPlaceholder("append"),
							presets,
							async value => {
								data.push(value)
								this.#setupListSubUI()
								await this.postMutate()
							},
						))
						.addExtraButton(resetButton(
							i18n.t("asset:components.list.append-icon"),
							DISABLED_TOOLTIP,
							unexpected,
							unexpected,
							{ post(component) { component.setDisabled(true) } },
						))
					return
				}
				setting
					.setName(i18n.t("components.list.append"))
					.addButton(button => button
						.setIcon(i18n.t("asset:components.list.append-icon"))
						.setTooltip(i18n.t("components.list.append"))
						.onClick(async () => {
							data.push(placeholder())
							this.#setupListSubUI()
							await this.postMutate()
						}))
			})
	}

	public override onClose(): void {
		super.onClose()
		this.modalUI.destroy()
		this.ui.destroy()
	}

	protected async postMutate(): Promise<void> {
		const { data, ui, modalUI } = this,
			cb = this.#callback([...data])
		modalUI.update()
		ui.update()
		await cb
	}

	protected setupListSubUI(ui: UpdatableUI, element: HTMLElement): void {
		const { plugin, data } = this,
			editables = this.#editables,
			namer = this.#namer,
			descriptor = this.#descriptor,
			{ language } = plugin,
			{ i18n } = language
		ui.destroy()
		for (const [index] of data.entries()) {
			ui.newSetting(element, setting => {
				const { valid, value: item } = bracket(data, index)
				if (!valid) { throw new Error(index.toString()) }
				setting.setName(namer(item, index, data))
					.setDesc(descriptor(item, index, data))
				this.#inputter(
					setting,
					editables.includes("edit"),
					() => item,
					async setter => {
						await setter(item, index, data)
						await this.postMutate()
					},
				)
				if (editables.includes("remove")) {
					setting
						.addButton(button => button
							.setTooltip(i18n.t("components.list.remove"))
							.setIcon(i18n.t("asset:components.list.remove-icon"))
							.onClick(async () => {
								removeAt(data, index)
								this.#setupListSubUI()
								await this.postMutate()
							}))
				}
				if (editables.includes("moveUp")) {
					setting.addExtraButton(button => button
						.setTooltip(i18n.t("components.list.move-up"))
						.setIcon(i18n.t("asset:components.list.move-up-icon"))
						.onClick(async () => {
							if (index <= 0) { return }
							swap(data, index - 1, index)
							this.#setupListSubUI()
							await this.postMutate()
						}))
				}
				if (editables.includes("moveDown")) {
					setting.addExtraButton(button => button
						.setTooltip(i18n.t("components.list.move-down"))
						.setIcon(i18n.t("asset:components.list.move-down-icon"))
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
export namespace ListModal {
	export const EDITABLES = deepFreeze([
		"edit",
		"append",
		"prepend",
		"remove",
		"moveUp",
		"moveDown",
	])
	export interface Options<T> {
		readonly callback?: (data_: T[]) => unknown
		readonly editables?: readonly typeof EDITABLES[number][]
		readonly title?: () => string
		readonly description?: () => string
		readonly namer?: (value: T, index: number, data: readonly T[]) => string
		readonly descriptor?: (
			value: T,
			index: number,
			data: readonly T[],
		) => string
		readonly presets?: readonly {
			readonly name: string
			readonly value: T
		}[]
		readonly presetPlaceholder?: (action: "append" | "prepend") => string
		readonly dynamicWidth?: boolean
	}
}

export class EditDataModal<T extends object> extends Modal {
	protected readonly modalUI = new UpdatableUI()
	protected readonly ui = new UpdatableUI()
	protected readonly data
	#dataText
	readonly #callback
	readonly #title

	public constructor(
		protected readonly plugin: TerminalPlugin,
		protected readonly protodata: T,
		protected readonly fixer: (data: unknown) => Fixed<T>,
		options?: EditDataModal.Options<T>,
	) {
		super(plugin.app)
		this.data = cloneAsWritable(protodata)
		this.#dataText = JSON.stringify(this.data, null, JSON_STRINGIFY_SPACE)
		this.#callback = options?.callback ?? ((): void => { })
		this.#title = options?.title
	}

	public override onOpen(): void {
		super.onOpen()
		const { modalUI, ui, modalEl, titleEl, plugin, protodata, fixer } = this,
			{ element: listEl, remover: listElRemover } = useSettings(this.contentEl),
			{ language } = plugin,
			{ i18n, onChangeLanguage } = language,
			title = this.#title
		modalUI.finally(onChangeLanguage.listen(() => { modalUI.update() }))
		ui.finally(listElRemover)
			.finally(onChangeLanguage.listen(() => { ui.update() }))
		makeModalDynamicWidth(modalUI, modalEl)
		if (title) {
			modalUI.new(constant(titleEl), ele => {
				ele.textContent = title()
			}, ele => { ele.textContent = null })
		}
		const errorEl = statusUI(ui, createChildElement(listEl, "div", ele => {
			ele.classList.add(DOMClasses.MOD_WARNING)
		}))
		ui.finally(() => { this.#resetDataText() })
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.edit-data.export"))
					.addButton(button => button
						.setIcon(i18n
							.t("asset:components.edit-data.export-to-clipboard-icon"))
						.setTooltip(i18n.t("components.edit-data.export-to-clipboard"))
						.onClick(async () => {
							try {
								await requireNonNil(
									button.buttonEl.ownerDocument.defaultView,
								).navigator.clipboard.writeText(this.#dataText)
							} catch (error) {
								self.console.debug(error)
								errorEl.report(error)
								return
							}
							errorEl.report()
						}))
			})
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.edit-data.import"))
					.addButton(button => button
						.setIcon(i18n
							.t("asset:components.edit-data.import-from-clipboard-icon"))
						.setTooltip(i18n.t("components.edit-data.import-from-clipboard"))
						.onClick(async () => {
							try {
								const { value: parsed, valid } =
									fixer(JSON.parse(
										await requireNonNil(
											button.buttonEl.ownerDocument.defaultView,
										).navigator.clipboard.readText(),
									))
								if (!valid) {
									throw new Error(i18n.t("errors.malformed-data"))
								}
								this.replaceData(parsed)
							} catch (error) {
								self.console.debug(error)
								errorEl.report(error)
								return
							}
							errorEl.report()
							this.#resetDataText()
							await this.postMutate()
						}))
			})
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.edit-data.data"))
					.addTextArea(linkSetting(
						() => this.#dataText,
						value => { this.#dataText = value },
						async value => {
							try {
								const { value: parsed, valid } = fixer(JSON.parse(value))
								if (!valid) {
									throw new Error(i18n.t("errors.malformed-data"))
								}
								this.replaceData(parsed)
							} catch (error) {
								self.console.debug(error)
								errorEl.report(error)
								return
							}
							errorEl.report()
							await this.postMutate()
						},
					))
					.addExtraButton(resetButton(
						i18n.t("asset:components.edit-data.data-icon"),
						i18n.t("components.edit-data.reset"),
						() => { this.replaceData(cloneAsWritable(protodata)) },
						async () => {
							this.#resetDataText()
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

	protected replaceData(data: typeof this.data): void {
		clearProperties(this.data)
		Object.assign(this.data, data)
	}

	#resetDataText(): void {
		this.#dataText = JSON.stringify(this.data, null, JSON_STRINGIFY_SPACE)
	}
}
export namespace EditDataModal {
	export interface Options<T> {
		readonly callback?: (data: DeepWritable<T>) => unknown
		readonly title?: () => string
	}
}

export class ProfileModal extends Modal {
	protected readonly modalUI = new UpdatableUI()
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
					return plugin.language.i18n.t(`profile-presets.${key}`)
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
		const { plugin, ui, data, titleEl, modalUI } = this,
			{ element: listEl, remover: listElRemover } = useSettings(this.contentEl),
			profile = data,
			{ language } = plugin,
			{ i18n, onChangeLanguage } = language
		modalUI.new(() => titleEl, ele => {
			ele.textContent = i18n.t("components.profile.title", {
				interpolation: { escapeValue: false },
				name: Settings.Profile.name(profile),
				profile,
			})
		}, ele => { ele.textContent = null })
		ui.finally(listElRemover)
			.finally(onChangeLanguage.listen(() => { ui.update() }))
		let keepPreset = false
		ui
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.profile.name"))
					.addText(linkSetting(
						() => Settings.Profile.name(profile),
						value => { profile.name = value },
						async () => this.postMutate(),
					))
					.addExtraButton(resetButton(
						i18n.t("asset:components.profile.name-icon"),
						i18n.t("components.profile.reset"),
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
							if (!preset) { return }
							this.replaceData(cloneAsWritable(preset.value), true)
							this.#setupTypedUI()
							keepPreset = true
							await this.postMutate()
						},
						{
							pre: component => {
								component
									.addOption(NaN.toString(), i18n
										.t("components.profile.preset-placeholder"))
									.addOptions(Object.fromEntries(this.#presets
										.map((selection, index) => [index, selection.name])))
							},
						},
					))
					.addExtraButton(resetButton(
						i18n.t("asset:components.profile.preset-icon"),
						DISABLED_TOOLTIP,
						unexpected,
						unexpected,
						{ post(component) { component.setDisabled(true) } },
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
									.DEFAULTS[value]), true)
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
											.filter(type => PROFILE_PROPERTIES[type].valid)
											.map(type => [
												type,
												i18n.t("components.profile.type-options", {
													interpolation: { escapeValue: false },
													type,
												}),
											])))
							},
						},
					))
					.addExtraButton(resetButton(
						i18n.t("asset:components.profile.type-icon"),
						DISABLED_TOOLTIP,
						unexpected,
						unexpected,
						{ post(component) { component.setDisabled(true) } },
					))
			})
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.profile.data"))
					.addButton(button => {
						button
							.setIcon(i18n.t("asset:components.profile.data-icon"))
							.setTooltip(i18n.t("components.profile.data-edit"))
							.onClick(() => {
								new EditDataModal(
									plugin,
									profile,
									Settings.Profile.fix,
									{
										callback: async (profileM): Promise<void> => {
											this.replaceData(profileM)
											this.#setupTypedUI()
											await this.postMutate()
										},
										title(): string {
											return i18n.t("components.profile.data")
										},
									},
								).open()
							})
					})
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

	protected replaceData(
		profile: DeepWritable<Settings.Profile>,
		keepName = false,
	): void {
		const { data } = this,
			{ name } = data
		clearProperties(data)
		Object.assign(data, profile)
		if (keepName) { data.name = name }
	}

	protected setupTypedUI(ui: UpdatableUI, element: HTMLElement): void {
		const { plugin, data } = this,
			profile = data,
			{ i18n } = plugin.language
		ui.destroy()
		if (profile.type === "invalid") { return }
		ui.newSetting(element, setting => {
			setting
				.setName(i18n.t("components.profile.restore-history"))
				.addToggle(linkSetting(
					() => profile.restoreHistory,
					value => { profile.restoreHistory = value },
					async () => this.postMutate(),
				))
				.addExtraButton(resetButton(
					i18n.t("asset:components.profile.restore-history-icon"),
					i18n.t("components.profile.reset"),
					() => {
						profile.restoreHistory =
							Settings.Profile.DEFAULTS[profile.type].restoreHistory
					},
					async () => this.postMutate(),
				))
		}).newSetting(element, setting => {
			setting
				.setName(i18n.t("components.profile.success-exit-codes"))
				.setDesc(i18n.t("components.profile.success-exit-codes-description", {
					count: profile.successExitCodes.length,
					interpolation: { escapeValue: false },
				}))
				.addButton(button => button
					.setIcon(i18n
						.t("asset:components.profile.success-exit-codes-edit-icon"))
					.setTooltip(i18n.t("components.profile.success-exit-codes-edit"))
					.onClick(() => {
						new ListModal(
							plugin,
							ListModal.stringInputter({
								back: identity<string>,
								forth: identity,
							}),
							() => "",
							profile.successExitCodes,
							{
								callback: async (value): Promise<void> => {
									profile.successExitCodes = value
									await this.postMutate()
								},
								dynamicWidth: true,
								title: () =>
									i18n.t("components.profile.success-exit-codes"),
							},
						).open()
					}))
				.addExtraButton(resetButton(
					i18n.t("asset:components.profile.success-exit-codes-icon"),
					i18n.t("components.profile.reset"),
					() => {
						profile.successExitCodes =
							cloneAsWritable(Settings.Profile.DEFAULTS[profile.type]
								.successExitCodes)
					},
					async () => this.postMutate(),
				))
		})
		switch (profile.type) {
			case "": {
				break
			}
			case "developerConsole": {
				break
			}
			case "external":
			case "integrated": {
				ui.newSetting(element, setting => {
					setting
						.setName(i18n.t(`components.profile.${profile.type}.executable`))
						.addText(linkSetting(
							() => profile.executable,
							value => { profile.executable = value },
							async () => this.postMutate(),
						))
						.addExtraButton(resetButton(
							i18n
								.t(`asset:components.profile.${profile.type}.executable-icon`),
							i18n.t("components.profile.reset"),
							() => {
								profile.executable =
									Settings.Profile.DEFAULTS[profile.type].executable
							},
							async () => this.postMutate(),
						))
				}).newSetting(element, setting => {
					setting
						.setName(i18n.t(`components.profile.${profile.type}.arguments`))
						.setDesc(i18n.t(`components.profile.${profile
							.type}.arguments-description`, {
							count: profile.args.length,
							interpolation: { escapeValue: false },
						}))
						.addButton(button => button
							.setIcon(i18n.t(`asset:components.profile.${profile
								.type}.arguments-edit-icon`))
							.setTooltip(i18n
								.t(`components.profile.${profile.type}.arguments-edit`))
							.onClick(() => {
								new ListModal(
									plugin,
									ListModal.stringInputter({
										back: identity<string>,
										forth: identity,
									}),
									() => "",
									profile.args,
									{
										callback: async (value): Promise<void> => {
											profile.args = value
											await this.postMutate()
										},
										dynamicWidth: true,
										title: () =>
											i18n.t(`components.profile.${profile.type}.arguments`),
									},
								).open()
							}))
						.addExtraButton(resetButton(
							i18n.t(`asset:components.profile.${profile.type}.arguments-icon`),
							i18n.t("components.profile.reset"),
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
							.setName(i18n.t("components.profile.platform", {
								interpolation: { escapeValue: false },
								type: platform,
							}))
							.setDesc(i18n
								.t(`components.profile.platform-description-${platform ===
									Platform.CURRENT
									? "current"
									: ""}`))
							.addToggle(linkSetting(
								() => profile.platforms[platform] ??
									Settings.Profile.DEFAULTS[profile.type].platforms[platform],
								value => {
									profile.platforms[platform] = value
								},
								async () => this.postMutate(),
							))
							.addExtraButton(resetButton(
								i18n.t("asset:components.profile.platform-icon", {
									interpolation: { escapeValue: false },
									type: platform,
								}),
								i18n.t("components.profile.reset"),
								() => {
									profile.platforms[platform] =
										Settings.Profile.DEFAULTS[profile.type].platforms[platform]
								},
								async () => this.postMutate(),
							))
					})
				}
				if (profile.type === "integrated") {
					let checkingPython = false
					ui.newSetting(element, setting => {
						setting
							.setName(i18n
								.t(`components.profile.${profile.type}.Python-executable`))
							.setDesc(i18n.t(`components.profile.${profile
								.type}.Python-executable-description`))
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
													.type}.Python-executable-placeholder`))
									},
								},
							))
							.addButton(button => {
								const i18nVariant = checkingPython ? "ing" : ""
								button
									.setIcon(i18n.t(`asset:components.profile.${profile
										.type}.Python-executable-check${i18nVariant}-icon`))
									.setTooltip(i18n.t(`components.profile.${profile
										.type}.Python-executable-check${i18nVariant}`))
									.onClick(() => {
										if (checkingPython) { return }
										checkingPython = true;
										(async (): Promise<void> => {
											try {
												const { stdout, stderr } = await (await execFileP)(
													profile.pythonExecutable,
													["--version"],
													{
														env: {
															...(await process).env,
															// eslint-disable-next-line @typescript-eslint/naming-convention
															PYTHONIOENCODING: DEFAULT_PYTHONIOENCODING,
														},
														timeout: CHECK_EXECUTABLE_WAIT *
															SI_PREFIX_SCALE,
														windowsHide: true,
													},
												)
												if (stdout) { self.console.log(stdout) }
												if (stderr) { self.console.error(stderr) }
												if (!stdout.includes(i18n
													.t("asset:magic.Python-version-magic"))) {
													throw new Error(i18n.t("errors.not-Python"))
												}
												notice2(
													() => i18n.t("notices.Python-version-is", {
														interpolation: { escapeValue: false },
														version: new SemVer(
															semverCoerce(stdout, { loose: true }) ?? stdout,
															{ loose: true },
														).version,
													}),
													plugin.settings.noticeTimeout,
													plugin,
												)
											} catch (error) {
												printError(
													anyToError(error),
													() => i18n.t("errors.error-checking-Python"),
													plugin,
												)
											} finally {
												checkingPython = false
												ui.update()
											}
										})()
										ui.update()
									})
								if (checkingPython) { button.setCta() }
							})
							.addExtraButton(resetButton(
								i18n.t(`asset:components.profile.${profile
									.type}.Python-executable-icon`),
								i18n.t("components.profile.reset"),
								() => {
									profile.pythonExecutable =
										Settings.Profile.DEFAULTS[profile.type].pythonExecutable
								},
								async () => this.postMutate(),
							))
					}).newSetting(element, setting => {
						setting
							.setName(i18n
								.t(`components.profile.${profile.type}.use-win32-conhost`))
							.setDesc(i18n.t(`components.profile.${profile
								.type}.use-win32-conhost-description`))
							.addToggle(linkSetting(
								() => profile.useWin32Conhost,
								value => { profile.useWin32Conhost = value },
								async () => this.postMutate(),
							))
							.addExtraButton(resetButton(
								i18n
									.t(`asset:components.profile.${profile
										.type}.use-win32-conhost-icon`),
								i18n.t("components.profile.reset"),
								() => {
									profile.useWin32Conhost =
										Settings.Profile.DEFAULTS[profile.type]
											.useWin32Conhost
								},
								async () => this.postMutate(),
							))
					})
				}
				break
			}
			// No default
		}
	}

	#setupTypedUI = (): void => { }
}

export class ProfileListModal
	extends ListModal<DeepWritable<Settings.Profile>> {
	protected readonly dataKeys

	public constructor(
		plugin: TerminalPlugin,
		data: readonly Settings.Profile.Entry[],
		options?: ProfileListModal.Options,
	) {
		const { i18n } = plugin.language,
			dataW = cloneAsWritable(data),
			dataKeys = new Map(dataW.map(([key, value]) => [value, key])),
			callback = options?.callback ?? ((): void => { }),
			keygen = options?.keygen ?? ((): string => self.crypto.randomUUID())
		super(
			plugin,
			(setting, editable, getter, setter) => {
				setting.addButton(button => button
					.setIcon(i18n.t("asset:components.profile-list.edit-icon"))
					.setTooltip(i18n.t("components.profile-list.edit"))
					.onClick(() => {
						new ProfileModal(
							plugin,
							getter(),
							async value => {
								await setter(item => {
									clearProperties(item)
									Object.assign(item, value)
								})
							},
						).open()
					})
					.setDisabled(!editable))
			},
			unexpected,
			dataW.map(([, value]) => value),
			{
				...options,
				...{
					async callback(data0): Promise<void> {
						await callback(data0
							.map(profile => {
								let id = dataKeys.get(profile)
								if (isUndefined(id)) {
									dataKeys.set(
										profile,
										id = randomNotIn([...dataKeys.values()], keygen),
									)
								}
								return [id, typedStructuredClone(profile)]
							}))
					},
				} satisfies ProfileListModal.PredefinedOptions,
				descriptor: options?.descriptor ?? ((profile): string => {
					const id = dataKeys.get(profile) ?? ""
					return i18n.t(`components.profile-list.descriptor-${Settings
						.Profile.isCompatible(profile, Platform.CURRENT)
						? ""
						: "incompatible"}`, {
						info: Settings.Profile.info([id, profile]),
						interpolation: { escapeValue: false },
					})
				}),
				namer: options?.namer ?? ((profile): string => {
					const id = dataKeys.get(profile) ?? ""
					return i18n.t(`components.profile-list.namer-${Settings
						.Profile.isCompatible(profile, Platform.CURRENT)
						? ""
						: "incompatible"}`, {
						info: Settings.Profile.info([id, profile]),
						interpolation: { escapeValue: false },
					})
				}),
				presetPlaceholder: options?.presetPlaceholder ?? ((): string =>
					i18n.t("components.profile-list.preset-placeholder")),
				presets: options?.presets ?? PROFILE_PRESET_ORDERED_KEYS
					.map(key => ({
						get name(): string {
							return plugin.language.i18n.t(`profile-presets.${key}`)
						},
						get value(): DeepWritable<Settings.Profile> {
							return cloneAsWritable(PROFILE_PRESETS[key])
						},
					})),
				title: options?.title ?? ((): string =>
					i18n.t("components.profile-list.title")),
			},
		)
		this.dataKeys = dataKeys
	}
}
export namespace ProfileListModal {
	type InitialOptions = ListModal.Options<DeepWritable<Settings.Profile>>
	export type PredefinedOptions = {
		readonly [K in "callback"]: InitialOptions[K]
	}
	export interface Options
		extends Omit<InitialOptions, keyof PredefinedOptions> {
		readonly callback?: (
			data: DeepWritable<Settings.Profile.Entry>[],
		) => unknown
		readonly keygen?: () => string
	}
}

export class DialogModal extends Modal {
	protected readonly modalUI = new UpdatableUI()
	protected readonly ui = new UpdatableUI()
	readonly #cancel
	readonly #confirm
	readonly #title
	readonly #description
	readonly #draw
	readonly #doubleConfirmTimeout
	readonly #dynamicWidth

	public constructor(
		protected readonly plugin: TerminalPlugin,
		options?: {
			cancel?: (close: () => void) => unknown
			confirm?: (close: () => void) => unknown
			title?: () => string
			description?: () => string
			draw?: (ui: UpdatableUI, element: HTMLElement) => void
			doubleConfirmTimeout?: number
			dynamicWidth?: boolean
		},
	) {
		super(plugin.app)
		this.#doubleConfirmTimeout = options?.doubleConfirmTimeout
		this.#cancel = options?.cancel ?? ((close): void => { close() })
		this.#confirm = options?.confirm ?? ((close): void => { close() })
		this.#title = options?.title
		this.#description = options?.description
		this.#draw = options?.draw ?? ((): void => { })
		this.#dynamicWidth = options?.dynamicWidth ?? false
	}

	public override onOpen(): void {
		super.onOpen()
		const { plugin, modalEl, scope, modalUI, titleEl, ui, contentEl } = this,
			{ language } = plugin,
			{ i18n, onChangeLanguage } = language,
			title = this.#title,
			description = this.#description,
			doubleConfirmTimeout = this.#doubleConfirmTimeout ?? 0
		modalUI.finally(onChangeLanguage.listen(() => { modalUI.update() }))
		ui.finally(onChangeLanguage.listen(() => { ui.update() }))
		if (this.#dynamicWidth) { makeModalDynamicWidth(modalUI, modalEl) }
		if (title) {
			modalUI.new(constant(titleEl), ele => {
				ele.textContent = title()
			}, ele => { ele.textContent = null })
		}
		const confirmOnce = doubleConfirmTimeout <= 0
		let confirmButton: ButtonComponent | null = null,
			preconfirmed = confirmOnce
		modalUI
			.newSetting(modalEl, setting => {
				if (!confirmOnce) {
					setting.setDesc(i18n.t("components.dialog.double-confirm-hint"))
				}
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
					self.setTimeout(() => {
						preconfirmed = false
						confirmButton?.removeCta().setWarning()
					}, doubleConfirmTimeout * SI_PREFIX_SCALE)
					preconfirmed = true
					confirmButton?.setCta().buttonEl
						.classList.remove(DOMClasses.MOD_WARNING)
				}
				consumeEvent(event)
			}), null, ele => { scope.unregister(ele) })
		if (description) {
			ui.new(() => createChildElement(contentEl, "div"), ele => {
				ele.textContent = description()
			}, ele => { ele.remove() })
		}
		this.#draw(ui, contentEl)
	}

	public override onClose(): void {
		super.onClose()
		this.modalUI.destroy()
		this.ui.destroy()
	}

	public override close(): void {
		(async (): Promise<void> => {
			try {
				await this.cancel(this.#close)
			} catch (error) {
				self.console.error(error)
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
