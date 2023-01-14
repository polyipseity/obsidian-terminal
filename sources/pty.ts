import { type ChildProcessWithoutNullStreams, spawn } from "child_process"
import { NOTICE_NO_TIMEOUT, TERMINAL_WATCHDOG_INTERVAL } from "./magic"
import {
	PLATFORM,
	anyToError,
	executeParanoidly,
	notice,
	printError,
} from "./util"
import type { Terminal } from "xterm"
import type { TerminalPlugin } from "./main"
import { promisify } from "util"
import { readFileSync } from "fs"
import resizerPy from "./resizer.py"
import { fileSync as tmpFileSync } from "tmp"

type ShellChildProcess = ChildProcessWithoutNullStreams

export interface TerminalPty {
	readonly shell: Promise<ShellChildProcess>
	readonly resizable: boolean
	readonly pipe: (terminal: Terminal) => Promise<void>
	readonly resize: (columns: number, rows: number) => Promise<void>
	readonly once: (
		event: "exit",
		listener: (code: NodeJS.Signals | number) => any,
	) => Promise<this>
}
export namespace TerminalPty {
	export const SUPPORTED_PLATFORMS = ["darwin", "linux", "win32"] as const
}

function clearTerminal(terminal: Terminal): void {
	// Clear screen with scrollback kept
	terminal.write(`${"\n\u001b[K".repeat(terminal.rows)}\u001b[H`)
}

abstract class BaseTerminalPty implements TerminalPty {
	public abstract readonly shell: Promise<ShellChildProcess>
	public abstract readonly resizable: boolean
	protected constructor(protected readonly plugin: TerminalPlugin) { }

	public abstract pipe(terminal: Terminal): Promise<void>
	public abstract resize(columns: number, rows: number): Promise<void>
	public abstract once(
		event: "exit",
		listener: (code: NodeJS.Signals | number) => any,
	): Promise<this>
}

export class ExternalTerminalPty
	extends BaseTerminalPty
	implements TerminalPty {
	public readonly shell
	public readonly resizable = false
	// It's not really a pty, isn't it?
	public constructor(
		plugin: TerminalPlugin,
		executable: string,
		cwd?: string,
		args?: readonly string[],
	) {
		super(plugin)
		this.shell =
			new Promise<ShellChildProcess>(executeParanoidly(resolve => {
				resolve(() => {
					const ret = spawn(executable, args ?? [], {
						cwd,
						detached: true,
						shell: true,
						stdio: ["pipe", "pipe", "pipe"],
					})
					ret.unref()
					return ret
				})
			}))
	}

	public async pipe(_terminal: Terminal): Promise<void> {
		return Promise.reject(new Error(this.plugin.language
			.i18n.t("errors.unsupported-operation")))
	}

	public async resize(_columns: number, _rows: number): Promise<void> {
		return Promise.reject(new Error(this.plugin.language
			.i18n.t("errors.unsupported-operation")))
	}

	public async once(
		event: "exit",
		listener: (code: NodeJS.Signals | number) => any,
	): Promise<this> {
		(await this.shell)
			.once(event, (code, signal) => void listener(code ?? signal ?? NaN))
		return this
	}
}

abstract class PtyWithResizer extends BaseTerminalPty implements TerminalPty {
	public readonly shell
	#resizable = false
	readonly #resizer = ((): ChildProcessWithoutNullStreams | null => {
		const { plugin } = this,
			{ settings, language } = plugin,
			{ pythonExecutable } = settings,
			{ i18n } = language
		if (pythonExecutable === "") {
			return null
		}
		const ret = spawn(pythonExecutable, ["-c", resizerPy], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		})
		ret
			.once("spawn", () => {
				this.#resizable = true
				const watchdog =
					plugin.registerInterval(window.setInterval(
						() => void this.#write("\n").catch(() => { }),
						TERMINAL_WATCHDOG_INTERVAL,
					)),
					clear = (): void => { window.clearInterval(watchdog) }
				try {
					ret.once("exit", clear).once("error", clear)
				} catch (error) {
					clear()
					throw error
				}
			})
			.once("exit", (code, signal) => {
				this.#resizable = false
				if (code !== 0) {
					notice(
						() => i18n.t(
							"errors.resizer-exited-unexpectedly",
							{ code: code ?? signal },
						),
						NOTICE_NO_TIMEOUT,
						plugin,
					)
				}
			})
			.once("error", error => {
				this.#resizable = false
				printError(
					error,
					() => i18n.t("errors.error-spawning-resizer"),
					plugin,
				)
			})
		ret.stderr.on("data", (chunk: Buffer | string) => {
			console.error(chunk.toString())
		})
		return ret
	})()

	readonly #write =
		promisify((
			chunk: any,
			callback: (error?: Error | null) => void,
		) => {
			const resizer = this.#resizer
			if (resizer === null) {
				callback(new Error(this.plugin.language
					.i18n.t("errors.resizer-disabled")))
				return false
			}
			try {
				return resizer.stdin.write(chunk, callback)
			} catch (error) {
				callback(anyToError(error))
			}
			return false
		})

	protected constructor(
		plugin: TerminalPlugin,
		spawnShell: (resizable: boolean) => ShellChildProcess,
	) {
		super(plugin)
		this.shell =
			new Promise<ShellChildProcess>(executeParanoidly(resolve => {
				const resizer = this.#resizer
				if (resizer === null) {
					resolve(() => spawnShell(false))
					return
				}
				const
					connect = (shell: ShellChildProcess): ShellChildProcess => shell
						.once("spawn", () => {
							const { pid } = shell
							if (typeof pid === "undefined") {
								resizer.kill()
								return
							}
							this.#write(`${pid}\n`)
								.catch(reason => {
									try {
										printError(
											reason,
											() => this.plugin.language
												.i18n.t("errors.error-spawning-resizer"),
											this.plugin,
										)
									} finally {
										resizer.kill()
									}
								})
						}),
					onSpawn = (): void => {
						try {
							resolve(() => connect(spawnShell(true)))
						} finally {
							// eslint-disable-next-line @typescript-eslint/no-use-before-define
							resizer.removeListener("error", onError)
						}
					},
					resizer0 = resizer
				function onError(): void {
					try {
						resolve(() => spawnShell(false))
					} finally {
						resizer0.removeListener("spawn", onSpawn)
					}
				}
				resizer.once("spawn", onSpawn).once("error", onError)
			}))
	}

	public get resizable(): boolean {
		return this.#resizable
	}

	public async resize(columns: number, rows: number): Promise<void> {
		return new Promise(executeParanoidly((resolve, reject) => {
			const resizer = this.#resizer
			if (resizer === null) {
				reject(() => new Error(this.plugin.language
					.i18n.t("errors.resizer-disabled")))
				return
			}
			const resizer0 = resizer,
				{ stdout } = resizer,
				data = (chunk: Buffer | string): void => {
					if (chunk.toString().includes("resized")) {
						try {
							resolve(() => { })
						} finally {
							stdout.removeListener("data", data)
							resizer
								// eslint-disable-next-line @typescript-eslint/no-use-before-define
								.removeListener("exit", exit)
								// eslint-disable-next-line @typescript-eslint/no-use-before-define
								.removeListener("error", errorFn)
						}
					}
				}
			function exit(...args: readonly any[]): void {
				try {
					reject(() => new Error(args.toString()))
				} finally {
					stdout.removeListener("data", data)
					// eslint-disable-next-line @typescript-eslint/no-use-before-define
					resizer0.removeListener("error", errorFn)
				}
			}
			function errorFn(error: Error): void {
				try {
					reject(() => error)
				} finally {
					stdout.removeListener("data", data)
					resizer0.removeListener("exit", exit)
				}
			}
			resizer.once("exit", exit).once("error", errorFn)
			stdout.on("data", data)
			this.#write(`${columns}x${rows}\n`).catch(error => {
				try {
					reject(() => anyToError(error))
				} finally {
					stdout.removeListener("data", data)
					resizer.removeListener("exit", exit).removeListener("error", errorFn)
				}
			})
		}))
	}

	public abstract override once(
		event: "exit",
		listener: (code: NodeJS.Signals | number) => any,
	): Promise<this>
}

export class WindowsTerminalPty
	extends PtyWithResizer
	implements TerminalPty {
	public readonly conhost
	readonly #exitCode

	public constructor(
		plugin: TerminalPlugin,
		executable: string,
		cwd?: string,
		args?: readonly string[],
	) {
		const conhost = plugin.settings.enableWindowsConhostWorkaround,
			codeTmp = tmpFileSync({ discardDescriptor: true })
		super(plugin, resizable => {
			const esc = WindowsTerminalPty.#escapeArgument.bind(WindowsTerminalPty),
				cmd = [
					"C:\\Windows\\System32\\cmd.exe",
					"/C",
					`${esc(executable)} ${(args ?? [])
						.map(esc)
						.join(" ")} & call echo %^ERRORLEVEL% >${esc(codeTmp.name)}`,
				]
			if (conhost) {
				cmd.unshift("C:\\Windows\\System32\\conhost.exe")
			}
			return spawn(
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				cmd.shift()!,
				cmd,
				{
					cwd,
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: !resizable,
					windowsVerbatimArguments: true,
				},
			)
		})
		this.conhost = conhost
		this.#exitCode = this.shell.then(async shell0 =>
			new Promise<NodeJS.Signals | number>(executeParanoidly((
				resolve,
				reject,
			) => {
				shell0
					.once("exit", (conCode, signal) => {
						try {
							resolve(() => {
								const termCode = parseInt(
									readFileSync(codeTmp.name, { encoding: "utf-8", flag: "r" })
										.trim(),
									10,
								)
								return isNaN(termCode) ? conCode ?? signal ?? NaN : termCode
							})
						} finally {
							codeTmp.removeCallback()
						}
					})
					.once("error", error => {
						try {
							reject(() => error)
						} finally {
							codeTmp.removeCallback()
						}
					})
			})))
	}

	static #escapeArgument(arg: string): string {
		return `"${arg.replace("\"", "\\\"")}"`
			.replace(/(?<meta>[()%!^"<>&|])/gu, "^$<meta>")

		/*
		 * Replace 1: quote argument
		 * Replace 2: escape cmd.exe metacharacters
		 */
	}

	public async once(
		_event: "exit",
		listener: (code: NodeJS.Signals | number) => any,
	): Promise<this> {
		this.#exitCode.then(listener).catch(() => { })
		return Promise.resolve(this)
	}

	public async pipe(terminal: Terminal): Promise<void> {
		const shell = await this.shell
		clearTerminal(terminal)
		shell.stdout.once("data", (chunk: Buffer | string) => {
			shell.stdout.on("data", (chunk0: Buffer | string) => {
				terminal.write(chunk0)
			})
			if (this.conhost) { return }
			terminal.write(chunk)
		})
		shell.stderr.on("data", (chunk: Buffer | string) => {
			terminal.write(chunk)
		})
		terminal.onData(data => shell.stdin.write(data))
	}
}

export class GenericTerminalPty
	extends PtyWithResizer
	implements TerminalPty {
	public constructor(
		plugin: TerminalPlugin,
		executable: string,
		cwd?: string,
		args?: readonly string[],
	) {
		super(plugin, resizable => spawn(executable, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: !resizable,
		}))
	}

	public async once(
		event: "exit",
		listener: (code: NodeJS.Signals | number) => any,
	): Promise<this> {
		(await this.shell)
			.once(event, (code, signal) => void listener(code ?? signal ?? NaN))
		return this
	}

	public async pipe(terminal: Terminal): Promise<void> {
		const shell = await this.shell
		clearTerminal(terminal)
		shell.stdout.on("data", (chunk: Buffer | string) => {
			terminal.write(chunk)
		})
		shell.stderr.on("data", (chunk: Buffer | string) => {
			terminal.write(chunk)
		})
		terminal.onData(data => shell.stdin.write(data))
	}
}

export const PLATFORM_PTY =
	PLATFORM === "win32" ? WindowsTerminalPty : GenericTerminalPty
