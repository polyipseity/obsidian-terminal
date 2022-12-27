import { type ChildProcessWithoutNullStreams, spawn } from "child_process"
import {
	ItemView,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian"
import { notice, printError } from "./util"
import { FitAddon } from "xterm-addon-fit"
import type ObsidianTerminalPlugin from "./main"
import { Terminal } from "xterm"
import { readFileSync } from "fs"
import { fileSync as tmpFileSync } from "tmp"

export interface TerminalViewState {
	type: "TerminalViewState"
	platform: string
	executable: string
	cwd: string
}
export class TerminalView extends ItemView {
	public static readonly viewType = "terminal-view"
	protected state: TerminalViewState | null = null
	protected readonly terminal = new Terminal()
	protected readonly fitAddon = new FitAddon()
	protected pty?: ChildProcessWithoutNullStreams

	public constructor(
		protected readonly plugin: ObsidianTerminalPlugin,
		leaf: WorkspaceLeaf
	) {
		super(leaf)
		this.terminal.loadAddon(this.fitAddon)
	}

	public async setState(state: any, _0: ViewStateResult): Promise<void> {
		if (!("type" in state)) {
			return
		}
		const state0 = state as { type: any }
		if (state0.type !== "TerminalViewState" || typeof this.pty !== "undefined") {
			return
		}
		this.state = state0 as TerminalViewState
		if (this.state.platform === "win32") {
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
			})
			this.pty.on("close", () => {
				const exitCode = parseInt(readFileSync(tmp.name, {
					encoding: "utf-8",
					flag: "r",
				}).trim(), 10)
				notice(`Terminal exited with code ${exitCode}`, this.plugin.settings.noticeTimeout)
				tmp.removeCallback()
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
			})
			this.pty.on("close", exitCode => {
				notice(`Terminal exited with code ${exitCode === null ? "null" : exitCode}`, this.plugin.settings.noticeTimeout)
			})
		}
		this.pty.stdout.on("data", data => {
			this.terminal.write(data as Uint8Array | string)
		})
		this.pty.stderr.on("data", data => {
			this.terminal.write(data as Uint8Array | string)
		})
		const { pty } = this
		this.terminal.onData(data => pty.stdin.write(data))
		this.pty.on("close", () => {
			this.leaf.detach()
		})
		this.pty.on("error", error => { printError(error, "Error spawning terminal") })
		await Promise.resolve()
	}

	public getState(): TerminalViewState | null {
		return this.state
	}

	public async onResize(): Promise<void> {
		this.fitAddon.fit()
		await Promise.resolve()
	}

	public getDisplayText(): string {
		return "Terminal"
	}

	public getViewType(): string {
		return TerminalView.viewType
	}

	protected async onOpen(): Promise<void> {
		const { containerEl } = this
		containerEl.empty()
		this.terminal.open(containerEl.createDiv({ cls: "obsidian-terminal" }))
		await this.onResize()
		this.terminal.focus()
	}

	protected async onClose(): Promise<void> {
		this.pty?.kill()
		this.terminal.dispose()
		await Promise.resolve()
	}
}
