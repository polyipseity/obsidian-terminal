import { DialogModal, ProfileModal } from "sources/ui/modals"
import { Direction, type Params } from "../ui/find"
import {
	DisposerAddon,
	RendererAddon,
	XtermTerminalEmulator,
} from "./emulator"
import {
	ItemView,
	type Menu,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian"
import { JSON_STRINGIFY_SPACE, TERMINAL_EXIT_SUCCESS } from "../magic"
import { PROFILE_PROPERTIES, openProfile } from "../settings/profile-properties"
import {
	UnnamespacedID,
	UpdatableUI,
	notice2,
	printError,
	updateDisplayText,
	useSettings,
} from "sources/utils/obsidian"
import {
	anyToError,
	basename,
	cloneAsWritable,
	copyOnWrite,
	extname,
	inSet,
	isInterface,
	isUndefined,
	onResize,
	onVisible,
	openExternal,
	randomNotIn,
	saveFile,
	typedStructuredClone,
} from "../utils/util"
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

export class TerminalEditModal extends DialogModal {
	protected readonly ui = new UpdatableUI()
	readonly #protostate
	readonly #state
	#profile: string | null = null
	readonly #confirm

	public constructor(
		plugin: TerminalPlugin,
		state: TerminalView.State,
		confirm: (state_: DeepWritable<typeof state>) => unknown,
	) {
		super(plugin)
		this.#protostate = state
		this.#state = cloneAsWritable(state)
		this.#confirm = confirm
	}

	public override onOpen(): void {
		super.onOpen()
		const { plugin, ui } = this,
			[listEl, listElRemover] = useSettings(this.contentEl),
			protostate = this.#protostate,
			state = this.#state,
			{ language } = plugin,
			{ profiles } = plugin.settings,
			{ i18n } = language,
			noProfile = randomNotIn(Object.keys(profiles))
		ui.finally(listElRemover)
			.new(() => listEl.createEl("h1"), ele => {
				ele.textContent = i18n.t("generic.edit")
			})
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.terminal.working-directory"))
					.addText(linkSetting(
						() => state.cwd ?? "",
						value => {
							// eslint-disable-next-line no-void
							state.cwd = value === "" ? void 0 : value
						},
						() => { this.#postMutate() },
						{
							post: component => {
								component
									.setPlaceholder(i18n
										.t("components.terminal.working-directory-placeholder"))
							},
						},
					))
					.addExtraButton(resetButton(
						plugin,
						i18n.t("asset:components.terminal.working-directory-icon"),
						() => { state.cwd = protostate.cwd },
						() => { this.#postMutate(true) },
					))
			})
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.terminal.profile"))
					.addDropdown(linkSetting(
						() => this.#profile ?? noProfile,
						value => {
							const profile0 = profiles[value]
							if (isUndefined(profile0)) {
								this.#profile = null
								return
							}
							this.#profile = value
							this.#state.profile = cloneAsWritable(profile0)
						},
						() => { this.#postMutate(true) },
						{
							pre: component => {
								component
									.addOption(noProfile, i18n
										.t("components.dropdown.unselected"))
									.addOptions(Object
										.fromEntries(Object
											.entries(profiles)
											.map(entry => [
												entry[0],
												Settings.Profile.nameOrID(entry),
											])))
							},
						},
					))
					.addButton(button => button
						.setIcon(i18n.t("asset:generic.edit-icon"))
						.setTooltip(i18n.t("generic.edit"))
						.onClick(() => {
							new ProfileModal(
								plugin,
								state.profile,
								profile0 => {
									this.#profile = null
									state.profile = profile0
									this.#postMutate(true)
								},
							).open()
						}))
					.addExtraButton(resetButton(
						plugin,
						i18n.t("asset:components.terminal.profile-icon"),
						() => {
							this.#profile = null
							state.profile = cloneAsWritable(protostate.profile)
						},
						() => { this.#postMutate(true) },
					))
			})
			.finally(language.onChangeLanguage.listen(() => { ui.update() }))
	}

	public override onClose(): void {
		super.onClose()
		this.ui.clear()
	}

	protected override async confirm(close: () => void): Promise<void> {
		await this.#confirm(typedStructuredClone(this.#state))
		await super.confirm(close)
	}

	#postMutate(redraw = false): void {
		if (redraw) { this.ui.update() }
	}
}

export class TerminalView extends ItemView {
	public static readonly type = new UnnamespacedID("terminal")
	public static readonly divClass = TerminalView.type
	public static namespacedViewType: string
	#emulator0: TerminalView.EMULATOR | null = null
	#find0: FindComponent | null = null
	#focus0 = false
	#state0: TerminalView.State = {
		__type: TerminalView.State.TYPE,
		profile: Settings.Profile.DEFAULTS.invalid,
	}

	public constructor(
		protected readonly plugin: TerminalPlugin,
		leaf: WorkspaceLeaf,
	) {
		super(leaf)
	}

	get #state(): TerminalView.State {
		return this.#state0
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
		const { profile } = this.#state
		if ("executable" in profile) {
			const { executable } = profile
			if (typeof executable === "string") {
				return basename(executable, extname(executable))
			}
		}
		if ("name" in profile) {
			const { name } = profile
			if (typeof name === "string") { return name }
		}
		return this.plugin.language.i18n
			.t("components.terminal.unknown-profile-name")
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

	set #state(value: TerminalView.State) {
		this.#state0 = value
		updateDisplayText(this)
	}

	set #emulator(val: TerminalView.EMULATOR | null) {
		const { plugin } = this
		this.#emulator0?.close().catch(error => {
			printError(
				anyToError(error),
				() => plugin.language
					.i18n.t("errors.failed-to-kill-pseudoterminal"),
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
		if (isInterface<TerminalView.State>(TerminalView.State.TYPE, state)) {
			this.#state = typedStructuredClone(state)
			this.#startEmulator()
		}
	}

	public override getState(): unknown {
		const serial = this.#emulator?.serialize()
		if (typeof serial !== "undefined") {
			this.#state = copyOnWrite(this.#state, state => { state.serial = serial })
		}
		return Object.assign(super.getState(), this.#state)
	}

	public getDisplayText(): string {
		return this.plugin.language
			.i18n.t(
				`components.${TerminalView.type.id}.display-name`,
				{ name: this.#name },
			)
	}

	public override getIcon(): string {
		return this.plugin.language
			.i18n.t(`asset:components.${TerminalView.type.id}.icon`)
	}

	public getViewType(): string {
		// Workaround: super() calls this method
		return TerminalView.namespacedViewType
	}

	public override onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source)
		const { plugin, contentEl } = this,
			{ i18n } = plugin.language
		menu
			.addSeparator()
			.addItem(item => item
				.setTitle(i18n.t("menus.terminal.find"))
				.setIcon(i18n.t("asset:menus.terminal.find-icon"))
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
				.setTitle(i18n.t("menus.terminal.restart"))
				.setIcon(i18n.t("asset:menus.terminal.restart-icon"))
				.onClick(() => { this.#startEmulator() }))
			.addItem(item => item
				.setTitle(i18n.t("generic.edit"))
				.setIcon(i18n.t("asset:generic.edit-icon"))
				.onClick(() => {
					new TerminalEditModal(
						plugin,
						this.#state,
						state => {
							this.#state = state
							this.#startEmulator()
						},
					).open()
				}))
			.addItem(item => item
				.setTitle(i18n.t("menus.terminal.save-as-HTML"))
				.setIcon(i18n.t("asset:menus.terminal.save-as-HTML-icon"))
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
			updateDisplayText(this)
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

	#startEmulator(): void {
		const { contentEl, plugin, leaf } = this,
			state = this.#state,
			{ profile, cwd, serial } = state,
			{ app, language } = plugin,
			{ i18n } = language,
			{ requestSaveLayout } = app.workspace,
			noticeSpawn = (): void => {
				notice2(
					() => i18n.t(
						"notices.spawning-terminal",
						{ name: this.#name },
					),
					plugin.settings.noticeTimeout,
					plugin,
				)
			}
		if (!PROFILE_PROPERTIES[profile.type].integratable) {
			(async (): Promise<void> => {
				try {
					noticeSpawn()
					await openProfile(plugin, profile, cwd)
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
								if (typeof serial !== "undefined") {
									terminal.write(`${i18n.t(
										"components.terminal.restored-history",
										{ time: new Date().toLocaleString(language.language) },
									)}`)
								}
								const ret = await openProfile(plugin, profile, cwd)
								if (ret === null) {
									const pty = new TextPseudoterminal(i18n
										.t("components.terminal.unsupported-profile", {
											profile: JSON.stringify(
												profile,
												null,
												JSON_STRINGIFY_SPACE,
											),
										}))
									pty.onExit.finally(language.onChangeLanguage.listen(() => {
										pty.text =
											i18n.t("components.terminal.unsupported-profile", {
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
							serial,
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
								() => i18n.t("notices.terminal-exited", { code }),
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
								searchResult: i18n.t("components.find.too-many-search-results"),
							})
							return
						}
						const { resultIndex, resultCount } = results
						this.#find?.$set({
							searchResult: i18n.t("components.find.search-results", {
								replace: {
									count: resultCount,
									index: resultIndex + 1,
								},
							}),
						})
					})
					emulator.resize().catch(error => { console.warn(error) })
					onResize(ele, ent => {
						if (ent.contentBoxSize
							.some(size => size.blockSize <= 0 || size.inlineSize <= 0)) {
							return
						}
						emulator.resize(false).catch(error => { console.warn(error) })
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
		readonly __type: typeof State.TYPE
		readonly profile: Settings.Profile
		readonly cwd?: string | undefined
		readonly serial?: XtermTerminalEmulator.State
	}
	export namespace State {
		export const TYPE = "8d54e44a-32e7-4297-8ae2-cff88e92ce28"
	}
}

