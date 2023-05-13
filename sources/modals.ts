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
