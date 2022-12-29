import {
	ItemView,
	type ViewStateResult,
	type WorkspaceLeaf,
	debounce,
} from "obsidian"
import { NOTICE_NO_TIMEOUT, TERMINAL_EXIT_SUCCESS, TERMINAL_RESIZE_TIMEOUT } from "./magic"
import { basename, extname } from "path"
import { notice, onVisible, printError } from "./util"
import { FitAddon } from "xterm-addon-fit"
import { I18N } from "./i18n"
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
	public static readonly viewType = "terminal-view"

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
	protected readonly resize = debounce(async () => {
		const { pty, terminalAddons } = this
		if (typeof pty === "undefined") {
			return
		}
		const { fit } = terminalAddons,
			dim = fit.proposeDimensions()
		if (typeof dim === "undefined") {
			return
		}
		await pty.resize(dim.cols, dim.rows)
		fit.fit()
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
		this.state = state as TerminalViewState
		this.pty = new this.plugin.platformDispatch.terminalPty(
			this.state.executable,
			this.state.cwd,
			this.state.args,
		)
		this.pty.once("exit", code => {
			notice(I18N.t("notices.terminal-exited", { code }), TERMINAL_EXIT_SUCCESS.includes(code) ? this.plugin.settings.noticeTimeout : NOTICE_NO_TIMEOUT)
			this.leaf.detach()
		})
		const shell = this.pty.shell()
			.once("error", error => {
				printError(error, I18N.t("errors.error-spawning-terminal"))
			})
		shell.stdout.on("data", data => {
			this.terminal.write(data as Uint8Array | string)
		})
		shell.stderr.on("data", data => {
			this.terminal.write(data as Uint8Array | string)
		})
		this.terminal.onData(data => shell.stdin.write(data))

		await Promise.resolve()
	}

	public getState(): TerminalViewState {
		return this.state
	}

	public onResize(): void {
		this.resize()
	}

	public getDisplayText(): string {
		const { executable } = this.getState()
		return I18N.t("views.terminal-view.display-name", { executable: basename(executable, extname(executable)) })
	}

	public getIcon(): string {
		return I18N.t("assets:views.terminal-view-icon")
	}

	public getViewType(): string {
		return TerminalView.viewType
	}

	protected async onOpen(): Promise<void> {
		const { containerEl } = this
		containerEl.empty()
		containerEl.createDiv({}, el => {
			onVisible(el, observer => {
				try {
					this.terminal.open(el)
				} finally {
					observer.disconnect()
				}
			})
		})
		await Promise.resolve()
	}

	protected async onClose(): Promise<void> {
		this.pty?.shell().kill()
		this.terminal.dispose()
		await Promise.resolve()
	}
}
