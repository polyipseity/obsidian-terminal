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
	const ret = await spawnPromise(async () =>
		(await childProcess).spawn(executable, args ?? [], {
			cwd,
			detached: true,
			shell: true,
			stdio: ["ignore", "ignore", "ignore"],
		}))
	try { ret.unref() } catch (error) { console.warn(error) }
	return ret
}

export class XtermTerminalEmulator<A> {
	public readonly terminal
	public readonly addons

	public readonly onExit
	readonly #pty
	#exited = false
	readonly #resize = asyncDebounce(debounce(async (
		resolve: (value: Promise<void> | void) => void,
		reject: (reason?: unknown) => void,
		columns: number,
		rows: number,
		mustResizePty: boolean,
	) => {
		try {
			try {
				await (await this.#pty).resize(columns, rows)
			} catch (error) {
				if (mustResizePty) { throw error }
			}
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
		const { terminal } = this
		terminal.open(element)
		// eslint-disable-next-line prefer-object-spread
		this.addons = Object.assign({
			fit: new FitAddon(),
			serialize: new SerializeAddon(),
		}, addons)
		for (const addon of Object.values(this.addons)) {
			terminal.loadAddon(addon)
		}
		if (typeof state !== "undefined") {
			terminal.resize(state.columns, state.rows)
			terminal.write(state.data)
		}
		this.#pty = (async (): Promise<TerminalPty> => {
			const pty0 = await pty(terminal)
			await pty0.pipe(terminal)
			return pty0
		})()
		this.onExit = this.#pty.then(async pty0 => pty0.onExit)
			.finally(() => { this.#exited = true })
	}

	public async close(): Promise<void> {
		if (this.#exited ||
			((await this.#pty.then(async pty => pty.shell).catch(() => null))
				?.kill() ?? true)) {
			this.terminal.dispose()
			return
		}
		throw new Error(this.plugin.language
			.i18n.t("errors.failed-to-kill-pseudoterminal"))
	}

	public async resize(mustResizePty = true): Promise<void> {
		const { fit } = this.addons,
			dim = fit.proposeDimensions()
		if (typeof dim === "undefined") {
			return
		}
		await this.#resize(dim.cols, dim.rows, mustResizePty)
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

export class DisposerAddon extends Array<() => void> implements ITerminalAddon {
	public activate(_terminal: Terminal): void {
		// NOOP
	}

	public dispose(): void {
		for (const disposer of this) { disposer() }
	}
}

export class RendererAddon implements ITerminalAddon {
	public renderer: CanvasAddon | WebglAddon | null = null
	#terminal: Terminal | null = null

	public constructor(
		public readonly canvasSupplier: () => CanvasAddon,
		protected readonly webglSupplier: () => WebglAddon,
	) { }

	public use(renderer: RendererAddon.RendererOption): void {
		const term = this.#terminal
		if (term === null) { return }
		this.renderer?.dispose()
		switch (renderer) {
			case "dom":
				this.renderer = null
				break
			case "canvas":
				try {
					const renderer0 = this.canvasSupplier()
					term.loadAddon(this.renderer = renderer0)
					break
				} catch (error) {
					console.warn(error)
					this.use("dom")
				}
				break
			case "webgl": {
				try {
					const renderer0 = this.webglSupplier(),
						contextLoss = renderer0.onContextLoss(() => {
							try {
								this.use("webgl")
							} finally {
								contextLoss.dispose()
							}
						})
					term.loadAddon(this.renderer = renderer0)
				} catch (error) {
					console.warn(error)
					this.use("canvas")
				}
				break
			}
			default:
				throw new TypeError(renderer)
		}
	}

	public activate(terminal: Terminal): void {
		this.#terminal = terminal
	}

	public dispose(): void {
		this.renderer?.dispose()
		this.#terminal = null
	}
}
export namespace RendererAddon {
	export const RENDERER_OPTIONS = ["dom", "canvas", "webgl"] as const
	export type RendererOption = typeof RENDERER_OPTIONS[number]
}
