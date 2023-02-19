import { DialogModal, ProfileModal } from "sources/ui/modals"
import { Direction, type Params } from "../ui/find"
import {
	DisposerAddon,
	RendererAddon,
	XtermTerminalEmulator,
} from "./emulator"
import { type Fixed, fixTyped, markFixed } from "sources/ui/fixers"
import {
	ItemView,
	type Menu,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian"
import {
	JSON_STRINGIFY_SPACE,
	TERMINAL_EXIT_SUCCESS,
	TERMINAL_SEARCH_RESULTS_LIMIT,
	UNDEFINED,
} from "../magic"
import {
	PLATFORM,
	anyToError,
	basename,
	cloneAsWritable,
	copyOnWrite,
	deepFreeze,
	extname,
	inSet,
	isUndefined,
	logWarn,
	onResize,
	onVisible,
	openExternal,
	randomNotIn,
	saveFile,
	typedStructuredClone,
} from "../utils/util"
import { PROFILE_PROPERTIES, openProfile } from "../settings/profile-properties"
import {
	UnnamespacedID,
	newCollabrativeState,
	notice2,
	printError,
	printMalformedData,
	readStateCollabratively,
	updateDisplayText,
	useSettings,
	writeStateCollabratively,
} from "sources/utils/obsidian"
import { linkSetting, resetButton } from "sources/ui/settings"
import { CanvasAddon } from "xterm-addon-canvas"
import type { DeepWritable } from "ts-essentials"
import FindComponent from "../ui/find.svelte"
import { LigaturesAddon } from "xterm-addon-ligatures"
import { SearchAddon } from "xterm-addon-search"
import { Settings } from "sources/settings/data"
import type { TerminalPlugin } from "../main"
import { TextPseudoterminal } from "./pseudoterminal"
import { Unicode11Addon } from "xterm-addon-unicode11"
import { WebLinksAddon } from "xterm-addon-web-links"
import { WebglAddon } from "xterm-addon-webgl"
import { launderUnchecked } from "sources/utils/types"

class EditTerminalModal extends DialogModal {
	protected readonly state
	#profile: string | null = null
	readonly #confirm

	public constructor(
		plugin: TerminalPlugin,
		protected readonly protostate: TerminalView.State,
		confirm: (state_: DeepWritable<typeof protostate>) => unknown,
	) {
		const { i18n } = plugin.language
		super(plugin, {
			dynamicWidth: true,
			title: () => i18n.t("components.terminal.edit-modal.title"),
		})
		this.state = cloneAsWritable(protostate)
		this.#confirm = confirm
	}

	public override onOpen(): void {
		super.onOpen()
		const { plugin, ui, protostate, state } = this,
			[listEl, listElRemover] = useSettings(this.contentEl),
			{ language } = plugin,
			{ i18n } = language
		ui.finally(listElRemover)
			.finally(language.onChangeLanguage.listen(() => { ui.update() }))
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.terminal.edit-modal.working-directory"))
					.addText(linkSetting(
						() => state.cwd ?? "",
						value => { state.cwd = value === "" ? null : value },
						() => { this.postMutate() },
						{
							post: component => {
								component
									.setPlaceholder(i18n
										// eslint-disable-next-line max-len
										.t("components.terminal.edit-modal.working-directory-placeholder"))
							},
						},
					))
					.addExtraButton(resetButton(
						i18n
							.t("asset:components.terminal.edit-modal.working-directory-icon"),
						i18n.t("components.terminal.edit-modal.reset"),
						() => { state.cwd = protostate.cwd },
						() => { this.postMutate() },
					))
			})
			.newSetting(listEl, setting => {
				const { profiles } = plugin.settings,
					unselected = randomNotIn(Object.keys(profiles))
				setting
					.setName(i18n.t("components.terminal.edit-modal.profile"))
					.addDropdown(linkSetting(
						() => this.#profile ?? unselected,
						value => {
							const profile0 = profiles[value]
							if (isUndefined(profile0)) {
								this.#profile = null
								return
							}
							this.#profile = value
							this.state.profile = cloneAsWritable(profile0)
						},
						() => { this.postMutate() },
						{
							pre: component => {
								component
									.addOption(unselected, i18n
										.t("components.terminal.edit-modal.profile-placeholder"))
									.addOptions(Object
										.fromEntries(Object
											.entries(profiles)
											.map(entry => [
												entry[0],
												// eslint-disable-next-line max-len
												i18n.t(`components.terminal.edit-modal.profile-name-${Settings
													.Profile.isCompatible(entry[1], PLATFORM)
													? ""
													: "incompatible"}`, {
													info: Settings.Profile.info(entry),
													interpolation: { escapeValue: false },
												}),
											])))
							},
						},
					))
					.addButton(button => button
						.setIcon(i18n
							.t("asset:components.terminal.edit-modal.profile-edit-icon"))
						.setTooltip(i18n.t("components.terminal.edit-modal.profile-edit"))
						.onClick(() => {
							new ProfileModal(
								plugin,
								state.profile,
								profile0 => {
									this.#profile = null
									state.profile = profile0
									this.postMutate()
								},
							).open()
						}))
					.addExtraButton(resetButton(
						i18n.t("asset:components.terminal.edit-modal.profile-icon"),
						i18n.t("components.terminal.edit-modal.reset"),
						() => {
							this.#profile = null
							state.profile = cloneAsWritable(protostate.profile)
						},
						() => { this.postMutate() },
					))
			})
	}

	protected override async confirm(close: () => void): Promise<void> {
		await this.#confirm(typedStructuredClone(this.state))
		await super.confirm(close)
	}

	protected postMutate(): void {
		const { modalUI, ui } = this
		modalUI.update()
		ui.update()
	}
}

export class TerminalView extends ItemView {
	public static readonly type = new UnnamespacedID("terminal")
	public static readonly divClass = TerminalView.type
	static #namespacedType: string
	#emulator0: TerminalView.EMULATOR | null = null
	#find0: FindComponent | null = null
	#focus0 = false
	#state = TerminalView.State.DEFAULT

	public constructor(
		protected readonly plugin: TerminalPlugin,
		leaf: WorkspaceLeaf,
	) {
		TerminalView.#namespacedType = TerminalView.type.namespaced(plugin)
		super(leaf)
		this.navigation = true
	}

	protected get state(): TerminalView.State {
		return this.#state
	}

	get #emulator(): TerminalView.EMULATOR | null {
		return this.#emulator0
	}

	get #find(): FindComponent | null {
		return this.#find0
	}

	get #focus(): boolean {
		return this.#focus0
	}

	get #name(): string {
		const { plugin, state } = this,
			{ i18n } = plugin.language,
			{ profile } = state,
			{ name, type } = profile
		if (typeof name === "string" && name) { return name }
		if ("executable" in profile) {
			const { executable } = profile
			if (typeof executable === "string") {
				return basename(executable, extname(executable))
			}
		}
		return i18n.t("components.terminal.name.profile-type", {
			interpolation: { escapeValue: false },
			type,
		})
	}

	// eslint-disable-next-line consistent-return
	get #hidesStatusBar(): boolean {
		switch (this.plugin.settings.hideStatusBar) {
			case "focused":
				return this.#focus
			case "running":
				return true
			case "always":
			case "never":
				return false
			// No default
		}
	}

	protected set state(value: TerminalView.State) {
		this.#state = value
		updateDisplayText(this.plugin, this)
	}

	set #emulator(val: TerminalView.EMULATOR | null) {
		const { plugin } = this
		this.#emulator0?.close().catch(error => {
			printError(
				anyToError(error),
				() => plugin.language
					.i18n.t("errors.error-killing-pseudoterminal"),
				plugin,
			)
		})
		this.#emulator0 = val
		if (val === null) { return }
		const { terminal } = val
		if (this.#focus) { terminal.focus() } else { terminal.blur() }
	}

	set #find(val: FindComponent | null) {
		this.#find?.$destroy()
		this.#find0 = val
	}

	set #focus(val: boolean) {
		const term = this.#emulator?.terminal
		if (val) { term?.focus() } else { term?.blur() }
		this.#focus0 = val
	}

	public override async setState(
		state: unknown,
		result: ViewStateResult,
	): Promise<void> {
		await super.setState(state, result)
		const { plugin } = this,
			ownState = readStateCollabratively(
				TerminalView.type.namespaced(plugin),
				state,
			),
			{ value, valid } = TerminalView.State.fix(ownState)
		if (!valid) { printMalformedData(plugin, ownState, value) }
		this.state = value
		this.startEmulator()
	}

	public override getState(): unknown {
		const serial = this.#emulator?.serialize()
		if (!isUndefined(serial)) {
			this.state = copyOnWrite(this.state, state => { state.serial = serial })
		}
		return writeStateCollabratively(
			super.getState(),
			TerminalView.type.namespaced(this.plugin),
			this.state,
		)
	}

	public getDisplayText(): string {
		return this.plugin.language
			.i18n.t(
				`components.${TerminalView.type.id}.display-name`,
				{
					interpolation: { escapeValue: false },
					name: this.#name,
				},
			)
	}

	public override getIcon(): string {
		return this.plugin.language
			.i18n.t(`asset:components.${TerminalView.type.id}.icon`)
	}

	public getViewType(): string {
		// Workaround: super() calls this method
		return TerminalView.#namespacedType
	}

	public override onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source)
		const { plugin, contentEl, leaf } = this,
			{ i18n } = plugin.language
		menu
			.addSeparator()
			.addItem(item => item
				.setTitle(i18n.t("components.terminal.menus.find"))
				.setIcon(i18n.t("asset:components.terminal.menus.find-icon"))
				.setDisabled(this.#find !== null)
				.onClick(() => {
					const
						find = (
							direction: Direction,
							params: Params,
							incremental = false,
						): void => {
							const finder = this.#emulator?.addons.search
							if (isUndefined(finder)) { return }
							const func = direction === Direction.next
								? finder.findNext.bind(finder)
								: finder.findPrevious.bind(finder)
							func(
								params.findText,
								{
									caseSensitive: params.caseSensitive,
									decorations: {
										activeMatchColorOverviewRuler: "#00000000",
										matchOverviewRuler: "#00000000",
									},
									incremental,
									regex: params.regex,
									wholeWord: params.wholeWord,
								},
							)
							if (params.findText === "") {
								this.#find?.$set({ searchResult: "" })
							}
						},
						optional: { anchor?: Element } = {},
						{ firstElementChild } = contentEl
					if (firstElementChild !== null) {
						optional.anchor = firstElementChild
					}
					this.#find = new FindComponent({
						intro: true,
						props: {
							i18n: i18n.t,
							onClose: (): void => { this.#find = null },
							onFind: find,
							onParamsChanged: (params: Params): void => {
								this.#emulator?.addons.search.clearDecorations()
								find(Direction.previous, params)
							},
						},
						target: contentEl,
						...optional,
					})
				}))
			.addItem(item => item
				.setTitle(i18n.t("components.terminal.menus.restart"))
				.setIcon(i18n.t("asset:components.terminal.menus.restart-icon"))
				.onClick(() => { this.startEmulator() }))
			.addItem(item => item
				.setTitle(i18n.t("components.terminal.menus.edit"))
				.setIcon(i18n.t("asset:components.terminal.menus.edit-icon"))
				.onClick(() => {
					new EditTerminalModal(
						plugin,
						this.state,
						async state => leaf.setViewState({
							state: newCollabrativeState(plugin, new Map([
								[
									TerminalView.type,
									state satisfies TerminalView.State,
								],
							])),
							type: this.getViewType(),
						}),
					).open()
				}))
			.addItem(item => item
				.setTitle(i18n.t("components.terminal.menus.save-as-HTML"))
				.setIcon(i18n.t("asset:components.terminal.menus.save-as-HTML-icon"))
				.setDisabled(isUndefined(this.#emulator?.addons.serialize))
				.onClick(() => {
					const ser = this.#emulator?.addons.serialize
					if (isUndefined(ser)) { return }
					saveFile(
						ser.serializeAsHTML({
							includeGlobalBackground: false,
							onlySelection: false,
						}),
						"text/html; charset=UTF-8;",
						`${this.#name}.html`,
					)
				}))
	}

	protected override async onOpen(): Promise<void> {
		await super.onOpen()
		const { plugin } = this,
			{ app, language, statusBarHider } = plugin,
			{ workspace } = app

		this.register(language.onChangeLanguage.listen(() => {
			updateDisplayText(plugin, this)
		}))

		this.#focus = workspace.getActiveViewOfType(TerminalView) === this
		this.registerEvent(app.workspace.on("active-leaf-change", leaf => {
			if (leaf === this.leaf) {
				this.#focus = true
				return
			}
			this.#focus = false
		}))

		this.register(statusBarHider.hide(() => this.#hidesStatusBar))
		this.registerEvent(workspace.on(
			"active-leaf-change",
			() => { statusBarHider.update() },
		))

		this.register(() => { this.#emulator = null })
	}

	protected startEmulator(): void {
		const { contentEl, plugin, leaf, state } = this,
			{ profile, cwd, serial } = state,
			{ app, language } = plugin,
			{ i18n } = language,
			{ requestSaveLayout } = app.workspace,
			noticeSpawn = (): void => {
				notice2(
					() => i18n.t(
						"notices.spawning-terminal",
						{
							interpolation: { escapeValue: false },
							name: this.#name,
						},
					),
					plugin.settings.noticeTimeout,
					plugin,
				)
			}
		if (!PROFILE_PROPERTIES[profile.type].integratable) {
			(async (): Promise<void> => {
				try {
					noticeSpawn()
					await openProfile(plugin, profile, cwd ?? UNDEFINED)
				} catch (error) {
					printError(anyToError(error), () =>
						i18n.t("errors.error-spawning-terminal"), plugin)
				}
			})()
			leaf.detach()
			return
		}
		contentEl.createEl("div", {
			cls: TerminalView.divClass.namespaced(plugin),
		}, ele => {
			const obsr = onVisible(ele, () => {
				try {
					noticeSpawn()
					const
						emulator = new TerminalView.EMULATOR(
							plugin,
							ele,
							async terminal => {
								if (serial !== null) {
									terminal.write(`${i18n.t(
										"components.terminal.restored-history",
										{
											datetime: new Date(),
											interpolation: { escapeValue: false },
										},
									)}`)
								}
								const ret = await openProfile(plugin, profile, cwd ?? UNDEFINED)
								if (ret === null) {
									const pty = new TextPseudoterminal(i18n
										.t("components.terminal.unsupported-profile", {
											interpolation: { escapeValue: false },
											profile: JSON.stringify(
												profile,
												null,
												JSON_STRINGIFY_SPACE,
											),
										}))
									pty.onExit.finally(language.onChangeLanguage.listen(() => {
										pty.text =
											i18n.t("components.terminal.unsupported-profile", {
												interpolation: { escapeValue: false },
												profile: JSON.stringify(
													profile,
													null,
													JSON_STRINGIFY_SPACE,
												),
											})
									}))
									return pty
								}
								return ret
							},
							serial ?? UNDEFINED,
							{
								allowProposedApi: true,
							},
							{
								disposer: new DisposerAddon(
									() => { ele.remove() },
									() => { this.#find?.$set({ searchResult: "" }) },
								),
								ligatures: new LigaturesAddon({}),
								renderer: new RendererAddon(
									() => new CanvasAddon(),
									() => new WebglAddon(false),
								),
								search: new SearchAddon(),
								unicode11: new Unicode11Addon(),
								webLinks: new WebLinksAddon((_0, uri) => openExternal(uri), {}),
							},
						),
						{ pseudoterminal, terminal, addons } = emulator,
						{ disposer, renderer, search } = addons
					pseudoterminal.then(async pty0 => pty0.onExit)
						.then(code => {
							notice2(
								() => i18n.t("notices.terminal-exited", {
									code,
									interpolation: { escapeValue: false },
								}),
								inSet(TERMINAL_EXIT_SUCCESS, code)
									? plugin.settings.noticeTimeout
									: plugin.settings.errorNoticeTimeout,
								plugin,
							)
						}, error => {
							printError(anyToError(error), () =>
								i18n.t("errors.error-spawning-terminal"), plugin)
						})
					terminal.onWriteParsed(requestSaveLayout)
					terminal.onResize(requestSaveLayout)
					terminal.unicode.activeVersion = "11"
					disposer.push(plugin.on(
						"mutate-settings",
						settings0 => settings0.preferredRenderer,
						cur => { renderer.use(cur) },
					))
					renderer.use(plugin.settings.preferredRenderer)
					search.onDidChangeResults(results => {
						if (isUndefined(results)) {
							this.#find?.$set({
								searchResult: i18n
									.t("components.find.too-many-search-results", {
										interpolation: { escapeValue: false },
										limit: TERMINAL_SEARCH_RESULTS_LIMIT,
									}),
							})
							return
						}
						const { resultIndex, resultCount } = results
						this.#find?.$set({
							searchResult: i18n.t("components.find.search-results", {
								interpolation: { escapeValue: false },
								replace: {
									count: resultCount,
									index: resultIndex + 1,
								},
							}),
						})
					})
					emulator.resize().catch(logWarn)
					onResize(ele, ent => {
						if (ent.contentBoxSize
							.some(size => size.blockSize <= 0 || size.inlineSize <= 0)) {
							return
						}
						emulator.resize(false).catch(logWarn)
					})
					this.#emulator = emulator
				} finally {
					obsr.disconnect()
				}
			})
		})
	}
}
export namespace TerminalView {
	export const EMULATOR = XtermTerminalEmulator<Addons>
	export type EMULATOR = XtermTerminalEmulator<Addons>
	export interface Addons {
		readonly disposer: DisposerAddon
		readonly ligatures: LigaturesAddon
		readonly renderer: RendererAddon
		readonly search: SearchAddon
		readonly unicode11: Unicode11Addon
		readonly webLinks: WebLinksAddon
	}
	export interface State {
		readonly profile: Settings.Profile
		readonly cwd: string | null
		readonly serial: XtermTerminalEmulator.State | null
	}
	export namespace State {
		export const DEFAULT: State = deepFreeze({
			cwd: null,
			profile: Settings.Profile.DEFAULTS.invalid,
			serial: null,
		} as const)
		export function fix(self: unknown): Fixed<State> {
			const unc = launderUnchecked<State>(self)
			return markFixed(self, {
				cwd: fixTyped(DEFAULT, unc, "cwd", ["string", "null"]),
				profile: Settings.Profile.fix(unc.profile).value,
				serial: unc.serial === null
					? null
					: XtermTerminalEmulator.State.fix(unc.serial).value,
			})
		}
	}
}
