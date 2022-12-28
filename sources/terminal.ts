import * as ffi from "ffi-napi"
import type * as win32def from "win32-def"
import * as win32defCommon from "win32-def/common.def"
import { type ChildProcessWithoutNullStreams, spawn, fork } from "child_process"
import { Debouncer, notice, onVisible, printError } from "./util"
import { EXIT_SUCCESS, NOTICE_NO_TIMEOUT } from "./magic"
import {
	ItemView,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian"
import { basename, extname } from "path"
import { FitAddon } from "xterm-addon-fit"
import type ObsidianTerminalPlugin from "./main"
import { SearchAddon } from "xterm-addon-search"
import { Terminal } from "xterm"
import { User32 } from "win32-api/promise"
import { WebLinksAddon } from "xterm-addon-web-links"
import { i18n } from "./i18n"
import { fileSync as tmpFileSync } from "tmp"

export interface TerminalViewState {
	type: "TerminalViewState"
	executable: string
	cwd: string
}
export class TerminalView extends ItemView {
	public static readonly viewType = "terminal-view"

	protected state: TerminalViewState = {
		cwd: "",
		executable: "",
		type: "TerminalViewState",
	}

	protected readonly terminal = new Terminal()
	protected readonly terminalAddons = {
		fit: new FitAddon(),
		search: new SearchAddon(),
		webLinks: new WebLinksAddon(),
	} as const

	protected pty?: ChildProcessWithoutNullStreams
	protected resizeDebouncer = new Debouncer(1000 / 2)

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
		if (!("type" in state)) {
			return
		}
		const state0 = state as { type: unknown }
		if (state0.type !== "TerminalViewState" || typeof this.pty !== "undefined") {
			return
		}
		this.state = state0 as TerminalViewState
		if (this.plugin.platform === "win32") {
			const tmp = tmpFileSync({ discardDescriptor: true })
			this.pty = spawn("C:\\Windows\\System32\\conhost.exe", [
				"C:\\Windows\\System32\\cmd.exe",
				"/C",
				`${this.state.executable} & call echo %^ERRORLEVEL% >"${tmp.name}"`,
			], {
				cwd: this.state.cwd,
				stdio: [
					"pipe",
					"pipe",
					"pipe",
				],
				windowsHide: true,
				windowsVerbatimArguments: true,
			}).on("close", (conCode, signal) => {
				try {
					const code = ((): NodeJS.Signals | number => {
						const termCode = parseInt(readFileSync(tmp.name, {
							encoding: "utf-8",
							flag: "r",
						}).trim(), 10)
						return isNaN(termCode)
							? conCode === null
								? signal === null
									? NaN
									: signal
								: conCode
							: termCode
					})()
					notice(i18n.t("notices.terminal-exited", { code }), code === EXIT_SUCCESS ? this.plugin.settings.noticeTimeout : NOTICE_NO_TIMEOUT)
				} finally {
					tmp.removeCallback()
				}
			})
		} else {
			this.pty = spawn(this.state.executable, [], {
				cwd: this.state.cwd,
				stdio: [
					"pipe",
					"pipe",
					"pipe",
				],
				windowsHide: true,
			}).on("close", (code0, signal) => {
				const code = code0 === null ? signal === null ? NaN : signal : code0
				notice(i18n.t("notices.terminal-exited", { code }), code === EXIT_SUCCESS ? this.plugin.settings.noticeTimeout : NOTICE_NO_TIMEOUT)
			})
		}
		this.pty.on("close", () => {
			this.leaf.detach()
		}).on("error", error => {
			printError(error, i18n.t("errors.error-spawning-terminal"))
		})

		this.pty.stdout.on("data", data => {
			this.terminal.write(data as Uint8Array | string)
		})
		this.pty.stderr.on("data", data => {
			this.terminal.write(data as Uint8Array | string)
		})
		const { pty } = this
		this.terminal.onData(data => pty.stdin.write(data))

		await Promise.resolve()
	}

	public getState(): TerminalViewState {
		return this.state
	}

	public async onResize(): Promise<void> {
		const { plugin, pty, resizeDebouncer, terminalAddons } = this
		if (typeof pty === "undefined") {
			return
		}
		if (plugin.platform === "win32") {
			const { pid } = pty
			if (typeof pid !== "undefined") {
				const user32 = User32.load(["User32.dll"])
				console.log(await user32.EnumWindows(new ffi.Callback(
					win32defCommon.BOOL,
					[win32defCommon.HWND, win32defCommon.LPARAM],
					async (hwnd: win32def.HANDLE, lParam: win32def.LPARAM) => {
						if (await user32.GetWindowThreadProcessId(hwnd, null) === lParam) {
							return false
						}
						return true
					}
				), pid))
			}
		}
		resizeDebouncer.apply(() => {
			terminalAddons.fit.fit()
		})
	}

	public getDisplayText(): string {
		const { executable } = this.getState()
		return i18n.t("views.terminal-view.display-name", { executable: basename(executable, extname(executable)) })
	}

	public getIcon(): string {
		return i18n.t("assets:views.terminal-view-icon")
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
		this.pty?.kill()
		this.terminal.dispose()
		await Promise.resolve()
	}
}
