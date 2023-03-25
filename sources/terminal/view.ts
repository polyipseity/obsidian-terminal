import { DialogModal, ProfileModal } from "sources/ui/modals"
import { Direction, type Params } from "../ui/find"
import {
	DisposerAddon,
	DragAndDropAddon,
	RendererAddon,
} from "./emulator-addons"
import { type Fixed, fixTyped, markFixed } from "sources/ui/fixers"
import {
	ItemView,
	type Menu,
	Scope,
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
	consumeEvent,
	copyOnWrite,
	createChildElement,
	deepFreeze,
	destroyWithOutro,
	extname,
	inSet,
	instanceOf,
	logWarn,
	onResize,
	onVisible,
	randomNotIn,
	typedStructuredClone,
} from "../utils/util"
import { PROFILE_PROPERTIES, openProfile } from "../settings/profile-properties"
import {
	UnnamespacedID,
	newCollabrativeState,
	notice2,
	openExternal,
	printError,
	printMalformedData,
	readStateCollabratively,
	saveFile,
	updateDisplayText,
	usePrivateAPI,
	useSettings,
	writeStateCollabratively,
} from "sources/utils/obsidian"
import { linkSetting, resetButton } from "sources/ui/settings"
import type { DeepWritable } from "ts-essentials"
import FindComponent from "../ui/find.svelte"
import type { LigaturesAddon } from "xterm-addon-ligatures"
import type { SearchAddon } from "xterm-addon-search"
import { Settings } from "sources/settings/data"
import type { TerminalPlugin } from "../main"
import { TextPseudoterminal } from "./pseudoterminal"
import type { Unicode11Addon } from "xterm-addon-unicode11"
import type { WebLinksAddon } from "xterm-addon-web-links"
import { XtermTerminalEmulator } from "./emulator"
import { dynamicRequireLazy } from "sources/imports"
import { launderUnchecked } from "sources/utils/types"
import { writePromise } from "./util"

const
	xtermAddonCanvas = dynamicRequireLazy<typeof import("xterm-addon-canvas")>(
		"xterm-addon-canvas"),
	xtermAddonLigatures =
		dynamicRequireLazy<typeof import("xterm-addon-ligatures")>(
			"xterm-addon-ligatures"),
	xtermAddonSearch = dynamicRequireLazy<typeof import("xterm-addon-search")>(
		"xterm-addon-search"),
	xtermAddonUnicode11 =
		dynamicRequireLazy<typeof import("xterm-addon-unicode11")>(
			"xterm-addon-unicode11"),
	xtermAddonWebLinks =
		dynamicRequireLazy<typeof import("xterm-addon-web-links")>(
			"xterm-addon-web-links"),
	xtermAddonWebgl = dynamicRequireLazy<typeof import("xterm-addon-webgl")>(
		"xterm-addon-webgl")

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
			{ element: listEl, remover: listElRemover } = useSettings(this.contentEl),
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
							if (!profile0) {
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
	protected static readonly modifiers = deepFreeze(PLATFORM === "darwin"
		? ["Meta"] as const
		: ["Ctrl", "Shift"] as const)

	static #namespacedType: string
	protected readonly scope = new Scope(this.app.scope)
	protected readonly focusedScope = new Scope()
	#title0 = ""
	#emulator0: TerminalView.EMULATOR | null = null
	#find0: FindComponent | null = null
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

	get #title(): string {
		return this.#title0
	}

	get #name(): string {
		const { plugin, state } = this,
			{ i18n } = plugin.language,
			{ profile } = state,
			{ name, type } = profile
		if (this.#title) { return this.#title }
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
		const { plugin, contentEl } = this
		switch (plugin.settings.hideStatusBar) {
			case "focused":
				return contentEl.contains(contentEl.ownerDocument.activeElement)
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
		this.#emulator0?.close(false).catch(error => {
			printError(
				anyToError(error),
				() => plugin.language
					.i18n.t("errors.error-killing-pseudoterminal"),
				plugin,
			)
		})
		this.#emulator0 = val
	}

	set #find(val: FindComponent | null) {
		if (this.#find) { destroyWithOutro(this.#find) }
		this.#find0 = val
	}

	set #title(value: string) {
		this.#title0 = value
		updateDisplayText(this.plugin, this)
	}

	public override async setState(
		state: unknown,
		result: ViewStateResult,
	): Promise<void> {
		const { plugin } = this,
			ownState = readStateCollabratively(
				TerminalView.type.namespaced(plugin),
				state,
			),
			{ value, valid } = TerminalView.State.fix(ownState)
		if (!valid) { printMalformedData(plugin, ownState, value) }
		await super.setState(state, result)
		this.state = value
		this.startEmulator()
		usePrivateAPI(plugin, () => { result.history = true }, () => { })
	}

	public override getState(): unknown {
		const serial = this.#emulator?.serialize()
		if (serial) {
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
		const { plugin, leaf, containerEl } = this,
			{ i18n } = plugin.language
		menu
			.addSeparator()
			.addItem(item => item
				.setTitle(i18n.t("components.terminal.menus.find"))
				.setIcon(i18n.t("asset:components.terminal.menus.find-icon"))
				.setDisabled(this.#find !== null)
				.onClick(() => { this.startFind() }))
			.addItem(item => item
				.setTitle(i18n.t("components.terminal.menus.clear"))
				.setIcon(i18n.t("asset:components.terminal.menus.clear-icon"))
				.onClick(() => { this.#emulator?.terminal.clear() }))
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
				.setDisabled(!this.#emulator?.addons.serialize)
				.onClick(() => {
					const ser = this.#emulator?.addons.serialize
					if (!ser) { return }
					saveFile(
						containerEl.ownerDocument,
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
		const { plugin, focusedScope, contentEl, containerEl, scope, app } = this,
			{ language, statusBarHider } = plugin,
			{ i18n } = language,
			{ keymap } = app

		this.register(language.onChangeLanguage.listen(() => {
			updateDisplayText(plugin, this)
			this.#find?.$set({ i18n: i18n.t })
		}))

		this.register(() => { keymap.popScope(scope) })
		this.registerDomEvent(containerEl, "focusout", () => {
			keymap.popScope(scope)
		}, { passive: true })
		this.registerDomEvent(containerEl, "focusin", () => {
			keymap.pushScope(scope)
		}, { capture: true, passive: true })
		if (containerEl.contains(containerEl.ownerDocument.activeElement)) {
			keymap.pushScope(scope)
		}

		this.register(() => { keymap.popScope(focusedScope) })
		this.registerDomEvent(contentEl, "focusout", () => {
			keymap.popScope(focusedScope)
			statusBarHider.update()
		}, { passive: true })
		this.registerDomEvent(contentEl, "focusin", () => {
			keymap.pushScope(focusedScope)
			statusBarHider.update()
		}, { capture: true, passive: true })
		if (contentEl.contains(contentEl.ownerDocument.activeElement)) {
			keymap.pushScope(focusedScope)
		}

		this.registerScopeEvent(scope.register(
			cloneAsWritable(TerminalView.modifiers),
			"`",
			event => {
				this.#emulator?.terminal.focus()
				consumeEvent(event)
			},
		))
		this.registerScopeEvent(focusedScope.register(
			cloneAsWritable(TerminalView.modifiers),
			"`",
			event => {
				const { activeElement } = contentEl.ownerDocument
				if (instanceOf(activeElement, HTMLElement) ||
					instanceOf(activeElement, SVGElement)) {
					activeElement.blur()
				}
				consumeEvent(event)
			},
		))
		this.registerScopeEvent(focusedScope.register(
			cloneAsWritable(TerminalView.modifiers),
			"f",
			event => {
				this.startFind()
				consumeEvent(event)
			},
		))
		this.registerScopeEvent(focusedScope.register(
			cloneAsWritable(TerminalView.modifiers),
			"k",
			event => {
				this.#emulator?.terminal.clear()
				consumeEvent(event)
			},
		))

		this.register(statusBarHider.hide(() => this.#hidesStatusBar))
		this.register(() => { this.#emulator = null })
	}

	protected startFind(): void {
		const { plugin, contentEl } = this,
			{ language } = plugin,
			{ i18n } = language
		if (!this.#find) {
			const
				onFind = (
					direction: Direction,
					params: Params,
					incremental = false,
				): void => {
					const finder = this.#emulator?.addons.search
					if (!finder) { return }
					const func = direction === Direction.next
						? finder.findNext.bind(finder)
						: finder.findPrevious.bind(finder)
					let empty = params.findText === ""
					try {
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
					} catch (error) {
						console.debug(error)
						empty = true
					}
					if (empty) { this.#find?.$set({ results: "" }) }
				},
				optional: { anchor?: Element } = {},
				{ firstElementChild } = contentEl
			if (firstElementChild) {
				optional.anchor = firstElementChild
			}
			this.#find = new FindComponent({
				intro: true,
				props: {
					i18n: i18n.t,
					onClose: (): void => { this.#find = null },
					onFind,
					onParamsChanged: (params: Params): void => {
						this.#emulator?.addons.search.clearDecorations()
						onFind(Direction.previous, params)
					},
				},
				target: contentEl,
				...optional,
			})
		}
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call
		this.#find["focus"]()
	}

	protected startEmulator(): void {
		const { contentEl, plugin, leaf, state, app } = this,
			{ profile, cwd, serial } = state,
			{ language } = plugin,
			{ i18n } = language,
			{ workspace } = app,
			{ requestSaveLayout } = workspace,
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
					await openProfile(plugin, profile, { cwd })
				} catch (error) {
					printError(anyToError(error), () =>
						i18n.t("errors.error-spawning-terminal"), plugin)
				}
			})()
			leaf.detach()
			return
		}
		createChildElement(contentEl, "div", ele => {
			ele.classList.add(TerminalView.divClass.namespaced(plugin))
			const obsr = onVisible(ele, () => {
				try {
					noticeSpawn()
					const
						emulator = new TerminalView.EMULATOR(
							plugin,
							ele,
							async terminal => {
								if (serial) {
									await writePromise(
										terminal,
										i18n.t(
											"components.terminal.restored-history",
											{
												datetime: new Date(),
												interpolation: { escapeValue: false },
											},
										),
									)
								}
								const ret = await openProfile(plugin, profile, {
									cwd,
									terminal: TerminalView.EMULATOR.type,
								})
								if (ret) { return ret }
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
							},
							serial ?? UNDEFINED,
							{
								allowProposedApi: true,
							},
							{
								disposer: new DisposerAddon(
									() => { ele.remove() },
									() => { this.#title = "" },
									ele.onWindowMigrated(() => {
										emulator.reopen()
										emulator.resize(false).catch(logWarn)
									}),
									() => { this.#find?.$set({ results: "" }) },
								),
								dragAndDrop: new DragAndDropAddon(ele),
								ligatures: new xtermAddonLigatures.LigaturesAddon({}),
								renderer: new RendererAddon(
									() => new xtermAddonCanvas.CanvasAddon(),
									() => new xtermAddonWebgl.WebglAddon(false),
								),
								search: new xtermAddonSearch.SearchAddon(),
								unicode11: new xtermAddonUnicode11.Unicode11Addon(),
								webLinks: new xtermAddonWebLinks.WebLinksAddon(
									(_0, uri) => openExternal(uri),
									{},
								),
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
					terminal.onTitleChange(title => { this.#title = title })

					terminal.unicode.activeVersion = "11"
					disposer.push(plugin.on(
						"mutate-settings",
						settings0 => settings0.preferredRenderer,
						cur => { renderer.use(cur) },
					))
					renderer.use(plugin.settings.preferredRenderer)
					search.onDidChangeResults(results => {
						if (results) {
							const { resultIndex, resultCount } = results
							this.#find?.$set({
								results: i18n.t("components.find.results", {
									interpolation: { escapeValue: false },
									replace: {
										count: resultCount,
										index: resultIndex + 1,
									},
								}),
							})
							return
						}
						this.#find?.$set({
							results: i18n
								.t("components.find.too-many-results", {
									interpolation: { escapeValue: false },
									limit: TERMINAL_SEARCH_RESULTS_LIMIT,
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
		readonly dragAndDrop: DragAndDropAddon
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
