import {
	type ITerminalAddon,
	type ITerminalInitOnlyOptions,
	type ITerminalOptions,
	Terminal,
} from "xterm"
import { asyncDebounce, spawnPromise } from "sources/util"
import type { CanvasAddon } from "xterm-addon-canvas"
import type { ChildProcessByStdio } from "node:child_process"
import { FitAddon } from "xterm-addon-fit"
import { SerializeAddon } from "xterm-addon-serialize"
import { TERMINAL_RESIZE_TIMEOUT } from "sources/magic"
import type TerminalPlugin from "sources/main"
import type { TerminalPty } from "./pty"
import type { WebglAddon } from "xterm-addon-webgl"
import { debounce } from "obsidian"
import { dynamicRequire } from "sources/bundle"

const
	childProcess =
		dynamicRequire<typeof import("node:child_process")>("node:child_process")

export async function spawnExternalTerminalEmulator(
	executable: string,
	cwd?: string,
	args?: readonly string[],
): Promise<ChildProcessByStdio<null, null, null>> {
	return spawnPromise(async () =>
		(await childProcess).spawn(executable, args ?? [], {
			cwd,
			detached: true,
			shell: true,
			stdio: ["ignore", "ignore", "ignore"],
		}))
		.then(ret => {
			try { ret.unref() } catch (error) { void error }
			return ret
		})
}

export class XtermTerminalEmulator<A> {
	public readonly terminal
	public readonly addons

	public readonly exit
	readonly #pty
	#exited = false
	readonly #resize = asyncDebounce(debounce(async (
		resolve: (value: Promise<void> | void) => void,
		reject: (reason?: unknown) => void,
		columns: number,
		rows: number,
	) => {
		try {
			await (await this.#pty).resize(columns, rows)
			this.terminal.resize(columns, rows)
			resolve()
		} catch (error) {
			reject(error)
		}
	}, TERMINAL_RESIZE_TIMEOUT, false))

	public constructor(
		protected readonly plugin: TerminalPlugin,
		element: HTMLElement,
		pty: (terminal: Terminal) => PromiseLike<TerminalPty> | TerminalPty,
		state?: XtermTerminalEmulator.State,
		options?: ITerminalInitOnlyOptions & ITerminalOptions,
		addons?: A,
	) {
		this.terminal = new Terminal(options)
		this.terminal.open(element)
		// eslint-disable-next-line prefer-object-spread
		this.addons = Object.assign({
			fit: new FitAddon(),
			serialize: new SerializeAddon(),
		}, addons)
		for (const addon of Object.values(this.addons)) {
			this.terminal.loadAddon(addon)
		}
		if (typeof state !== "undefined") {
			this.terminal.resize(state.columns, state.rows)
			this.terminal.write(state.data)
		}
		this.#pty = Promise.resolve()
			.then(async () => {
				const pty0 = await pty(this.terminal)
				await pty0.pipe(this.terminal)
				return pty0
			})
		this.exit = this.#pty.then(async pty0 => pty0.exit)
			.finally(() => void (this.#exited = true))
	}

	public async close(): Promise<void> {
		return this.#pty.then(async pty => pty.shell, () => null).then(shell => {
			if (this.#exited || (shell?.kill() ?? true)) {
				this.terminal.dispose()
				return
			}
			throw new Error(this.plugin.language
				.i18n.t("errors.failed-to-kill-pseudoterminal"))
		})
	}

	public async resize(): Promise<void> {
		const { fit } = this.addons,
			dim = fit.proposeDimensions()
		if (typeof dim === "undefined") {
			return
		}
		await this.#resize(dim.cols, dim.rows)
	}

	public serialize(): XtermTerminalEmulator.State {
		return {
			columns: this.terminal.cols,
			data: this.addons.serialize.serialize({
				excludeAltBuffer: true,
				excludeModes: true,
			}),
			rows: this.terminal.rows,
		}
	}
}
export namespace XtermTerminalEmulator {
	export interface State {
		readonly columns: number
		readonly rows: number
		readonly data: string
	}
}

export class CombinedCanvasAddon implements ITerminalAddon {
	public webgl?: WebglAddon

	public constructor(
		public readonly canvas?: CanvasAddon,
		protected readonly webglSupplier?: () => WebglAddon,
	) { }

	public activate(terminal: Terminal): void {
		const load = (): void => {
			if (typeof this.webglSupplier !== "undefined") {
				try {
					this.webgl?.dispose()
					this.webgl = this.webglSupplier()
					terminal.loadAddon(this.webgl)
					const contextLoss = this.webgl.onContextLoss(() => {
						try {
							load()
						} finally {
							contextLoss.dispose()
						}
					})
					return
				} catch (error) { void error }
			}
			if (typeof this.canvas !== "undefined") {
				terminal.loadAddon(this.canvas)
			}
		}
		load()
	}

	public dispose(): void {
		this.webgl?.dispose()
		this.canvas?.dispose()
	}
}