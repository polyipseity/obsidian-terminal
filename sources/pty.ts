import { type ChildProcessWithoutNullStreams, spawn } from "child_process"
import { NOTICE_NO_TIMEOUT, TERMINAL_RESIZER_WATCHDOG_INTERVAL } from "./magic"
import {
	PLATFORM,
	anyToError,
	executeParanoidly,
	inSet,
	notice,
	printError,
} from "./util"
import type { Terminal } from "xterm"
import type { TerminalPlugin } from "./main"
import type { Writable } from "stream"
import { promisify } from "util"
import { readFileSync } from "fs"
import { fileSync as tmpFileSync } from "tmp"
import unixPtyPy from "./unix_pty.py"
import win32ResizerPy from "./win32_resizer.py"

export interface TerminalPty {
	readonly shell: Promise<ChildProcessWithoutNullStreams>
	readonly pipe: (terminal: Terminal) => Promise<void>
	readonly resize: (columns: number, rows: number) => Promise<void>
	readonly once: (
		event: "exit",
		listener: (code: NodeJS.Signals | number) => any,
	) => Promise<this>
}

function clearTerminal(terminal: Terminal): void {
	// Clear screen with scrollback kept
	terminal.write(`${"\n\u001b[K".repeat(terminal.rows)}\u001b[H`)
}

abstract class BaseTerminalPty implements TerminalPty {
	public abstract readonly shell: Promise<ChildProcessWithoutNullStreams>
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
	// It's not really a pty, isn't it?
	public constructor(
		plugin: TerminalPlugin,
		executable: string,
		cwd?: string,
		args?: readonly string[],
	) {
		super(plugin)
		this.shell =
			new Promise<ChildProcessWithoutNullStreams>(executeParanoidly(resolve => {
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

abstract class WindowsTerminalPty
	extends BaseTerminalPty
	implements TerminalPty {
	public readonly shell
	public readonly conhost
	readonly #exitCode
	readonly #resizer = ((): ChildProcessWithoutNullStreams | null => {
		const { plugin } = this,
			{ settings, language } = plugin,
			{ pythonExecutable } = settings,
			{ i18n } = language
		if (pythonExecutable === "") {
			return null
		}
		const ret = spawn(pythonExecutable, ["-c", win32ResizerPy], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		})
			.once("exit", (code, signal) => {
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

	readonly #writeResizer =
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

	public constructor(
		plugin: TerminalPlugin,
		executable: string,
		cwd?: string,
		args?: readonly string[],
	) {
		super(plugin)
		this.conhost = plugin.settings.enableWindowsConhostWorkaround
		const
			codeTmp = tmpFileSync({ discardDescriptor: true }),
			spawnShell = (resizable: boolean): ChildProcessWithoutNullStreams => {
				const cmd = [
					"C:\\Windows\\System32\\cmd.exe",
					"/C",
					`${WindowsTerminalPty.#escapeArgument(executable)} ${(args ?? [])
						.map(arg => WindowsTerminalPty.#escapeArgument(arg))
						.join(" ")
					} & call echo %^ERRORLEVEL% >${WindowsTerminalPty
						.#escapeArgument(codeTmp.name)}`,
				]
				if (this.conhost) { cmd.unshift("C:\\Windows\\System32\\conhost.exe") }
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
			}
		this.shell =
			new Promise<ChildProcessWithoutNullStreams>(executeParanoidly(resolve => {
				const resizer = this.#resizer
				if (resizer === null) {
					resolve(() => spawnShell(false))
					return
				}
				const
					onSpawn = (): void => {
						try {
							resolve(() => {
								const ret = spawnShell(true)
								this.#writeResizer(`${ret.pid ?? -1}\n`)
									.then(() => {
										const watchdog =
											plugin.registerInterval(window.setInterval(
												() => void this.#writeResizer("\n").catch(() => { }),
												TERMINAL_RESIZER_WATCHDOG_INTERVAL,
											)),
											clear = (): void => { window.clearInterval(watchdog) }
										resizer.once("exit", clear).once("error", clear)
									})
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
								return ret
							})
						} finally {
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
		this.#exitCode = this.shell
			.then(async shell0 =>
				new Promise<NodeJS.Signals | number>(executeParanoidly((
					resolve,
					reject,
				) => shell0.once("exit", (conCode, signal) => {
					resolve(() => {
						const termCode = parseInt(
							readFileSync(codeTmp.name, { encoding: "utf-8", flag: "r" })
								.trim(),
							10,
						)
						return isNaN(termCode) ? conCode ?? signal ?? NaN : termCode
					})
				}).once("error", error => { reject(() => error) }))))
			.finally(codeTmp.removeCallback.bind(codeTmp))
	}

	static #escapeArgument(arg: string): string {
		return `"${arg.replace("\"", "\\\"")}"`
			.replace(/(?<meta>[()%!^"<>&|])/gu, "^$<meta>")

		/*
		 * Replace 1: quote argument
		 * Replace 2: escape cmd.exe metacharacters
		 */
	}

	public async resize(columns: number, rows: number): Promise<void> {
		return new Promise(executeParanoidly((resolve, reject) => {
			const resizer = this.#resizer
			if (resizer === null) {
				reject(() => new Error(this.plugin.language
					.i18n.t("errors.resizer-disabled")))
				return
			}
			const
				exitFn = (...args: readonly any[]): void => {
					reject(() => new Error(args.toString()))
				},
				errorFn = (error: Error): void => { reject(() => error) }
			resizer.once("exit", exitFn).once("error", errorFn)
			this.#writeResizer(`${columns}x${rows}\n`)
				.then(
					() => { resolve(() => { }) },
					error => { reject(() => anyToError(error)) },
				)
				.finally(() => void resizer
					.removeListener("exit", exitFn)
					.removeListener("error", errorFn))
		}))
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

export class UnixTerminalPty
	extends BaseTerminalPty
	implements TerminalPty {
	public readonly shell

	public constructor(
		plugin: TerminalPlugin,
		executable: string,
		cwd?: string,
		args?: readonly string[],
	) {
		super(plugin)
		try {
			const { settings, language } = plugin,
				{ pythonExecutable } = settings
			if (pythonExecutable === "") {
				throw new Error(language
					.i18n.t("errors.no-python-to-start-unix-pseudoterminal"))
			}
			const shell = spawn(
				pythonExecutable,
				["-c", unixPtyPy, executable].concat(args ?? []),
				{
					cwd,
					stdio: ["pipe", "pipe", "pipe", "pipe"],
					windowsHide: true,
				},
			)
			shell.stderr.on("data", (chunk: Buffer | string) => {
				console.error(chunk.toString())
			})
			this.shell = Promise.resolve(shell)
		} catch (error) {
			this.shell = Promise.reject(error)
		}
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

	public async resize(columns: number, rows: number): Promise<void> {
		const CMDIO = 3,
			shell = await this.shell,
			cmdio = shell.stdio[CMDIO] as Writable
		await promisify((
			chunk: any,
			callback: (error?: Error | null) => void,
		) => {
			try {
				return cmdio.write(chunk, callback)
			} catch (error) {
				callback(anyToError(error))
			}
			return false
		})(`${columns}x${rows}\n`)
	}
}

export namespace TerminalPty {
	export const PLATFORM_PTYS = {
		darwin: UnixTerminalPty,
		linux: UnixTerminalPty,
		win32: WindowsTerminalPty,
	} as const
	export const SUPPORTED_PLATFORMS =
		Object.keys(PLATFORM_PTYS) as readonly (keyof typeof PLATFORM_PTYS)[]
	export const PLATFORM_PTY =
		inSet(SUPPORTED_PLATFORMS, PLATFORM) ? PLATFORM_PTYS[PLATFORM] : null
}
