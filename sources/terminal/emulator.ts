import {
	type ITerminalInitOnlyOptions,
	type ITerminalOptions,
	Terminal,
} from "xterm"
import { executeParanoidly, spawnPromise } from "sources/util"
import type { ChildProcessByStdio } from "node:child_process"
import { FitAddon } from "xterm-addon-fit"
import { SerializeAddon } from "xterm-addon-serialize"
import { TERMINAL_RESIZE_TIMEOUT } from "sources/magic"
import type TerminalPlugin from "sources/main"
import type { TerminalPty } from "./pty"
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
	public readonly addons: A & {
		readonly fit: FitAddon
		readonly serialize: SerializeAddon
	}

	public readonly exit: Promise<NodeJS.Signals | number>
	readonly #pty: Promise<TerminalPty>
	#exited = false
	#resizePromises: {
		resolve: () => void
		reject: (reason?: unknown) => void
	}[] = []

	readonly #resize = debounce(async (
		columns: number,
		rows: number,
	) => {
		const promises = this.#resizePromises
		this.#resizePromises = []
		try {
			await (await this.#pty).resize(columns, rows)
			this.terminal.resize(columns, rows)
			promises.forEach(promise => { promise.resolve() })
		} catch (error) {
			promises.forEach(promise => { promise.reject(error) })
		}
	}, TERMINAL_RESIZE_TIMEOUT, false)

	public constructor(
		protected readonly plugin: TerminalPlugin,
		element: HTMLElement,
		pty: () => PromiseLike<TerminalPty> | TerminalPty,
		state?: XtermTerminalEmulator.State,
		options?: ITerminalInitOnlyOptions & ITerminalOptions,
		addons?: A,
	) {
		this.terminal = new Terminal(options)
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
			.then(pty)
			.then(async pty0 => {
				await pty0.pipe(this.terminal)
				return pty0
			})
		this.exit = this.#pty.then(async pty0 => pty0.exit)
			.finally(() => void (this.#exited = true))
		this.terminal.open(element)
	}

	public async close(): Promise<void> {
		return this.#pty.then(async pty => pty.shell).then(shell => {
			if (this.#exited || shell.kill()) {
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
		const op = new Promise<void>(executeParanoidly((resolve, reject) => {
			this.#resizePromises.push({ reject, resolve })
			this.#resize(dim.cols, dim.rows)
		}))
		fit.fit()
		await op
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
