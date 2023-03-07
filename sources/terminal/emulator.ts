import { type Fixed, fixTyped, markFixed } from "sources/ui/fixers"
import { Functions, deepFreeze, spawnPromise } from "../utils/util"
import {
	type ITerminalAddon,
	type ITerminalInitOnlyOptions,
	type ITerminalOptions,
	Terminal,
} from "xterm"
import {
	SI_PREFIX_SCALE,
	TERMINAL_EMULATOR_RESIZE_WAIT,
	TERMINAL_PTY_RESIZE_WAIT,
} from "../magic"
import { dynamicRequire, importable } from "../imports"
import type { AsyncOrSync } from "ts-essentials"
import type { CanvasAddon } from "xterm-addon-canvas"
import type { ChildProcessByStdio } from "node:child_process"
import { FitAddon } from "xterm-addon-fit"
import type { Pseudoterminal } from "./pseudoterminal"
import { SerializeAddon } from "xterm-addon-serialize"
import type { TerminalPlugin } from "../main"
import type { WebglAddon } from "xterm-addon-webgl"
import { asyncDebounce } from "sources/utils/obsidian"
import { launderUnchecked } from "sources/utils/types"
import { throttle } from "lodash-es"
import { writePromise } from "./util"

const
	childProcess =
		dynamicRequire<typeof import("node:child_process")>("node:child_process")

export const SUPPORTS_EXTERNAL_TERMINAL_EMULATOR =
	importable("node:child_process")
export async function spawnExternalTerminalEmulator(
	executable: string,
	args?: readonly string[],
	cwd?: string,
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
	public static readonly type = "xterm-256color"
	public readonly terminal
	public readonly addons
	public readonly pseudoterminal
	protected readonly resizeEmulator = asyncDebounce(throttle((
		resolve: (value: AsyncOrSync<void>) => void,
		reject: (reason?: unknown) => void,
		columns: number,
		rows: number,
	) => {
		try {
			this.terminal.resize(columns, rows)
			resolve()
		} catch (error) {
			reject(error)
		}
	}, TERMINAL_EMULATOR_RESIZE_WAIT * SI_PREFIX_SCALE))

	protected readonly resizePTY = asyncDebounce(throttle((
		resolve: (value: AsyncOrSync<void>) => void,
		_reject: (reason?: unknown) => void,
		columns: number,
		rows: number,
		mustResizePseudoterminal: boolean,
	) => {
		resolve((async (): Promise<void> => {
			try {
				const pty = await this.pseudoterminal
				if (pty.resize) {
					await pty.resize(columns, rows)
				}
			} catch (error) {
				if (mustResizePseudoterminal) { throw error }
				console.debug(error)
			}
		})())
	}, TERMINAL_PTY_RESIZE_WAIT * SI_PREFIX_SCALE))

	#running = true

	public constructor(
		protected readonly plugin: TerminalPlugin,
		protected readonly element: HTMLElement,
		pseudoterminal: (
			terminal: Terminal,
			addons: XtermTerminalEmulator<A>["addons"],
		) => AsyncOrSync<Pseudoterminal>,
		state?: XtermTerminalEmulator.State,
		options?: ITerminalInitOnlyOptions & ITerminalOptions,
		addons?: A,
	) {
		this.terminal = new Terminal(options)
		const { terminal } = this
		terminal.open(element)
		// eslint-disable-next-line prefer-object-spread
		const addons0 = Object.assign({
			fit: new FitAddon(),
			serialize: new SerializeAddon(),
		}, addons)
		for (const addon of Object.values(addons0)) {
			terminal.loadAddon(addon)
		}
		this.addons = addons0
		let write = Promise.resolve()
		if (state) {
			terminal.resize(state.columns, state.rows)
			write = writePromise(terminal, state.data)
		}
		this.pseudoterminal = write.then(async () => {
			const pty0 = await pseudoterminal(terminal, addons0)
			await pty0.pipe(terminal)
			return pty0
		})
		this.pseudoterminal.then(async pty0 => pty0.onExit)
			.finally(() => { this.#running = false })
	}

	public async close(mustClosePseudoterminal = true): Promise<void> {
		try {
			if (this.#running) {
				await (await this.pseudoterminal).kill()
			}
		} catch (error) {
			if (mustClosePseudoterminal) { throw error }
			console.debug(error)
		}
		this.terminal.dispose()
	}

	public async resize(mustResizePseudoterminal = true): Promise<void> {
		const { addons, resizeEmulator, resizePTY } = this,
			{ fit } = addons,
			dim = fit.proposeDimensions()
		if (dim) {
			const { cols, rows } = dim
			if (isFinite(cols) && isFinite(rows)) {
				await Promise.all([
					resizeEmulator(cols, rows),
					resizePTY(cols, rows, mustResizePseudoterminal),
				])
			}
		}
	}

	public reopen(): void {
		const { element, terminal } = this
		terminal.element?.remove()
		terminal.open(element)
	}

	public serialize(): XtermTerminalEmulator.State {
		return deepFreeze({
			columns: this.terminal.cols,
			data: this.addons.serialize.serialize({
				excludeAltBuffer: true,
				excludeModes: true,
			}),
			rows: this.terminal.rows,
		})
	}
}
export namespace XtermTerminalEmulator {
	export interface State {
		readonly columns: number
		readonly rows: number
		readonly data: string
	}
	export namespace State {
		export const DEFAULT: State = deepFreeze({
			columns: 1,
			data: "",
			rows: 1,
		} as const)
		export function fix(self: unknown): Fixed<State> {
			const unc = launderUnchecked<State>(self)
			return markFixed(self, {
				columns: fixTyped(DEFAULT, unc, "columns", ["number"]),
				data: fixTyped(DEFAULT, unc, "data", ["string"]),
				rows: fixTyped(DEFAULT, unc, "rows", ["number"]),
			})
		}
	}
}

export class DisposerAddon extends Functions implements ITerminalAddon {
	public constructor(...args: readonly (() => void)[]) {
		super({ async: false, settled: true }, ...args)
	}

	public activate(_terminal: Terminal): void {
		// NOOP
	}

	public dispose(): void {
		this.call()
	}
}

export class RendererAddon implements ITerminalAddon {
	public renderer: CanvasAddon | WebglAddon | null = null
	#terminal: Terminal | null = null

	public constructor(
		protected readonly canvasSupplier: () => CanvasAddon,
		protected readonly webglSupplier: () => WebglAddon,
	) { }

	public use(renderer: RendererAddon.RendererOption): void {
		const term = this.#terminal
		if (!term) { return }
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
			// No default
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
	export const RENDERER_OPTIONS =
		Object.freeze(["dom", "canvas", "webgl"] as const)
	export type RendererOption = typeof RENDERER_OPTIONS[number]
}
