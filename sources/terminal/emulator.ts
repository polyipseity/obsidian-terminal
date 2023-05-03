import { type Fixed, fixTyped, markFixed } from "sources/ui/fixers"
import type {
	ITerminalInitOnlyOptions,
	ITerminalOptions,
	Terminal,
} from "xterm"
import {
	SI_PREFIX_SCALE,
	TERMINAL_EMULATOR_RESIZE_WAIT,
	TERMINAL_PTY_RESIZE_WAIT,
} from "../magic"
import { asyncDebounce, deepFreeze, spawnPromise } from "../utils/util"
import { dynamicRequire, dynamicRequireLazy, importable } from "../imports"
import type { AsyncOrSync } from "ts-essentials"
import type { ChildProcessByStdio } from "node:child_process"
import type { Pseudoterminal } from "./pseudoterminal"
import type { TerminalPlugin } from "../main"
import { launderUnchecked } from "sources/utils/types"
import { throttle } from "lodash-es"
import { writePromise } from "./util"

const
	childProcess =
		dynamicRequire<typeof import("node:child_process")>("node:child_process"),
	xterm = dynamicRequireLazy<typeof import("xterm")>("xterm"),
	xtermAddonFit =
		dynamicRequireLazy<typeof import("xterm-addon-fit")>("xterm-addon-fit"),
	xtermAddonSerialize =
		dynamicRequireLazy<typeof import("xterm-addon-serialize")>(
			"xterm-addon-serialize")

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
	try { ret.unref() } catch (error) { self.console.warn(error) }
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
				self.console.debug(error)
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
		this.terminal = new xterm.Terminal(options)
		const { terminal } = this
		terminal.open(element)
		// eslint-disable-next-line prefer-object-spread
		const addons0 = Object.assign({
			fit: new xtermAddonFit.FitAddon(),
			serialize: new xtermAddonSerialize.SerializeAddon(),
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
			self.console.debug(error)
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
		})
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
