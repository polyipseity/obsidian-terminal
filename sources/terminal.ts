import { ExternalTerminalPty, TerminalPty } from "./pty"
import {
	type FileSystemAdapter,
	ItemView,
	MarkdownView,
	type Menu,
	TFolder,
	type ViewStateResult,
	type WorkspaceLeaf,
	debounce,
} from "obsidian"
import {
	NOTICE_NO_TIMEOUT,
	TERMINAL_EXIT_SUCCESS,
	TERMINAL_RESIZE_TIMEOUT,
} from "./magic"
import {
	PLATFORM,
	UnnamespacedID,
	commandNamer,
	inSet,
	isInterface,
	notice,
	onVisible,
	openExternal,
	printError,
	saveFile,
	updateDisplayText,
} from "./util"
import { type TerminalSerial, TerminalSerializer } from "./terminal-serialize"
import { basename, extname } from "path"
import { DEFAULT_LANGUAGE } from "assets/locales"
import { FitAddon } from "xterm-addon-fit"
import { SearchAddon } from "xterm-addon-search"
import { Terminal } from "xterm"
import type { TerminalPlugin } from "./main"
import { WebLinksAddon } from "xterm-addon-web-links"

export class TerminalView extends ItemView {
	public static readonly type = new UnnamespacedID("terminal")
	public static namespacedViewType: string
	#state: TerminalView.State = {
		__type: TerminalView.State.TYPE,
		args: [],
		cwd: "",
		executable: "",
	}

	readonly #terminal = new Terminal({
		allowProposedApi: true,
	})

	readonly #terminalAddons = {
		fit: new FitAddon(),
		search: new SearchAddon(),
		webLinks: new WebLinksAddon((_0, uri) => openExternal(uri)),
	} as const

	#pty?: TerminalPty
	readonly #serializer = new TerminalSerializer(this.#terminal)
	readonly #resizeNative = debounce(
		async (
			columns: number,
			rows: number,
		) => {
			try {
				await this.#pty?.resize(columns, rows)
				this.#terminal.resize(columns, rows)
				this.plugin.app.workspace.requestSaveLayout()
			} catch (error) { void error }
		},
		TERMINAL_RESIZE_TIMEOUT,
		false,
	)

	public constructor(
		protected readonly plugin: TerminalPlugin,
		leaf: WorkspaceLeaf,
	) {
		super(leaf)
		for (const addon of Object.values(this.#terminalAddons)) {
			this.#terminal.loadAddon(addon)
		}
		this.#terminal.onWriteParsed(this.plugin.app.workspace.requestSaveLayout)
	}

	public override async setState(
		state: any,
		result: ViewStateResult,
	): Promise<void> {
		await super.setState(state, result)
		if (!isInterface<TerminalView.State>(TerminalView.State.TYPE, state) ||
			typeof this.#pty !== "undefined") {
			return
		}
		this.#state = state

		const { plugin } = this,
			{ i18n } = plugin.language
		if (TerminalPty.PLATFORM_PTY === null) {
			this.leaf.detach()
			return
		}
		try {
			this.#pty = new TerminalPty.PLATFORM_PTY(
				plugin,
				state.executable,
				state.cwd,
				state.args,
			)
			const shell = await this.#pty.shell
			this.register(shell.kill.bind(shell))
			await this.#pty.once("exit", code => {
				try {
					this.leaf.detach()
				} finally {
					notice(
						() => i18n.t("notices.terminal-exited", { code }),
						inSet(TERMINAL_EXIT_SUCCESS, code)
							? plugin.settings.noticeTimeout
							: NOTICE_NO_TIMEOUT,
						plugin,
					)
				}
			})
			shell.once("error", error => {
				try {
					printError(error, () =>
						i18n.t("errors.error-spawning-terminal"), plugin)
				} finally {
					this.leaf.detach()
				}
			})
			const { serial } = state
			if (typeof serial !== "undefined") {
				this.#serializer.unserialize(serial)
				this.#terminal.resize(serial.columns, serial.rows)
				this.#terminal.write(serial.data)
			}
			await this.#pty.pipe(this.#terminal)
		} catch (error) {
			try {
				printError(error, () =>
					i18n.t("errors.error-spawning-terminal"), plugin)
			} finally {
				this.leaf.detach()
			}
		}
	}

	public override getState(): any {
		this.#state.serial = this.#serializer.serialize()
		return Object.assign(super.getState(), this.#state)
	}

	public override onResize(): void {
		super.onResize()
		const { containerEl } = this
		if (containerEl.offsetWidth <= 0 || containerEl.offsetHeight <= 0) {
			return
		}
		const { fit } = this.#terminalAddons,
			dim = fit.proposeDimensions()
		if (typeof dim === "undefined") {
			return
		}
		fit.fit()
		this.#resizeNative(dim.cols, dim.rows)
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
		const { leaf, plugin } = this,
			{ i18n } = plugin.language
		menu
			.addSeparator()
			.addItem(item => item
				.setTitle(i18n.t("menus.save-as-HTML"))
				.setIcon(i18n.t("asset:menus.save-as-HTML-icon"))
				.onClick(() => {
					const terminal = this.#terminal,
						save = (): void => {
							saveFile(
								this.#serializer.serializer.serializeAsHTML({
									includeGlobalBackground: false,
									onlySelection: false,
								}),
								"text/html; charset=UTF-8;",
								`${this.#getExecutableBasename()}.html`,
							)
						}
					if (typeof terminal.element === "undefined") {
						const { workspace } = plugin.app,
							last = workspace.getMostRecentLeaf(),
							dispose = terminal.onRender(() => {
								try {
									save()
								} finally {
									try {
										if (last !== null) {
											workspace.setActiveLeaf(last)
										}
									} finally {
										dispose.dispose()
									}
								}
							})
						try {
							workspace.setActiveLeaf(leaf)
						} catch {
							dispose.dispose()
						}
						return
					}
					save()
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
					this.register(() => { this.#terminal.dispose() })
					this.#terminal.open(ele)
				} finally {
					obsr0.disconnect()
				}
			})
			this.register(() => { obsr.disconnect() })
		})

		this.registerEvent(app.workspace.on("active-leaf-change", leaf => {
			if (leaf === this.leaf) {
				this.#terminal.focus()
				return
			}
			this.#terminal.blur()
		}))
		this.register(language.registerUse(() =>
			updateDisplayText(this)))
		this.register(statusBarHider.hide(this.#hidesStatusBar.bind(this)))
		this.registerEvent(app.workspace.on(
			"active-leaf-change",
			statusBarHider.update.bind(statusBarHider),
		))
	}

	#getExecutableBasename(): string {
		const { executable } = this.#state
		return basename(executable, extname(executable))
	}

	#hidesStatusBar(): boolean {
		const { plugin } = this
		switch (plugin.settings.hideStatusBar) {
			case "focused":
				return plugin.app.workspace.getActiveViewOfType(TerminalView) === this
			case "running":
				return true
			default:
				return false
		}
	}
}
export namespace TerminalView {
	export interface State {
		readonly __type: typeof State.TYPE
		readonly executable: string
		readonly cwd: string
		readonly args: readonly string[]
		serial?: TerminalSerial
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
			spawnTerminal = async (
				cwd: string,
				terminal: TerminalType,
			): Promise<void> => {
				const executable = settings.executables[platform]
				notice(
					() => i18n.t(
						"notices.spawning-terminal",
						{ executable: executable.name },
					),
					settings.noticeTimeout,
					plugin,
				)
				switch (terminal) {
					case "external": {
						const
							pty = new ExternalTerminalPty(
								plugin,
								executable.name,
								cwd,
								executable.args,
							),
							shell = await pty.shell
						shell.once("error", error => {
							printError(
								error,
								() => i18n.t("errors.error-spawning-terminal"),
								plugin,
							)
						})
						return new Promise((resolve, reject) => {
							shell.once("spawn", resolve).once("error", reject)
						})
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
						return ((): WorkspaceLeaf => {
							const existingLeaf = existingLeaves.last()
							if (typeof existingLeaf === "undefined") {
								return workspace.getLeaf("split", "horizontal")
							}
							workspace.setActiveLeaf(existingLeaf, { focus: false })
							return workspace.getLeaf("tab")
						})().setViewState({
							active: true,
							state: viewState,
							type: TerminalView.type.namespaced(plugin),
						})
					}
					default:
						throw new TypeError(terminal)
				}
			},
			addContextMenus = (menu: Menu, cwd: TFolder): void => {
				menu.addSeparator()
				for (const terminal of TERMINAL_TYPES) {
					menu.addItem(item => item
						.setTitle(i18n.t(`menus.open-terminal-${terminal}`))
						.setIcon(i18n.t(`asset:menus.open-terminal-${terminal}-icon`))
						.onClick(async () => spawnTerminal(
							adapter.getFullPath(cwd.path),
							terminal,
						)))
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
						spawnTerminal(
							adapter.getBasePath(),
							terminal,
						).catch(() => { })
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
						).catch(() => { })
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
