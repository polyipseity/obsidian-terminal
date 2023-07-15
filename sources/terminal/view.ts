import {
	DEFAULT_ENCODING,
	DEFAULT_SUCCESS_EXIT_CODES,
	DOMClasses2,
	UNDEFINED,
} from "../magic.js"
import {
	DialogModal,
	FindComponent,
	type FindComponent$,
	type Fixed,
	JSON_STRINGIFY_SPACE,
	Platform,
	UnnamespacedID,
	activeSelf,
	anyToError,
	assignExact,
	awaitCSS,
	basename,
	cloneAsWritable,
	consumeEvent,
	copyOnWrite,
	createChildElement,
	deepFreeze,
	destroyWithOutro,
	dynamicRequireLazy,
	extname,
	fixTyped,
	instanceOf,
	launderUnchecked,
	linkSetting,
	markFixed,
	newCollabrativeState,
	notice2,
	onResize,
	openExternal,
	printError,
	printMalformedData,
	randomNotIn,
	readStateCollabratively,
	recordViewStateHistory,
	resetButton,
	saveFileAs,
	updateView,
	useSettings,
	writeStateCollabratively,
} from "@polyipseity/obsidian-plugin-library"
import {
	DisposerAddon,
	DragAndDropAddon,
	RendererAddon,
} from "./emulator-addons.js"
import {
	FileSystemAdapter,
	ItemView,
	type Menu,
	Scope,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian"
import {
	PROFILE_PROPERTIES,
	openProfile,
} from "./profile-properties.js"
import { BUNDLE } from "../import.js"
import type { DeepWritable } from "ts-essentials"
import type { LigaturesAddon } from "xterm-addon-ligatures"
import { ProfileModal } from "../modals.js"
import type { SearchAddon } from "xterm-addon-search"
import { Settings } from "../settings-data.js"
import type { TerminalPlugin } from "../main.js"
import { TextPseudoterminal } from "./pseudoterminal.js"
import type { Unicode11Addon } from "xterm-addon-unicode11"
import type { WebLinksAddon } from "xterm-addon-web-links"
import { XtermTerminalEmulator } from "./emulator.js"
import { cloneDeep } from "lodash-es"
import { writePromise } from "./util.js"

const
	xtermAddonCanvas = dynamicRequireLazy<typeof import("xterm-addon-canvas")
	>(BUNDLE, "xterm-addon-canvas"),
	xtermAddonLigatures =
		dynamicRequireLazy<typeof import("xterm-addon-ligatures")
		>(BUNDLE, "xterm-addon-ligatures"),
	xtermAddonSearch = dynamicRequireLazy<typeof import("xterm-addon-search")
	>(BUNDLE, "xterm-addon-search"),
	xtermAddonUnicode11 =
		dynamicRequireLazy<typeof import("xterm-addon-unicode11")
		>(BUNDLE, "xterm-addon-unicode11"),
	xtermAddonWebLinks = dynamicRequireLazy<typeof import("xterm-addon-web-links")
	>(BUNDLE, "xterm-addon-web-links"),
	xtermAddonWebgl = dynamicRequireLazy<typeof import("xterm-addon-webgl")
	>(BUNDLE, "xterm-addon-webgl")

class EditTerminalModal extends DialogModal {
	protected readonly state
	#profile: string | null = null
	readonly #confirm

	public constructor(
		protected override readonly context: TerminalPlugin,
		protected readonly protostate: TerminalView.State,
		confirm: (state_: DeepWritable<typeof protostate>) => unknown,
	) {
		const { language: { i18n } } = context
		super(context, {
			dynamicWidth: true,
			title: () => i18n.t("components.terminal.edit-modal.title"),
		})
		this.state = cloneAsWritable(protostate)
		this.#confirm = confirm
	}

	public override onOpen(): void {
		super.onOpen()
		const
			{
				context,
				context: {
					settings,
					language: { i18n },
					app: { vault: { adapter } },
				},
				ui,
				protostate,
				state,
			} = this,
			{ element: listEl, remover: listElRemover } = useSettings(this.contentEl)
		ui.finally(listElRemover)
			.newSetting(listEl, setting => {
				setting
					.setName(i18n.t("components.terminal.edit-modal.working-directory"))
					.addText(linkSetting(
						() => state.cwd ?? "",
						value => { state.cwd = value || null },
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
					.addButton(button => button
						.setIcon(i18n
							.t("asset:components.terminal.edit-modal.root-directory-icon"))
						.setTooltip(i18n.t("components.terminal.edit-modal.root-directory"))
						.onClick(() => {
							state.cwd = adapter instanceof FileSystemAdapter
								? adapter.getBasePath()
								: null
							this.postMutate()
						}))
					.addExtraButton(resetButton(
						i18n
							.t("asset:components.terminal.edit-modal.working-directory-icon"),
						i18n.t("components.terminal.edit-modal.reset"),
						() => { state.cwd = protostate.cwd },
						() => { this.postMutate() },
					))
			})
			.newSetting(listEl, setting => {
				const { profiles } = settings.copy,
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
													.Profile.isCompatible(entry[1], Platform.CURRENT)
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
								context,
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
		await this.#confirm(cloneAsWritable(this.state))
		await super.confirm(close)
	}

	protected postMutate(): void {
		const { modalUI, ui } = this
		modalUI.update()
		ui.update()
	}
}

export class TerminalView extends ItemView {
	public static readonly type =
		new UnnamespacedID(DOMClasses2.Namespaced.TERMINAL)

	protected static readonly modifiers = deepFreeze(Platform.CURRENT === "darwin"
		? ["Meta"]
		: ["Ctrl", "Shift"])

	static #namespacedType: string
	protected readonly scope = new Scope(this.app.scope)
	protected readonly focusedScope = new Scope()
	#title0 = ""
	#emulator0: TerminalView.EMULATOR | null = null
	#find0: FindComponent | null = null
	#state = TerminalView.State.DEFAULT

	public constructor(
		protected readonly context: TerminalPlugin,
		leaf: WorkspaceLeaf,
	) {
		TerminalView.#namespacedType = TerminalView.type.namespaced(context)
		super(leaf)
		this.navigation = true
		const { scope, focusedScope } = this
		scope.register(TerminalView.modifiers, "`", event => {
			this.#emulator?.terminal.focus()
			consumeEvent(event)
		})
		focusedScope.register(TerminalView.modifiers, "`", event => {
			const { contentEl: { ownerDocument: { activeElement } } } = this
			if (instanceOf(activeElement, HTMLElement) ||
				instanceOf(activeElement, SVGElement)) {
				activeElement.blur()
			}
			consumeEvent(event)
		})
		focusedScope.register(TerminalView.modifiers, "f", event => {
			this.startFind()
			consumeEvent(event)
		})
		focusedScope.register(TerminalView.modifiers, "k", event => {
			this.#emulator?.terminal.clear()
			consumeEvent(event)
		})
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
		const { context: plugin, state } = this,
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
		const { context: { settings }, contentEl } = this
		switch (settings.copy.hideStatusBar) {
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
		updateView(this.context, this)
	}

	set #emulator(val: TerminalView.EMULATOR | null) {
		const { context: plugin } = this
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
		updateView(this.context, this)
	}

	public override async setState(
		state: unknown,
		result: ViewStateResult,
	): Promise<void> {
		const { context: plugin } = this,
			ownState = readStateCollabratively(
				TerminalView.type.namespaced(plugin),
				state,
			),
			{ value, valid } = TerminalView.State.fix(ownState)
		if (!valid) { printMalformedData(plugin, ownState, value) }
		await super.setState(state, result)
		const { focus } = value
		value.focus = false
		this.state = value
		this.startEmulator(focus)
		recordViewStateHistory(plugin, result)
	}

	public override getState(): unknown {
		const serial = this.#emulator?.serialize()
		if (serial) {
			this.state = copyOnWrite(this.state, state => { state.serial = serial })
		}
		return writeStateCollabratively(
			super.getState(),
			TerminalView.type.namespaced(this.context),
			this.state,
		)
	}

	public getDisplayText(): string {
		return this.context.language
			.i18n.t(
				`components.${TerminalView.type.id}.display-name`,
				{
					interpolation: { escapeValue: false },
					name: this.#name,
				},
			)
	}

	public override getIcon(): string {
		return this.context.language
			.i18n.t(`asset:components.${TerminalView.type.id}.icon`)
	}

	public getViewType(): string {
		return TerminalView.#namespacedType
	}

	public override onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source)
		const { context: plugin, leaf, app: { vault: { adapter } } } = this,
			{ i18n } = plugin.language
		menu
			.addSeparator()
			.addItem(item => item
				.setTitle(i18n.t("components.terminal.menus.clear"))
				.setIcon(i18n.t("asset:components.terminal.menus.clear-icon"))
				.onClick(() => { this.#emulator?.terminal.clear() }))
			.addItem(item => item
				.setTitle(i18n.t("components.terminal.menus.find"))
				.setIcon(i18n.t("asset:components.terminal.menus.find-icon"))
				.setDisabled(this.#find !== null)
				.onClick(() => { this.startFind() }))
			.addSeparator()
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
				.setTitle(i18n.t("components.terminal.menus.restart"))
				.setIcon(i18n.t("asset:components.terminal.menus.restart-icon"))
				.onClick(() => { this.startEmulator(true) }))
			.addSeparator()
			.addItem(item => item
				.setTitle(i18n.t("components.terminal.menus.save-as-HTML"))
				.setIcon(i18n.t("asset:components.terminal.menus.save-as-HTML-icon"))
				.setDisabled(!this.#emulator?.addons.serialize)
				.onClick(async () => {
					const ser = this.#emulator?.addons.serialize
					if (!ser) { return }
					await saveFileAs(
						plugin,
						adapter,
						new File(
							[
								ser.serializeAsHTML({
									includeGlobalBackground: false,
									onlySelection: false,
								}),
							],
							`${this.#name}.html`,
							{ type: `text/html; charset=${DEFAULT_ENCODING};` },
						),
					)
				}))
	}

	protected override async onOpen(): Promise<void> {
		await super.onOpen()
		const { context, focusedScope, contentEl, containerEl, scope, app } = this,
			{ language, statusBarHider } = context,
			{ i18n } = language,
			{ keymap } = app

		this.register(language.onChangeLanguage.listen(() => {
			updateView(context, this)
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

		this.register(statusBarHider.hide(() => this.#hidesStatusBar))
		this.register(() => { this.#emulator = null })
	}

	protected startFind(): void {
		const { context: plugin, contentEl } = this,
			{ language } = plugin,
			{ i18n } = language
		if (!this.#find) {
			const
				onFind = (
					direction: FindComponent$.Direction,
					params: FindComponent$.Params,
					incremental = false,
				): void => {
					const finder = this.#emulator?.addons.search
					if (!finder) { return }
					const func = direction === "next"
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
						activeSelf(contentEl).console.debug(error)
						empty = true
					}
					if (empty) { this.#find?.$set({ results: "" }) }
				},
				optional: { anchor?: Element } = {}
			assignExact(optional, "anchor", contentEl.firstElementChild ?? UNDEFINED)
			this.#find = new FindComponent({
				intro: true,
				props: {
					i18n: i18n.t,
					onClose: (): void => { this.#find = null },
					onFind,
					onParamsChanged: (params: FindComponent$.Params): void => {
						this.#emulator?.addons.search.clearDecorations()
						onFind("previous", params)
					},
				},
				target: contentEl,
				...optional,
			})
		}
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call
		this.#find["focus"]()
	}

	protected startEmulator(focus: boolean): void {
		const
			{
				contentEl,
				context,
				context: { language: { onChangeLanguage, i18n }, settings },
				leaf,
				state: { profile, cwd, serial },
				app: { workspace: { requestSaveLayout } },
			} = this,
			noticeSpawn = (): void => {
				notice2(
					() => i18n.t(
						"notices.spawning-terminal",
						{
							interpolation: { escapeValue: false },
							name: this.#name,
						},
					),
					settings.copy.noticeTimeout,
					context,
				)
			}
		if (!PROFILE_PROPERTIES[profile.type].integratable) {
			(async (): Promise<void> => {
				try {
					noticeSpawn()
					await openProfile(context, profile, { cwd })
				} catch (error) {
					printError(anyToError(error), () =>
						i18n.t("errors.error-spawning-terminal"), context)
				}
			})()
			leaf.detach()
			return
		}
		createChildElement(contentEl, "div", ele => {
			function warn(error: unknown): void {
				activeSelf(ele).console.warn(error)
			}
			ele.classList.add(TerminalView.type.namespaced(context));
			(async (): Promise<void> => {
				try {
					await awaitCSS(ele)
					noticeSpawn()
					const
						serial0 = profile.type === "invalid" || profile.restoreHistory
							? serial
							: null,
						emulator = new TerminalView.EMULATOR(
							ele,
							async terminal => {
								if (serial0) {
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
								const ret = await openProfile(context, profile, {
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
								pty.onExit.finally(onChangeLanguage.listen(() => {
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
							serial0 ?? UNDEFINED,
							{
								...profile.type === "invalid"
									? {}
									: cloneAsWritable(profile.terminalOptions, cloneDeep),
								allowProposedApi: true,
							},
							{
								disposer: new DisposerAddon(
									() => { ele.remove() },
									() => { this.#title = "" },
									ele.onWindowMigrated(() => {
										emulator.reopen()
										emulator.resize(false).catch(warn)
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
									(event, uri) => openExternal(activeSelf(event), uri),
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
								(profile.type === "invalid"
									? DEFAULT_SUCCESS_EXIT_CODES
									: profile.successExitCodes).includes(code.toString())
									? settings.copy.noticeTimeout
									: settings.copy.errorNoticeTimeout,
								context,
							)
						}, error => {
							printError(anyToError(error), () =>
								i18n.t("errors.error-spawning-terminal"), context)
						})
					terminal.onWriteParsed(requestSaveLayout)
					terminal.onResize(requestSaveLayout)
					terminal.onTitleChange(title => { this.#title = title })

					terminal.unicode.activeVersion = "11"
					disposer.push(settings.on(
						"mutate-settings",
						settings0 => settings0.preferredRenderer,
						cur => { renderer.use(cur) },
					))
					renderer.use(settings.copy.preferredRenderer)
					search.onDidChangeResults(results0 => {
						const { resultIndex, resultCount } = results0,
							results = resultIndex === -1 && resultCount > 0
								? i18n.t("components.find.too-many-results", {
									interpolation: { escapeValue: false },
									limit: resultCount - 1,
								})
								: i18n.t("components.find.results", {
									interpolation: { escapeValue: false },
									replace: {
										count: resultCount,
										index: resultIndex + 1,
									},
								})
						this.#find?.$set({ results })
					})

					emulator.resize().catch(warn)
					onResize(ele, ent => {
						if (ent.contentBoxSize
							.every(size => size.blockSize <= 0 || size.inlineSize <= 0)) {
							return
						}
						emulator.resize(false).catch(warn)
					})
					this.#emulator = emulator
					if (focus) { terminal.focus() }
				} catch (error) {
					activeSelf(ele).console.error(error)
				}
			})()
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
		readonly focus: boolean
	}
	export namespace State {
		export const DEFAULT: State = deepFreeze({
			cwd: null,
			focus: false,
			profile: Settings.Profile.DEFAULTS.invalid,
			serial: null,
		})
		export function fix(self0: unknown): Fixed<State> {
			const unc = launderUnchecked<State>(self0)
			return markFixed(self0, {
				cwd: fixTyped(DEFAULT, unc, "cwd", ["string", "null"]),
				focus: fixTyped(DEFAULT, unc, "focus", ["boolean"]),
				profile: Settings.Profile.fix(unc.profile).value,
				serial: unc.serial === null
					? null
					: XtermTerminalEmulator.State.fix(unc.serial).value,
			})
		}
	}
	export function getLeaf(context: TerminalPlugin): WorkspaceLeaf {
		const
			{
				app: { workspace, workspace: { leftSplit, rightSplit } },
				settings,
			} = context,
			// eslint-disable-next-line consistent-return
			leaf = ((): WorkspaceLeaf => {
				if (settings.copy.createInstanceNearExistingOnes) {
					const existingLeaf = workspace
						// eslint-disable-next-line @typescript-eslint/no-unnecessary-qualifier
						.getLeavesOfType(TerminalView.type.namespaced(context))
						.at(-1)
					if (existingLeaf) {
						const root = existingLeaf.getRoot()
						if (root === leftSplit) {
							return workspace.getLeftLeaf(false)
						}
						if (root === rightSplit) {
							return workspace.getRightLeaf(false)
						}
						workspace.setActiveLeaf(existingLeaf)
						return workspace.getLeaf("tab")
					}
				}
				switch (settings.copy.newInstanceBehavior) {
					case "replaceTab":
						return workspace.getLeaf()
					case "newTab":
						return workspace.getLeaf("tab")
					case "newLeftTab":
						return workspace.getLeftLeaf(false)
					case "newLeftSplit":
						return workspace.getLeftLeaf(true)
					case "newRightTab":
						return workspace.getRightLeaf(false)
					case "newRightSplit":
						return workspace.getRightLeaf(true)
					case "newHorizontalSplit":
						return workspace.getLeaf("split", "horizontal")
					case "newVerticalSplit":
						return workspace.getLeaf("split", "vertical")
					case "newWindow":
						return workspace.getLeaf("window")
					// No default
				}
			})()
		leaf.setPinned(settings.copy.pinNewInstance)
		return leaf
	}
}
