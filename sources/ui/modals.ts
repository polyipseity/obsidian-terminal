import {
	type ButtonComponent,
	Modal,
	type Setting,
	type ValueComponent,
} from "obsidian"
import {
	CHECK_EXECUTABLE_TIMEOUT,
	DEFAULT_PYTHONIOENCODING,
	DISABLED_TOOLTIP,
	DOMClasses,
	JSON_STRINGIFY_SPACE,
	SI_PREFIX_SCALE,
} from "sources/magic"
import {
	PLATFORM,
	anyToError,
	bracket,
	clearProperties,
	cloneAsWritable,
	consumeEvent,
	deepFreeze,
	identity,
	isUndefined,
	randomNotIn,
	removeAt,
	swap,
	typedStructuredClone,
	unexpected,
} from "sources/utils/util"
import {
	PROFILE_PRESETS,
	PROFILE_PRESET_ORDERED_KEYS,
} from "sources/settings/profile-presets"
import { SemVer, coerce } from "semver"
import {
	UpdatableUI,
	notice2,
	printError,
	useSettings,
	useSubsettings,
} from "sources/utils/obsidian"
import {
	dropdownSelect,
	linkSetting,
	resetButton,
	setTextToEnum,
} from "./settings"
import type { DeepWritable } from "ts-essentials"
import { PROFILE_PROPERTIES } from "sources/settings/profile-properties"
import { Pseudoterminal } from "sources/terminal/pseudoterminal"
import { Settings } from "sources/settings/data"
import type { TerminalPlugin } from "sources/main"
import { dynamicRequire } from "sources/imports"

const
	childProcess =
		dynamicRequire<typeof import("node:child_process")>("node:child_process"),
	process = dynamicRequire<typeof import("node:process")>("node:process"),
	util = dynamicRequire<typeof import("node:util")>("node:util")

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
			i18n.t("components.editable-list.name", {
				count: index + 1,
				interpolation: { escapeValue: false },
				ordinal: true,
			}))
		this.#descriptor = options?.descriptor ?? ((): string => "")
		this.#presets = options?.presets
		this.#presetPlaceholder = options?.presetPlaceholder ?? ((): string =>
			i18n.t("components.editable-list.preset-placeholder"))
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
			[listEl, listElRemover] = useSettings(this.contentEl),
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
		if (!isUndefined(title)) {
			modalUI.new(() => titleEl, ele => {
				ele.textContent = title()
			}, ele => { ele.textContent = null })
		}
		if (!isUndefined(description)) {
			ui.new(() => listEl.createEl("div"), ele => {
				ele.textContent = description()
			})
		}
		ui.newSetting(listEl, setting => {
			if (!editables.includes("prepend")) {
				setting.settingEl.remove()
				return
			}
			if (isUndefined(presets)) {
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
				return
			}
			setting
				.setName(i18n.t("components.editable-list.prepend"))
				.addDropdown(dropdownSelect(
					presetPlaceholder("prepend"),
					presets,
					async value => {
						data.unshift(value)
						this.#setupListSubUI()
						await this.postMutate()
					},
				))
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
				if (isUndefined(presets)) {
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
					return
				}
				setting
					.setName(i18n.t("components.editable-list.append"))
					.addDropdown(dropdownSelect(
						presetPlaceholder("append"),
						presets,
						async value => {
							data.push(value)
							this.#setupListSubUI()
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
export namespace ListModal {
	export const EDITABLES = deepFreeze([
		"edit",
		"append",
		"prepend",
		"remove",
		"moveUp",
		"moveDown",
	] as const)
	export interface Options<T> {
		readonly callback?: (data_: T[]) => unknown
		readonly editables?: typeof EDITABLES
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
			[listEl, listElRemover] = useSettings(this.contentEl),
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
										.t("components.profile.preset-placeholder"))
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
						{ post: button => { button.setDisabled(true) } },
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
									ListModal.stringInputter({ back: identity, forth: identity }),
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
									PLATFORM
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
												const { stdout, stderr } = await (await util)
													.promisify((await childProcess).execFile)(
														profile.pythonExecutable,
														["--version"],
														{
															env: {
																...(await process).env,
																// eslint-disable-next-line @typescript-eslint/naming-convention
																PYTHONIOENCODING: DEFAULT_PYTHONIOENCODING,
															},
															timeout: CHECK_EXECUTABLE_TIMEOUT *
																SI_PREFIX_SCALE,
															windowsHide: true,
														},
													)
												if (stdout) { console.log(stdout) }
												if (stderr) { console.error(stderr) }
												if (!stdout.contains(i18n
													.t("asset:magic.Python-version-magic"))) {
													throw new Error(i18n.t("errors.not-Python"))
												}
												notice2(
													() => i18n.t("notices.Python-version-is", {
														interpolation: { escapeValue: false },
														version: new SemVer(
															coerce(stdout, { loose: true }) ?? stdout,
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
										.type}.enable-win32-conhost-workaround-icon`),
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
			case "invalid": {
				ui.newSetting(element, setting => {
					setting
						.setName(i18n.t(`components.profile.${profile.type}.data`))
						.addTextArea(textArea => textArea
							.setValue(JSON.stringify(profile, null, JSON_STRINGIFY_SPACE))
							.setDisabled(true))
						.addExtraButton(resetButton(
							i18n.t(`asset:components.profile.${profile.type}.data-icon`),
							DISABLED_TOOLTIP,
							unexpected,
							unexpected,
							{ post: button => { button.setDisabled(true) } },
						))
				})
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
		options?: Omit<ProfileListModal.Options, "callback"
		>,
	) {
		const { i18n } = plugin.language,
			dataW = cloneAsWritable(data),
			dataKeys = new Map(dataW.map(([key, value]) => [value, key])),
			callback = options?.callback2 ?? ((): void => { }),
			keygen = options?.keygen ?? ((): string => crypto.randomUUID())
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
				async callback(data0) {
					await callback(data0
						.map(profile => {
							let id = dataKeys.get(profile)
							if (isUndefined(id)) {
								dataKeys.set(
									profile,
									id = randomNotIn(Array.from(dataKeys.values()), keygen),
								)
							}
							return [id, typedStructuredClone(profile)]
						}))
				},
				descriptor: options?.descriptor ?? ((profile): string => {
					const id = dataKeys.get(profile) ?? ""
					return i18n.t(`components.profile-list.descriptor-${Settings
						.Profile.isCompatible(profile, PLATFORM)
						? ""
						: "incompatible"}`, {
						info: Settings.Profile.info([id, profile]),
						interpolation: { escapeValue: false },
					})
				}),
				namer: options?.namer ?? ((profile): string => {
					const id = dataKeys.get(profile) ?? ""
					return i18n.t(`components.profile-list.namer-${Settings
						.Profile.isCompatible(profile, PLATFORM)
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
	export interface Options
		extends ListModal.Options<DeepWritable<Settings.Profile>> {
		readonly callback2?: (
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
		ui.finally(() => { contentEl.replaceChildren() })
			.finally(onChangeLanguage.listen(() => { ui.update() }))
		if (this.#dynamicWidth) { makeModalDynamicWidth(modalUI, modalEl) }
		if (!isUndefined(title)) {
			modalUI.new(() => titleEl, ele => {
				ele.textContent = title()
			}, ele => { ele.textContent = null })
		}
		let confirmButton: ButtonComponent | null = null,
			preconfirmed = doubleConfirmTimeout <= 0
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
					}, doubleConfirmTimeout * SI_PREFIX_SCALE)
					preconfirmed = true
					confirmButton?.setCta().buttonEl.removeClass(DOMClasses.MOD_WARNING)
				}
				consumeEvent(event)
			}), null, ele => { scope.unregister(ele) })
		if (!isUndefined(description)) {
			ui.new(() => contentEl.createEl("div"), ele => {
				ele.textContent = description()
			})
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
