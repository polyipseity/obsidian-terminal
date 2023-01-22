import { NOTICE_NO_TIMEOUT, TERMINAL_RESIZER_WATCHDOG_INTERVAL } from "../magic"
import {
	PLATFORM,
	anyToError,
	executeParanoidly,
	importIfDesktop,
	inSet,
	notice,
	printError,
	typedKeys,
} from "../util"
import type {
	ChildProcessWithoutNullStreams as PipedChildProcess,
} from "node:child_process"
import type { Terminal } from "xterm"
import type { TerminalPlugin } from "../main"
import type { Writable } from "node:stream"
import unixPtyPy from "./unix_pty.py"
import win32ResizerPy from "./win32_resizer.py"

const
	childProcess =
		importIfDesktop<typeof import("node:child_process")>("node:child_process"),
	fs = importIfDesktop<typeof import("node:fs")>("node:fs"),
	tmp = importIfDesktop<typeof import("tmp")>("tmp"),
	util = importIfDesktop<typeof import("node:util")>("node:util")

export interface TerminalPty {
	readonly shell: Promise<PipedChildProcess>
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

export class ExternalTerminalPty implements TerminalPty {
	public readonly shell
	// It's not really a pty, isn't it?
	public constructor(
		protected readonly plugin: TerminalPlugin,
		executable: string,
		cwd?: string,
		args?: readonly string[],
	) {
		this.shell =
			new Promise<PipedChildProcess>(executeParanoidly(resolve => {
				resolve(async () => {
					const ret = (await childProcess).spawn(executable, args ?? [], {
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

class WindowsTerminalPty implements TerminalPty {
	public readonly shell
	public readonly conhost
	readonly #exitCode
	readonly #resizer = ((): Promise<PipedChildProcess> | null => {
		const { plugin } = this,
			{ settings, language } = plugin,
			{ pythonExecutable } = settings,
			{ i18n } = language
		if (pythonExecutable === "") {
			return null
		}
		return childProcess
			.then(childProcess0 => {
				const ret = childProcess0
					.spawn(pythonExecutable, ["-c", win32ResizerPy], {
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
			})
	})()

	readonly #writeResizer = util
		.then(async util0 => {
			const resizer = await this.#resizer
			return util0.promisify((
				chunk: any,
				callback: (error?: Error | null) => void,
			) => {
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
		})

	public constructor(
		protected readonly plugin: TerminalPlugin,
		executable: string,
		cwd?: string,
		args?: readonly string[],
	) {
		this.conhost = plugin.settings.enableWindowsConhostWorkaround
		const
			codeTmp = tmp.then(tmp0 => tmp0.fileSync({ discardDescriptor: true })),
			spawnShell = async (resizable: boolean): Promise<PipedChildProcess> => {
				const cmd = [
					"C:\\Windows\\System32\\cmd.exe",
					"/C",
					`${WindowsTerminalPty.#escapeArgument(executable)} ${(args ?? [])
						.map(arg => WindowsTerminalPty.#escapeArgument(arg))
						.join(" ")
					} & call echo %^ERRORLEVEL% >${WindowsTerminalPty
						.#escapeArgument((await codeTmp).name)}`,
				]
				if (this.conhost) { cmd.unshift("C:\\Windows\\System32\\conhost.exe") }
				return (await childProcess).spawn(
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
			new Promise<PipedChildProcess>(executeParanoidly((resolve, reject) => {
				const resizer = this.#resizer
				if (resizer === null) {
					resolve(async () => spawnShell(false))
					return
				}
				resizer.then(resizer0 => {
					const
						onSpawn = (): void => {
							try {
								resolve(async () => {
									const ret = await spawnShell(true);
									(await this.#writeResizer)(`${ret.pid ?? -1}\n`)
										.then(() => {
											const watchdog =
												plugin.registerInterval(window.setInterval(
													() => {
														this.#writeResizer
															.then(async writeResizer => writeResizer("\n"))
															.catch(() => { })
													},
													TERMINAL_RESIZER_WATCHDOG_INTERVAL,
												)),
												clear = (): void => { window.clearInterval(watchdog) }
											resizer0.once("exit", clear).once("error", clear)
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
												resizer0.kill()
											}
										})
									return ret
								})
							} finally {
								resizer0.removeListener("error", onError)
							}
						}
					function onError(): void {
						try {
							resolve(async () => spawnShell(false))
						} finally {
							resizer0.removeListener("spawn", onSpawn)
						}
					}
					resizer0.once("spawn", onSpawn).once("error", onError)
				}).catch(reject)
			}))
		this.#exitCode = this.shell
			.then(async shell0 =>
				new Promise<NodeJS.Signals | number>(executeParanoidly((
					resolve,
					reject,
				) => shell0.once("exit", (conCode, signal) => {
					resolve(async () => {
						const termCode = parseInt(
							(await fs).readFileSync(
								(await codeTmp).name,
								{ encoding: "utf-8", flag: "r" },
							).trim(),
							10,
						)
						return isNaN(termCode) ? conCode ?? signal ?? NaN : termCode
					})
				}).once("error", error => { reject(() => error) }))))
			.finally(() => void codeTmp.then(codeTmp0 => {
				codeTmp0.removeCallback()
			}))
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
			resizer.then(async resizer0 => {
				const
					exitFn = (...args: readonly any[]): void => {
						reject(() => new Error(args.toString()))
					},
					errorFn = (error: Error): void => { reject(() => error) }
				resizer0.once("exit", exitFn).once("error", errorFn);
				(await this.#writeResizer)(`${columns}x${rows}\n`)
					.then(
						() => { resolve(() => { }) },
						error => { reject(() => anyToError(error)) },
					)
					.finally(() => void resizer0
						.removeListener("exit", exitFn)
						.removeListener("error", errorFn))
			}).catch(reject)
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

class UnixTerminalPty implements TerminalPty {
	public readonly shell

	public constructor(
		protected readonly plugin: TerminalPlugin,
		executable: string,
		cwd?: string,
		args?: readonly string[],
	) {
		const { settings, language } = plugin,
			{ pythonExecutable } = settings
		this.shell = childProcess
			.then(childProcess0 => {
				if (pythonExecutable === "") {
					throw new Error(language
						.i18n.t("errors.no-python-to-start-unix-pseudoterminal"))
				}
				const shell = childProcess0.spawn(
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
				return shell
			})
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
		await (await util).promisify((
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
	export const SUPPORTED_PLATFORMS = typedKeys(PLATFORM_PTYS)
	export const PLATFORM_PTY =
		inSet(SUPPORTED_PLATFORMS, PLATFORM) ? PLATFORM_PTYS[PLATFORM] : null
}
