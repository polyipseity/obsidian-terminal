import {
	ItemView,
	type ViewStateResult,
	type WorkspaceLeaf,
	debounce,
} from "obsidian"
import { NOTICE_NO_TIMEOUT, TERMINAL_EXIT_SUCCESS, TERMINAL_RESIZE_TIMEOUT } from "./magic"
import { UnnamespacedID, notice, onVisible, printError, statusBar } from "./util"
import { basename, extname } from "path"
import { FitAddon } from "xterm-addon-fit"
import type ObsidianTerminalPlugin from "./main"
import { SearchAddon } from "xterm-addon-search"
import { Terminal } from "xterm"
import type TerminalPty from "./pty"
import { WebLinksAddon } from "xterm-addon-web-links"

export interface TerminalViewState {
	readonly type: "TerminalViewState"
	readonly executable: string
	readonly cwd: string
	readonly args: string[]
}
export default class TerminalView extends ItemView {
	public static readonly viewType = new UnnamespacedID("terminal-view")
	public static namespacedViewType: string

	protected state: TerminalViewState = {
		args: [],
		cwd: "",
		executable: "",
		type: "TerminalViewState",
	}

	protected readonly terminal = new Terminal()
	protected readonly terminalAddons = {
		fit: new FitAddon(),
		search: new SearchAddon(),
		webLinks: new WebLinksAddon((_0, uri) => { window.open(uri) }),
	} as const

	protected pty?: TerminalPty
	protected readonly resizeNative = debounce(async (
		columns: number,
		rows: number,
	) => {
		const { pty } = this
		if (typeof pty === "undefined") {
			return
		}
		await pty.resize(columns, rows).catch()
	}, TERMINAL_RESIZE_TIMEOUT, false)

	public constructor(
		protected readonly plugin: ObsidianTerminalPlugin,
		leaf: WorkspaceLeaf
	) {
		super(leaf)
		for (const addon of Object.values(this.terminalAddons)) {
			this.terminal.loadAddon(addon)
		}
	}

	public async setState(state: any, _0: ViewStateResult): Promise<void> {
		if (!("type" in state) || (state as { type: unknown }).type !== "TerminalViewState" || typeof this.pty !== "undefined") {
			return
		}
		const state0 = state as TerminalViewState
		this.state = state0
		const { plugin, terminal } = this,
			{ i18n } = plugin,
			pty = new plugin.platform.terminalPty(
				plugin,
				state0.executable,
				state0.cwd,
				state0.args,
			)
		this.pty = pty
		pty.once("exit", code => {
			notice(i18n.t("notices.terminal-exited", { code }), TERMINAL_EXIT_SUCCESS.includes(code) ? plugin.settings.noticeTimeout : NOTICE_NO_TIMEOUT)
			this.leaf.detach()
		})
		const { shell } = pty
		shell
			.once("error", error => {
				printError(error, i18n.t("errors.error-spawning-terminal"))
			})
		shell.stdout.on("data", data => {
			terminal.write(data as Uint8Array | string)
		})
		shell.stderr.on("data", data => {
			terminal.write(data as Uint8Array | string)
		})
		terminal.onData(data => shell.stdin.write(data))
		await Promise.resolve()
	}

	public getState(): TerminalViewState {
		return this.state
	}

	public onResize(): void {
		if (this.plugin.app.workspace.getActiveViewOfType(TerminalView) === this) {
			const { fit } = this.terminalAddons,
				dim = fit.proposeDimensions()
			if (typeof dim === "undefined") {
				return
			}
			fit.fit()
			this.resizeNative(dim.cols, dim.rows)
		}
	}

	public getDisplayText(): string {
		const { executable } = this.getState()
		return this.plugin.i18n.t("views.terminal-view.display-name", { executable: basename(executable, extname(executable)) })
	}

	public getIcon(): string {
		return this.plugin.i18n.t("assets:views.terminal-view-icon")
	}

	public getViewType(): string {
		// Workaround: super() calls this method
		return TerminalView.namespacedViewType
	}

	protected async onOpen(): Promise<void> {
		const { containerEl, plugin, terminal } = this
		containerEl.empty()
		containerEl.createDiv({}, el => {
			onVisible(el, observer => {
				try {
					terminal.open(el)
				} finally {
					observer.disconnect()
				}
			})
		})
		const statusBarModifier = (function* gen(): Generator<undefined, never, "blur" | "focus"> {
			let prev: string | null = null
			do {
				const action = yield,
					div = statusBar()
				switch (action) {
					case "focus": {
						if (div === null) {
							prev = null
							break
						}
						const now = div.style.display
						if (prev === null || now !== "none") {
							prev = now
						}
						div.style.display = "none"
						break
					}
					case "blur": {
						if (prev === null) {
							break
						}
						if (div !== null) {
							div.style.display = prev
						}
						prev = null
						break
					}
					default:
						throw new TypeError(action)
				}
			} while (true)
		}())
		this.register(() => statusBarModifier.next("blur"))
		this.registerEvent(plugin.app.workspace.on("active-leaf-change", leaf => {
			if (leaf === this.leaf) {
				statusBarModifier.next("focus")
				terminal.focus()
				return
			}
			terminal.blur()
			statusBarModifier.next("blur")
		}))
		await Promise.resolve()
	}

	protected async onClose(): Promise<void> {
		this.pty?.shell.kill()
		this.terminal.dispose()
		await Promise.resolve()
	}
}
