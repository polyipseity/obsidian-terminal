import {
	type Fixed,
	SI_PREFIX_SCALE,
	activeSelf,
	asyncDebounce,
	deepFreeze,
	dynamicRequire,
	dynamicRequireLazy,
	fixTyped,
	importable,
	launderUnchecked,
	markFixed,
} from "@polyipseity/obsidian-plugin-library"
import type {
	ITerminalInitOnlyOptions,
	ITerminalOptions,
	Terminal,
} from "@xterm/xterm"
import {
	TERMINAL_EMULATOR_RESIZE_WAIT,
	TERMINAL_PTY_RESIZE_WAIT,
} from "../magic.js"
import { noop, throttle } from "lodash-es"
import type { AsyncOrSync } from "ts-essentials"
import { BUNDLE } from "../import.js"
import type { ChildProcessByStdio } from "node:child_process"
import type { Pseudoterminal } from "./pseudoterminal.js"
import { spawnPromise } from "../util.js"
import { writePromise } from "./util.js"

const
	childProcess =
		dynamicRequire<typeof import("node:child_process")>(
			BUNDLE, "node:child_process"),
	xterm =
		dynamicRequireLazy<typeof import("@xterm/xterm")>(
			BUNDLE, "@xterm/xterm"),
	xtermAddonFit =
		dynamicRequireLazy<typeof import("@xterm/addon-fit")>(
			BUNDLE, "@xterm/addon-fit"),
	xtermAddonSerialize =
		dynamicRequireLazy<typeof import("@xterm/addon-serialize")>(
			BUNDLE, "@xterm/addon-serialize")

export const SUPPORTS_EXTERNAL_TERMINAL_EMULATOR =
	importable(BUNDLE, "node:child_process")
export async function spawnExternalTerminalEmulator(
	executable: string,
	args?: readonly string[],
	cwd?: string,
): Promise<ChildProcessByStdio<null, null, null>> {
	const childProcess2 = await childProcess,
		ret = await spawnPromise(() =>
			childProcess2.spawn(executable, args ?? [], {
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
				/* @__PURE__ */ activeSelf(this.terminal.element).console.debug(error)
			}
		})())
	}, TERMINAL_PTY_RESIZE_WAIT * SI_PREFIX_SCALE))

	#running = true

	public constructor(
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
			write = writePromise(terminal, state.data).then(() => {
				// Restore scroll position after data is written
				// If user was at bottom, restore auto-scroll behavior
				if (state.scrollLine ===
					XtermTerminalEmulator.State.SCROLL_LINE_BOTTOM) {
					terminal.scrollToBottom()
					return
				}
				// User was scrolled up - restore exact position with bounds checking
				const { active } = terminal.buffer,
					maxScrollY = Math.max(0, active.baseY - terminal.rows + 1),
					safeScrollLine =
						Math.min(Math.max(0, state.scrollLine), maxScrollY)
				terminal.scrollToLine(safeScrollLine)
			})
		}
		this.pseudoterminal = write.then(async () => {
			const pty0 = await pseudoterminal(terminal, addons0)
			await pty0.pipe(terminal)
			return pty0
		})
		this.pseudoterminal.then(async pty0 => pty0.onExit)
			.catch(noop satisfies () => unknown as () => unknown)
			.finally(() => { this.#running = false })
	}

	public async close(mustClosePseudoterminal = true): Promise<void> {
		try {
			if (this.#running) {
				await (await this.pseudoterminal).kill()
			}
		} catch (error) {
			if (mustClosePseudoterminal) { throw error }
			/* @__PURE__ */ activeSelf(this.terminal.element).console.debug(error)
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
		// Unnecessary: terminal.element?.remove()
		terminal.open(element)
	}

	public serialize(): XtermTerminalEmulator.State {
		const { active } = this.terminal.buffer
		let scrollLine = active.viewportY

		// Only consider "at bottom" if there's actually scrollable content
		// This prevents false positives in initial/empty state where baseY < rows
		const hasScrollableContent = active.baseY >= this.terminal.rows,
			isAtBottomPosition = scrollLine >= active.baseY - this.terminal.rows + 1
		if (hasScrollableContent && isAtBottomPosition) {
			scrollLine = XtermTerminalEmulator.State.SCROLL_LINE_BOTTOM
		}

		return deepFreeze({
			columns: this.terminal.cols,
			data: this.addons.serialize.serialize({
				excludeAltBuffer: true,
				excludeModes: true,
			}),
			rows: this.terminal.rows,
			scrollLine,
		})
	}
}
export namespace XtermTerminalEmulator {
	export interface State {
		readonly columns: number
		readonly rows: number
		readonly data: string
		// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
		readonly scrollLine: typeof State['SCROLL_LINE_BOTTOM'] | number
	}
	export namespace State {
		export const SCROLL_LINE_BOTTOM = -1
		export const DEFAULT: State = deepFreeze({
			columns: 1,
			data: "",
			rows: 1,
			scrollLine: SCROLL_LINE_BOTTOM,
		})
		export function fix(self0: unknown): Fixed<State> {
			const unc = launderUnchecked<State>(self0)
			return markFixed(self0, {
				columns: fixTyped(DEFAULT, unc, "columns", ["number"]),
				data: fixTyped(DEFAULT, unc, "data", ["string"]),
				rows: fixTyped(DEFAULT, unc, "rows", ["number"]),
				scrollLine: fixTyped(DEFAULT, unc, "scrollLine", ["number"]),
			})
		}
	}
}
