import { type ChildProcessWithoutNullStreams, spawn } from "child_process"
import {
	ItemView,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian"
import { FitAddon } from "xterm-addon-fit"
import { Terminal } from "xterm"

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

	public constructor(leaf: WorkspaceLeaf) {
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
		const state1 = state0 as TerminalViewState,
			win32 = state1.platform === "win32",
			exec = win32 ? "C:\\Windows\\System32\\conhost.exe" : state1.executable,
			args = win32 ? [state1.executable] : []
		this.pty = spawn(exec, args, {
			cwd: state1.cwd,
			stdio: [
				"pipe",
				"pipe",
				"pipe",
			],
			windowsHide: true,
		})
		this.pty.stdout.on("data", data => {
			this.terminal.write(data as Uint8Array | string)
		})
		this.pty.stderr.on("data", data => {
			this.terminal.write(data as Uint8Array | string)
		})
		this.terminal.onData(data => this.pty?.stdin.write(data))
		this.state = state1
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
