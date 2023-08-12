import {
	CHECK_EXECUTABLE_WAIT,
	DEFAULT_PYTHONIOENCODING,
} from "./magic.js"
import {
	DEFAULT_TERMINAL_OPTIONS,
	PROFILE_PRESETS,
	PROFILE_PRESET_ORDERED_KEYS,
} from "./terminal/profile-presets.js"
import {
	DISABLED_TOOLTIP,
	DOMClasses,
	EditDataModal,
	ListModal,
	Platform,
	SI_PREFIX_SCALE,
	type StatusUI,
	UpdatableUI,
	activeSelf,
	anyToError,
	assignExact,
	clearProperties,
	cloneAsWritable,
	composeSetters,
	createChildElement,
	createDocumentFragment,
	dynamicRequire,
	escapeQuerySelectorAttribute,
	linkSetting,
	notice2,
	printError,
	randomNotIn,
	resetButton,
	setTextToEnum,
	setTextToNumber,
	unexpected,
	useSettings,
	useSubsettings,
} from "@polyipseity/obsidian-plugin-library"
import { Modal, type Setting } from "obsidian"
import { constant, identity, isUndefined, noop } from "lodash-es"
import { BUNDLE } from "./import.js"
import type { DeepWritable } from "ts-essentials"
import { PROFILE_PROPERTIES } from "./terminal/profile-properties.js"
import { Pseudoterminal } from "./terminal/pseudoterminal.js"
import SemVer from "semver/classes/semver.js"
import { Settings } from "./settings-data.js"
import type { TerminalPlugin } from "./main.js"
import semverCoerce from "semver/functions/coerce.js"

const
	childProcess = dynamicRequire<typeof import("node:child_process")
	>(BUNDLE, "node:child_process"),
	process = dynamicRequire<typeof import("node:process")
	>(BUNDLE, "node:process"),
	util = dynamicRequire<typeof import("node:util")
	>(BUNDLE, "node:util"),
	// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
	execFileP = (async () =>
		(await util).promisify((await childProcess).execFile))()

export class TerminalOptionsModal
	extends EditDataModal<Settings.Profile.TerminalOptions> {
	public constructor(
		context: TerminalPlugin,
		data: Settings.Profile.TerminalOptions,
		options?: TerminalOptionsModal.Options,
	) {
		const { language: { value: i18n } } = context
		super(context, data, Settings.Profile.fixTerminalOptions, {
			...options,
			elements: ["data"],
			title: () => i18n.t("components.terminal-options.title"),
		})
	}

	protected override draw(
		ui: UpdatableUI,
		element: HTMLElement,
		errorEl: StatusUI,
	): void {
		const { context: { language: { value: i18n } }, data } = this,
			temp = new WeakMap<Setting, string>()
		ui
			.new(() => createChildElement(element, "div"), ele => {
				ele.innerHTML = i18n.t("components.terminal-options.description-HTML")
			}, ele => { ele.remove() })
			.newSetting(element, setting => {
				setting
					.setName(i18n.t("components.terminal-options.font-family"))
					.addText(linkSetting(
						() => data.fontFamily ?? "",
						value => { data.fontFamily = value },
						async () => this.postMutate2(errorEl),
						{
							post(component) {
								if (isUndefined(data.fontFamily)) {
									component.setPlaceholder(i18n
										.t("components.terminal-options.undefined-placeholder"))
								}
							},
						},
					))
					.addButton(button => button
						.setIcon(i18n.t("asset:components.terminal-options.undefine-icon"))
						.setTooltip(i18n.t("components.terminal-options.undefine"))
						.onClick(async () => {
							delete data.fontFamily
							await this.postMutate2(errorEl)
						}))
					.addExtraButton(resetButton(
						i18n.t("asset:components.terminal-options.font-family-icon"),
						i18n.t("components.edit-data.reset"),
						() => {
							assignExact(
								data,
								"fontFamily",
								DEFAULT_TERMINAL_OPTIONS.fontFamily,
							)
						},
						async () => this.postMutate2(errorEl),
					))
			})
			.newSetting(element, setting => {
				setting
					.setName(i18n.t("components.terminal-options.font-size"))
					.addText(linkSetting(
						() => data.fontSize?.toString() ?? "",
						composeSetters(
							value => {
								if (value) { return false }
								delete data.fontSize
								return true
							},
							setTextToNumber(value => { data.fontSize = value }),
						),
						async () => this.postMutate2(errorEl),
						{
							post(component) {
								component.inputEl.type = "number"
								component.setPlaceholder(i18n
									.t("components.terminal-options.undefined-placeholder"))
							},
						},
					))
					.addButton(button => button
						.setIcon(i18n.t("asset:components.terminal-options.undefine-icon"))
						.setTooltip(i18n.t("components.terminal-options.undefine"))
						.onClick(async () => {
							delete data.fontSize
							await this.postMutate2(errorEl)
						}))
					.addExtraButton(resetButton(
						i18n.t("asset:components.terminal-options.font-size-icon"),
						i18n.t("components.edit-data.reset"),
						() => {
							assignExact(
								data,
								"fontSize",
								DEFAULT_TERMINAL_OPTIONS.fontSize,
							)
						},
						async () => this.postMutate2(errorEl),
					))
			})
			.newSetting(element, setting => {
				setting
					.setName(i18n.t("components.terminal-options.font-weight"))
					.setDesc(temp.has(setting)
						? createDocumentFragment(setting.settingEl.ownerDocument, frag => {
							createChildElement(frag, "span", ele => {
								ele.classList.add(DOMClasses.MOD_WARNING)
								ele.textContent = i18n
									.t("components.terminal-options.invalid-description")
							})
						})
						: "")
					.addText(linkSetting(
						() => temp.get(setting) ?? data.fontWeight?.toString() ?? "",
						composeSetters(
							() => {
								temp.delete(setting)
								return false
							},
							value => {
								if (value) { return false }
								delete data.fontWeight
								return true
							},
							setTextToNumber(value => { data.fontWeight = value }),
							setTextToEnum(
								Settings.Profile.TerminalOptions.FONT_WEIGHTS,
								value => { data.fontWeight = value },
							),
							value => {
								temp.set(setting, value)
								return true
							},
						),
						async () => this.postMutate2(errorEl),
						{
							post(component) {
								component.setPlaceholder(i18n
									.t("components.terminal-options.undefined-placeholder"))
							},
						},
					))
					.addButton(button => button
						.setIcon(i18n.t("asset:components.terminal-options.undefine-icon"))
						.setTooltip(i18n.t("components.terminal-options.undefine"))
						.onClick(async () => {
							delete data.fontWeight
							temp.delete(setting)
							await this.postMutate2(errorEl)
						}))
					.addExtraButton(resetButton(
						i18n.t("asset:components.terminal-options.font-weight-icon"),
						i18n.t("components.edit-data.reset"),
						() => {
							assignExact(
								data,
								"fontWeight",
								DEFAULT_TERMINAL_OPTIONS.fontWeight,
							)
							temp.delete(setting)
						},
						async () => this.postMutate2(errorEl),
					))
			})
			.newSetting(element, setting => {
				setting
					.setName(i18n.t("components.terminal-options.bold-font-weight"))
					.setDesc(temp.has(setting)
						? createDocumentFragment(setting.settingEl.ownerDocument, frag => {
							createChildElement(frag, "span", ele => {
								ele.classList.add(DOMClasses.MOD_WARNING)
								ele.textContent = i18n
									.t("components.terminal-options.invalid-description")
							})
						})
						: "")
					.addText(linkSetting(
						() => temp.get(setting) ?? data.fontWeightBold?.toString() ?? "",
						composeSetters(
							() => {
								temp.delete(setting)
								return false
							},
							value => {
								if (value) { return false }
								delete data.fontWeightBold
								return true
							},
							setTextToNumber(value => { data.fontWeightBold = value }),
							setTextToEnum(
								Settings.Profile.TerminalOptions.FONT_WEIGHTS,
								value => { data.fontWeightBold = value },
							),
							value => {
								temp.set(setting, value)
								return true
							},
						),
						async () => this.postMutate2(errorEl),
						{
							post(component) {
								component.setPlaceholder(i18n
									.t("components.terminal-options.undefined-placeholder"))
							},
						},
					))
					.addButton(button => button
						.setIcon(i18n.t("asset:components.terminal-options.undefine-icon"))
						.setTooltip(i18n.t("components.terminal-options.undefine"))
						.onClick(async () => {
							delete data.fontWeightBold
							temp.delete(setting)
							await this.postMutate2(errorEl)
						}))
					.addExtraButton(resetButton(
						i18n.t("asset:components.terminal-options.bold-font-weight-icon"),
						i18n.t("components.edit-data.reset"),
						() => {
							assignExact(
								data,
								"fontWeightBold",
								DEFAULT_TERMINAL_OPTIONS.fontWeightBold,
							)
							temp.delete(setting)
						},
						async () => this.postMutate2(errorEl),
					))
			})
		super.draw(ui, element, errorEl)
	}

	protected async postMutate2(errorEl: StatusUI): Promise<void> {
		errorEl.report()
		await this.postMutate()
	}
}
export namespace TerminalOptionsModal {
	type InitialOptions = EditDataModal.Options<Settings.Profile.TerminalOptions>
	export type PredefinedOptions = {
		readonly [K in never]: InitialOptions[K]
	}
	export type Options = Omit<InitialOptions, keyof PredefinedOptions>
}

export class ProfileModal extends Modal {
	protected readonly modalUI = new UpdatableUI()
	protected readonly ui = new UpdatableUI()
	protected readonly data
	readonly #callback
	readonly #presets
	#preset = NaN
	#setupTypedUI = noop

	public constructor(
		protected readonly context: TerminalPlugin,
		data: Settings.Profile,
		callback: (data_: DeepWritable<typeof data>) => unknown,
		presets: readonly {
			readonly name: string
			readonly value: Settings.Profile
		}[] = PROFILE_PRESET_ORDERED_KEYS
			.map(key => ({
				get name(): string {
					return context.language.value.t(`profile-presets.${key}`)
				},
				value: PROFILE_PRESETS[key],
			})),
	) {
		super(context.app)
		this.data = cloneAsWritable(data)
		this.#callback = callback
		this.#presets = presets
	}

	public override onOpen(): void {
		super.onOpen()
		const { context, ui, data, titleEl, modalUI } = this,
			{ element: listEl, remover: listElRemover } = useSettings(this.contentEl),
			profile = data,
			{ language } = context,
			{ value: i18n, onChangeLanguage } = language
		modalUI.finally(onChangeLanguage.listen(() => { modalUI.update() }))
			.new(constant(titleEl), ele => {
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
											.map(type => [
												type,
												i18n.t("components.profile.type-options", {
													interpolation: { escapeValue: false },
													type,
												}),
											])))
								for (const opt of Settings.Profile.TYPES
									.filter(type => !PROFILE_PROPERTIES[type].valid)
									.flatMap(type => Array.from(
										dropdown.selectEl.querySelectorAll<HTMLOptionElement>(
											`option[value="${escapeQuerySelectorAttribute(type)}"]`,
										),
									))) {
									opt.hidden = true
									opt.disabled = true
								}
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
									context,
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
			}, null, () => { this.#setupTypedUI = noop })
	}

	public override onClose(): void {
		super.onClose()
		this.modalUI.destroy()
		this.ui.destroy()
	}

	protected async postMutate(): Promise<void> {
		const { data, modalUI, ui } = this,
			cb = this.#callback(cloneAsWritable(data))
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
		const { context, context: { settings }, data } = this,
			profile = data,
			{ value: i18n } = context.language
		ui.destroy()
		if (profile.type === "invalid") { return }
		ui
			.newSetting(element, setting => {
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
			})
			.newSetting(element, setting => {
				setting
					.setName(i18n.t("components.profile.terminal-options"))
					.addButton(button => button
						.setIcon(i18n
							.t("asset:components.profile.terminal-options-edit-icon"))
						.setTooltip(i18n.t("components.profile.terminal-options-edit"))
						.onClick(() => {
							new TerminalOptionsModal(
								context,
								profile.terminalOptions,
								{
									callback: async (value): Promise<void> => {
										profile.terminalOptions = value
										await this.postMutate()
									},
								},
							).open()
						}))
					.addExtraButton(resetButton(
						i18n.t("asset:components.profile.terminal-options-icon"),
						i18n.t("components.profile.reset"),
						() => {
							profile.terminalOptions =
								cloneAsWritable(Settings.Profile.DEFAULTS[profile.type]
									.terminalOptions)
						},
						async () => this.postMutate(),
					))
			})
			.newSetting(element, setting => {
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
								context,
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
									context,
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
								const { buttonEl } = button,
									i18nVariant = checkingPython ? "ing" : ""
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
												if (stdout) {
													activeSelf(buttonEl).console.log(stdout)
												}
												if (stderr) {
													activeSelf(buttonEl).console.error(stderr)
												}
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
													settings.value.noticeTimeout,
													context,
												)
											} catch (error) {
												printError(
													anyToError(error),
													() => i18n.t("errors.error-checking-Python"),
													context,
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
}

export class ProfileListModal
	extends ListModal<DeepWritable<Settings.Profile>> {
	protected readonly dataKeys

	public constructor(
		context: TerminalPlugin,
		data: readonly Settings.Profile.Entry[],
		options?: ProfileListModal.Options,
	) {
		const { value: i18n } = context.language,
			dataW = cloneAsWritable(data),
			dataKeys = new Map(dataW.map(([key, value]) => [value, key])),
			callback = options?.callback ?? ((): void => { }),
			keygen = options?.keygen ?? ((): string => self.crypto.randomUUID())
		super(
			context,
			(setting, editable, getter, setter) => {
				setting.addButton(button => button
					.setIcon(i18n.t("asset:components.profile-list.edit-icon"))
					.setTooltip(i18n.t("components.profile-list.edit"))
					.onClick(() => {
						new ProfileModal(
							context,
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
								return [id, cloneAsWritable(profile)]
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
							return context.language.value.t(`profile-presets.${key}`)
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
