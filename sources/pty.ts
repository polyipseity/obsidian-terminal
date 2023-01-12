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
			const watchdog =
				this.plugin.registerInterval(window.setInterval(
					() => void this.#write("\n").catch(() => { }),
					TERMINAL_WATCHDOG_INTERVAL,
				)),
				clear = (): void => { window.clearInterval(watchdog) }
			try {
				this.#resizer.once("exit", clear).once("error", clear)
			} catch (error) {
				clear()
				throw error
			}
		})
		.once("exit", () => void (this.#resizable = false))
		.once("error", error => {
			this.#resizable = false
			printError(error, () => this.plugin.i18n.t("errors.error-spawning-resizer"), this.plugin)
		})

	readonly #write =
		promisify((
			chunk: any,
			callback: (error?: Error | null) => void,
		) => {
			try {
				return this.#resizer.stdin.write(chunk, callback)
			} catch (error) {
				if (error instanceof Error) {
					callback(error)
				} else {
					callback(new Error(String(error)))
				}
			}
			return false
		})

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
			.once("exit", () => this.#resizer.kill())
			.once("error", () => this.#resizer.kill())
	}

	public get resizable(): boolean {
		return this.#resizable
	}

	public async resize(columns: number, rows: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const resizer = this.#resizer,
				{ stdout } = resizer,
				data = (chunk: Buffer | string): void => {
					if (chunk.toString().includes("resized")) {
						try {
							resolve()
						} finally {
							stdout.removeListener("data", data)
							// eslint-disable-next-line @typescript-eslint/no-use-before-define
							resizer.removeListener("exit", exit).removeListener("error", errorFn)
						}
					}
				}
			function exit(...args: any[]): void {
				try {
					reject(new Error(args.toString()))
				} catch (error) {
					reject(error)
				} finally {
					stdout.removeListener("data", data)
					// eslint-disable-next-line @typescript-eslint/no-use-before-define
					resizer.removeListener("error", errorFn)
				}
			}
			function errorFn(error: Error): void {
				try {
					reject(error)
				} finally {
					stdout.removeListener("data", data)
					resizer.removeListener("exit", exit)
				}
			}
			resizer.once("exit", exit).once("error", errorFn)
			stdout.on("data", data)
			this.#write(`${columns}x${rows}\n`).catch(error => {
				try {
					reject(error)
				} finally {
					stdout.removeListener("data", data)
					resizer.removeListener("exit", exit).removeListener("error", errorFn)
				}
			})
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
		const esc = WindowsTerminalPty.#escapeArgument.bind(WindowsTerminalPty),
			args0 = args ?? [],
			codeTmp = tmpFileSync({ discardDescriptor: true }),
			shell = spawn("C:\\Windows\\System32\\conhost.exe", [
				"C:\\Windows\\System32\\cmd.exe",
				"/C",
				`${esc(executable)} ${args0.map(esc).join(" ")} & call echo %^ERRORLEVEL% >${esc(codeTmp.name)}`,
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

	static #escapeArgument(arg: string): string {
		return `"${arg.replace(/(?<meta>[()%!^"<>&|])/gu, "^$<meta>")}"`
	}

	public once(_0: "exit", listener: (code: NodeJS.Signals | number) => any): this {
		this.#exitCode.then(listener).catch(() => { })
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
		super(plugin, spawn(executable, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: false,
		}))
	}

	public once(event: "exit", listener: (code: NodeJS.Signals | number) => any): this {
		this.shell.once(event, (code, signal) =>
			void listener(code ?? signal ?? NaN))
		return this
	}
}
