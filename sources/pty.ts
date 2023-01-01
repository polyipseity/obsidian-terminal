import { type ChildProcessWithoutNullStreams, spawn } from "child_process"
import { TERMINAL_WATCHDOG_INTERVAL } from "./magic"
import type { TerminalPlugin } from "./main"
import { printError } from "./util"
import { promisify } from "util"
import { readFileSync } from "fs"
import resizerPy from "./resizer.py"
import { fileSync as tmpFileSync } from "tmp"

export interface TerminalPty {
	readonly shell: ChildProcessWithoutNullStreams
	readonly resizable: boolean
	readonly resize: (columns: number, rows: number) => Promise<void>
	readonly once: (event: "exit", listener: (code: NodeJS.Signals | number) => any) => this
}
// eslint-disable-next-line @typescript-eslint/no-redeclare, @typescript-eslint/naming-convention
export declare const TerminalPty: new (
	plugin: TerminalPlugin,
	executable: string,
	cwd?: string,
	args?: string[],
) => TerminalPty

abstract class BaseTerminalPty implements TerminalPty {
	public abstract readonly shell: ChildProcessWithoutNullStreams
	public abstract readonly resizable: boolean
	protected constructor(protected readonly plugin: TerminalPlugin) { }
	public abstract resize(columns: number, rows: number): Promise<void>
	public abstract once(event: "exit", listener: (code: NodeJS.Signals | number) => any): this
}

abstract class PtyWithResizer extends BaseTerminalPty implements TerminalPty {
	#resizable = false
	readonly #resizer = spawn("python", ["-c", resizerPy], {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	})
		.once("spawn", () => {
			this.#resizable = true
			const watchdog = this.plugin.registerInterval(window.setInterval(() => {
				void this.#write("\n").catch(() => { })
			}, TERMINAL_WATCHDOG_INTERVAL))
			try {
				this.#resizer.once("exit", () => { window.clearInterval(watchdog) })
			} catch (err) {
				window.clearInterval(watchdog)
				throw err
			}
		})
		.once("error", error => {
			this.#resizable = false
			printError(error, () => this.plugin.i18n.t("errors.error-spawning-resizer"), this.plugin)
		})
		.once("exit", () => { this.#resizable = false })

	readonly #write =
		promisify((
			chunk: any,
			callback: (error?: Error | null) => void,
		) => this.#resizer.stdin.write(chunk, callback))

	protected constructor(
		plugin: TerminalPlugin,
		public readonly shell: ChildProcessWithoutNullStreams,
	) {
		super(plugin)
		shell
			.once("spawn", () => {
				const { pid } = shell
				if (typeof pid === "undefined") {
					this.#resizer.kill()
					return
				}
				this.#write(`${pid}\n`)
					.catch(reason => {
						this.#resizer.kill()
						printError(reason, () => this.plugin.i18n.t("errors.error-spawning-resizer"), this.plugin)
					})
			})
			.once("error", () => { this.#resizer.kill() })
			.once("exit", () => { this.#resizer.kill() })
	}

	public get resizable(): boolean {
		return this.#resizable
	}

	public async resize(columns: number, rows: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const { stdout } = this.#resizer,
				data = (chunk: Buffer | string): void => {
					if (chunk.toString().includes("resized")) {
						try {
							resolve()
						} finally {
							stdout.removeListener("data", data)
						}
					}
				}
			this.#resizer.once("error", error => {
				try {
					reject(error)
				} finally {
					stdout.removeListener("data", data)
				}
			})
			stdout.on("data", data)
			void this.#write(`${columns}x${rows}\n`)
		})
	}

	public abstract override once(event: "exit", listener: (code: NodeJS.Signals | number) => any): this
}

export class WindowsTerminalPty
	extends PtyWithResizer
	implements TerminalPty {
	readonly #codeTmp
	readonly #exitCode

	public constructor(
		plugin: TerminalPlugin,
		executable: string,
		cwd?: string,
		args?: string[],
	) {
		const args0 = args ?? [],
			codeTmp = tmpFileSync({ discardDescriptor: true }),
			shell = spawn("C:\\Windows\\System32\\conhost.exe", [
				"C:\\Windows\\System32\\cmd.exe",
				"/C",
				`"${executable}" ${args0.map(arg => `"${arg}"`).join(" ")} & call echo %^ERRORLEVEL% >"${codeTmp.name}"`,
			], {
				cwd,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: false,
				windowsVerbatimArguments: true,
			}),
			exitCode = new Promise<NodeJS.Signals | number>((resolve, reject) => {
				shell
					.once("exit", (conCode, signal) => {
						try {
							const termCode =
								parseInt(
									readFileSync(this.#codeTmp.name, { encoding: "utf-8", flag: "r" }).trim(),
									10,
								)
							resolve(isNaN(termCode) ? conCode ?? signal ?? NaN : termCode)
						} catch (error) {
							reject(error)
						} finally {
							this.#codeTmp.removeCallback()
						}
					})
					.once("error", error => {
						try {
							reject(error)
						} finally {
							this.#codeTmp.removeCallback()
						}
					})
			})
		super(plugin, shell)
		this.#codeTmp = codeTmp
		this.#exitCode = exitCode
	}

	public once(_0: "exit", listener: (code: NodeJS.Signals | number) => any): this {
		void this.#exitCode.then(listener)
		return this
	}
}

export class GenericTerminalPty
	extends PtyWithResizer
	implements TerminalPty {
	public constructor(
		plugin: TerminalPlugin,
		executable: string,
		cwd?: string,
		args?: string[],
	) {
		const shell = spawn(executable, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: false,
		})
		super(plugin, shell)
	}

	public once(event: "exit", listener: (code: NodeJS.Signals | number) => any): this {
		this.shell.once(event, (code, signal) => {
			listener(code ?? signal ?? NaN)
		})
		return this
	}
}
