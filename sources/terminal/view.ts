import {
	type FileSystemAdapter,
	ItemView,
	MarkdownView,
	type Menu,
	TFolder,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian"
import {
	NOTICE_NO_TIMEOUT,
	TERMINAL_EXIT_SUCCESS,
} from "../magic"
import {
	PLATFORM,
	UnnamespacedID,
	anyToError,
	basename,
	commandNamer,
	extname,
	inSet,
	isInterface,
	notice,
	onVisible,
	openExternal,
	printError,
	saveFile,
	updateDisplayText,
} from "../util"
import {
	XtermTerminalEmulator,
	spawnExternalTerminalEmulator,
} from "./emulator"
import { DEFAULT_LANGUAGE } from "assets/locales"
import { SearchAddon } from "xterm-addon-search"
import type { TerminalPlugin } from "../main"
import { TerminalPty } from "./pty"
import { WebLinksAddon } from "xterm-addon-web-links"

export class TerminalView extends ItemView {
	public static readonly type = new UnnamespacedID("terminal")
	public static namespacedViewType: string
	#emulator0: TerminalView.EmulatorType | null = null
	#focus0 = false
	#state: TerminalView.State = {
		__type: TerminalView.State.TYPE,
		args: [],
		cwd: "",
		executable: "",
	}

	public constructor(
		protected readonly plugin: TerminalPlugin,
		leaf: WorkspaceLeaf,
	) {
		super(leaf)
	}

	get #emulator(): TerminalView.EmulatorType | null {
		return this.#emulator0
	}

	get #focus(): boolean {
		return this.#focus0
	}

	set #emulator(val: TerminalView.EmulatorType | null) {
		this.#emulator0?.close().catch(error => {
			printError(
				anyToError(error),
				() => this.plugin.language
					.i18n.t("errors.failed-to-kill-pseudoterminal"),
				this.plugin,
			)
		})
		const { plugin } = this,
			{ app, language } = plugin,
			{ i18n } = language,
			{ requestSaveLayout } = app.workspace
		val?.exit
			.then(code => {
				notice(
					() => i18n.t("notices.terminal-exited", { code }),
					inSet(TERMINAL_EXIT_SUCCESS, code)
						? plugin.settings.noticeTimeout
						: NOTICE_NO_TIMEOUT,
					plugin,
				)
			}, error => {
				printError(anyToError(error), () =>
					i18n.t("errors.error-spawning-terminal"), plugin)
			})
		val?.terminal.onWriteParsed(requestSaveLayout)
		val?.terminal.onResize(requestSaveLayout)
		if (this.#focus) { val?.terminal.focus() } else { val?.terminal.blur() }
		this.#emulator0 = val
	}

	set #focus(val: boolean) {
		const term = this.#emulator?.terminal
		if (this.#focus) { term?.focus() } else { term?.blur() }
		this.#focus0 = val
	}

	public override async setState(
		state: unknown,
		result: ViewStateResult,
	): Promise<void> {
		await super.setState(state, result)
		if (isInterface<TerminalView.State>(TerminalView.State.TYPE, state)) {
			this.#state = state
		}
	}

	public override getState(): unknown {
		const serial = this.#emulator?.serialize()
		if (typeof serial !== "undefined") {
			this.#state.serial = serial
		}
		return Object.assign(super.getState(), this.#state)
	}

	public override async onResize(): Promise<void> {
		super.onResize()
		const { containerEl } = this
		if (containerEl.offsetWidth <= 0 || containerEl.offsetHeight <= 0) {
			return
		}
		await this.#emulator?.resize()
	}

	public getDisplayText(): string {
		return this.plugin.language
			.i18n.t(
				`views.${TerminalView.type.id}.display-name`,
				{ executable: this.#getExecutableBasename() },
			)
	}

	public override getIcon(): string {
		return this.plugin.language
			.i18n.t(`asset:views.${TerminalView.type.id}-icon`)
	}

	public getViewType(): string {
		// Workaround: super() calls this method
		return TerminalView.namespacedViewType
	}

	public override onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source)
		const { i18n } = this.plugin.language
		menu
			.addSeparator()
			.addItem(item => item
				.setTitle(i18n.t("menus.save-as-HTML"))
				.setIcon(i18n.t("asset:menus.save-as-HTML-icon"))
				.setDisabled(this.#emulator === null)
				.onClick(() => {
					const emu = this.#emulator
					if (emu === null) { return }
					saveFile(
						emu.addons.serialize.serializeAsHTML({
							includeGlobalBackground: false,
							onlySelection: false,
						}),
						"text/html; charset=UTF-8;",
						`${this.#getExecutableBasename()}.html`,
					)
				}))
	}

	protected override async onOpen(): Promise<void> {
		await super.onOpen()
		const { containerEl, plugin } = this,
			{ app, language, statusBarHider } = plugin

		containerEl.empty()
		containerEl.createDiv({}, ele => {
			const obsr = onVisible(ele, obsr0 => {
				try {
					this.#startEmulator(ele)
				} finally {
					obsr0.disconnect()
				}
			})
			this.register(() => { obsr.disconnect() })
		})

		this.registerEvent(app.workspace.on("active-leaf-change", leaf => {
			if (leaf === this.leaf) {
				this.#focus = true
				return
			}
			this.#focus = false
		}))
		this.register(language.registerUse(() =>
			updateDisplayText(this)))
		this.register(statusBarHider.hide(() => this.#hidesStatusBar()))
		this.registerEvent(app.workspace.on(
			"active-leaf-change",
			() => { statusBarHider.update() },
		))
	}

	protected override async onClose(): Promise<void> {
		await super.onClose()
		this.#emulator = null
	}

	#startEmulator(element: HTMLElement): void {
		const { plugin } = this,
			state = this.#state,
			{ i18n } = plugin.language
		this.#emulator = new TerminalView.EmulatorType(
			plugin,
			element,
			() => {
				if (TerminalPty.PLATFORM_PTY === null) {
					throw new TypeError(i18n.t("errors.unsupported-platform"))
				}
				return new TerminalPty.PLATFORM_PTY(
					plugin,
					state.executable,
					state.cwd,
					state.args,
				)
			},
			state.serial,
			{
				allowProposedApi: true,
			},
			{
				search: new SearchAddon(),
				webLinks: new WebLinksAddon((_0, uri) => openExternal(uri)),
			},
		)
	}

	#getExecutableBasename(): string {
		const { executable } = this.#state
		return basename(executable, extname(executable))
	}

	#hidesStatusBar(): boolean {
		switch (this.plugin.settings.hideStatusBar) {
			case "focused":
				return this.#focus
			case "running":
				return true
			default:
				return false
		}
	}
}
export namespace TerminalView {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	export const EmulatorType = XtermTerminalEmulator
	export type EmulatorType = XtermTerminalEmulator<{
		readonly search: SearchAddon
		readonly webLinks: WebLinksAddon
	}>
	export interface State {
		readonly __type: typeof State.TYPE
		readonly executable: string
		readonly cwd: string
		readonly args: readonly string[]
		serial?: XtermTerminalEmulator.State
	}
	export namespace State {
		export const TYPE = "8d54e44a-32e7-4297-8ae2-cff88e92ce28"
	}
}

export function registerTerminal(plugin: TerminalPlugin): void {
	const
		CWD_TYPES = ["root", "current"] as const,
		TERMINAL_TYPES = ["external", "integrated"] as const,
		{ app, settings, language } = plugin,
		{ i18n } = language
	type CwdType = typeof CWD_TYPES[number]
	type TerminalType = typeof TERMINAL_TYPES[number]
	let terminalSpawnCommand = (
		_terminal: TerminalType,
		_cwd: CwdType,
	) => (_checking: boolean): boolean => false

	plugin.registerView(
		TerminalView.type.namespaced(plugin),
		leaf => new TerminalView(plugin, leaf),
	)

	if (inSet(TerminalPty.SUPPORTED_PLATFORMS, PLATFORM)) {
		const platform = PLATFORM,
			adapter = app.vault.adapter as FileSystemAdapter,
			spawnTerminal = (
				cwd: string,
				terminal: TerminalType,
			): void => {
				const executable = settings.executables[platform]
				notice(
					() => i18n.t(
						"notices.spawning-terminal",
						{ executable: executable.name },
					),
					settings.noticeTimeout,
					plugin,
				);
				(async (): Promise<void> => {
					switch (terminal) {
						case "external": {
							await spawnExternalTerminalEmulator(
								executable.name,
								cwd,
								executable.args,
							)
							break
						}
						case "integrated": {
							const { workspace } = app,
								existingLeaves = workspace
									.getLeavesOfType(TerminalView.type.namespaced(plugin)),
								viewState: TerminalView.State = {
									__type: TerminalView.State.TYPE,
									args: executable.args,
									cwd,
									executable: executable.name,
								}
							await ((): WorkspaceLeaf => {
								const existingLeaf = existingLeaves.last()
								if (typeof existingLeaf === "undefined") {
									return workspace.getLeaf("split", "horizontal")
								}
								workspace.setActiveLeaf(existingLeaf, { focus: false })
								return workspace.getLeaf("tab")
							})()
								.setViewState({
									active: true,
									state: viewState,
									type: TerminalView.type.namespaced(plugin),
								})
							break
						}
						default:
							throw new TypeError(terminal)
					}
				})().catch(error => {
					printError(
						anyToError(error),
						() => i18n.t("errors.error-spawning-terminal"),
						plugin,
					)
				})
			},
			addContextMenus = (menu: Menu, cwd: TFolder): void => {
				menu.addSeparator()
				for (const terminal of TERMINAL_TYPES) {
					menu.addItem(item => item
						.setTitle(i18n.t(`menus.open-terminal-${terminal}`))
						.setIcon(i18n.t(`asset:menus.open-terminal-${terminal}-icon`))
						.onClick(() => {
							spawnTerminal(
								adapter.getFullPath(cwd.path),
								terminal,
							)
						}))
				}
			}
		terminalSpawnCommand = (
			terminal: TerminalType,
			cwd: CwdType,
		) => (checking: boolean): boolean => {
			if (!settings.command) {
				return false
			}
			switch (cwd) {
				case "root": {
					if (!checking) {
						spawnTerminal(adapter.getBasePath(), terminal)
					}
					return true
				}
				case "current": {
					const activeFile = app.workspace.getActiveFile()
					if (activeFile === null) {
						return false
					}
					if (!checking) {
						spawnTerminal(
							adapter.getFullPath(activeFile.parent.path),
							terminal,
						)
					}
					return true
				}
				default:
					throw new TypeError(cwd)
			}
		}
		plugin.registerEvent(app.workspace.on("file-menu", (menu, file) => {
			if (!settings.contextMenu) {
				return
			}
			addContextMenus(menu, file instanceof TFolder ? file : file.parent)
		}))
		plugin.registerEvent(app.workspace.on(
			"editor-menu",
			(menu, _0, info) => {
				if (!settings.contextMenu ||
					info instanceof MarkdownView ||
					info.file === null) {
					return
				}
				addContextMenus(menu, info.file.parent)
			},
		))
	}
	for (const terminal of TERMINAL_TYPES) {
		for (const cwd of CWD_TYPES) {
			const id = `open-terminal-${terminal}-${cwd}` as const
			let namer = (): string => i18n.t(`commands.${id}`)
			// Always register command for interop with other plugins
			plugin.addCommand({
				checkCallback: terminalSpawnCommand(terminal, cwd),
				id,
				get name() { return namer() },
				set name(format) {
					namer = commandNamer(
						() => i18n.t(`commands.${id}`),
						() => i18n.t("name"),
						i18n.t("name", { lng: DEFAULT_LANGUAGE }),
						format,
					)
				},
			})
		}
	}
}
