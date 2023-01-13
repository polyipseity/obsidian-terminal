import {
	ItemView,
	type Menu,
	type ViewStateResult,
	type WorkspaceLeaf,
	debounce,
} from "obsidian"
import {
	NOTICE_NO_TIMEOUT,
	TERMINAL_EXIT_SUCCESS,
	TERMINAL_RESIZE_TIMEOUT,
} from "./magic"
import { type TerminalPty, WindowsTerminalPty } from "./pty"
import { type TerminalSerial, TerminalSerializer } from "./terminal-serialize"
import {
	UnnamespacedID,
	inSet,
	isInterface,
	notice,
	onVisible,
	openExternal,
	printError,
	saveFile,
	updateDisplayText,
} from "./util"
import { basename, extname } from "path"
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
			{ i18n } = plugin,
			pty = new plugin.platform.terminalPty(
				plugin,
				state.executable,
				state.cwd,
				state.args,
			)
		this.register(async () => (await pty.shell).kill())
		this.#pty = pty
		const shell = await (await pty.once("exit", code => {
			this.leaf.detach()
			notice(
				() => i18n.t("notices.terminal-exited", { code }),
				inSet(TERMINAL_EXIT_SUCCESS, code)
					? plugin.state.settings.noticeTimeout
					: NOTICE_NO_TIMEOUT,
				plugin,
			)
		})).shell
		shell.once("error", error => {
			this.leaf.detach()
			printError(error, () => i18n.t("errors.error-spawning-terminal"), plugin)
		})

		const { serial } = state
		const enum StdoutState {
			conhost = 1,
			clear = 2,
		}
		let stdoutState: StdoutState =
			(pty instanceof WindowsTerminalPty && pty.conhost
				? 0
				: StdoutState.conhost) |
			StdoutState.clear
		if (typeof serial !== "undefined") {
			stdoutState &= ~StdoutState.clear
			this.#serializer.unserialize(serial)
			this.#terminal.resize(serial.columns, serial.rows)
			this.#terminal.write(serial.data)
		}
		shell.stdout.on("data", (chunk: Buffer | string) => {
			if ((stdoutState & StdoutState.conhost) === 0) {
				stdoutState |= StdoutState.conhost
				// Skip conhost.exe output
				return
			}
			if ((stdoutState & StdoutState.clear) === 0) {
				stdoutState |= StdoutState.clear
				// Clear screen with scrollback kept
				this.#write("\n\u001b[K".repeat(this.#terminal.rows))
				this.#write("\u001b[H")
			}
			this.#write(chunk)
		})
		shell.stderr.on("data", (chunk: Buffer | string) => {
			this.#terminal.write(chunk)
		})
		this.#terminal.onData(data => shell.stdin.write(data))
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
		return this.plugin.i18n.t(`views.${TerminalView.type.id}.display-name`, { executable: this.#getExecutableBasename() })
	}

	public override getIcon(): string {
		return this.plugin.i18n.t(`asset:views.${TerminalView.type.id}-icon`)
	}

	public getViewType(): string {
		// Workaround: super() calls this method
		return TerminalView.namespacedViewType
	}

	public override onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source)
		const { leaf, plugin } = this,
			{ i18n } = plugin
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
			{ app, state } = plugin,
			{ language, statusBarHider } = state

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

	#write(data: Buffer | string): void {
		this.#terminal.write(data)
		this.plugin.app.workspace.requestSaveLayout()
	}

	#hidesStatusBar(): boolean {
		const { plugin } = this
		switch (plugin.state.settings.hideStatusBar) {
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
		readonly args: string[]
		serial?: TerminalSerial
	}
	export namespace State {
		export const TYPE = "8d54e44a-32e7-4297-8ae2-cff88e92ce28"
	}
}
