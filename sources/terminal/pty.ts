import { NOTICE_NO_TIMEOUT, TERMINAL_RESIZER_WATCHDOG_INTERVAL } from "../magic"
import {
	PLATFORM,
	anyToError,
	executeParanoidly,
	importIfDesktop,
	inSet,
	notice,
	printError,
	spawnPromise,
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
	readonly exit: Promise<NodeJS.Signals | number>
	readonly pipe: (terminal: Terminal) => Promise<void>
	readonly resize: (columns: number, rows: number) => Promise<void>
}

function clearTerminal(terminal: Terminal): void {
	// Clear screen with scrollback kept
	terminal.write(`${"\n\u001b[K".repeat(terminal.rows)}\u001b[H`)
}

class WindowsTerminalPty implements TerminalPty {
	public readonly shell
	public readonly conhost
	public readonly exit
	readonly #resizer = (async (): Promise<PipedChildProcess | null> => {
		const { plugin } = this,
			{ settings, language } = plugin,
			{ pythonExecutable } = settings,
			{ i18n } = language
		if (pythonExecutable === "") {
			return null
		}
		return spawnPromise(async () =>
			(await childProcess).spawn(pythonExecutable, ["-c", win32ResizerPy], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			}))
			.then(ret => {
				try {
					try {
						ret.stderr.on("data", (chunk: Buffer | string) => {
							console.error(chunk.toString())
						})
					} finally {
						ret.once("exit", (code, signal) => {
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
					}
				} catch (error) {
					void error
				}
				return ret
			})
	})()

	public constructor(
		protected readonly plugin: TerminalPlugin,
		executable: string,
		cwd?: string,
		args?: readonly string[],
	) {
		this.conhost = plugin.settings.enableWindowsConhostWorkaround
		const shell = this.#resizer.catch(() => null)
			.then(async resizer => {
				try {
					const codeTmp = (await tmp).fileSync({ discardDescriptor: true })
					try {
						const cmd = [
							"C:\\Windows\\System32\\cmd.exe",
							"/C",
							`${WindowsTerminalPty.#escapeArgument(executable)} ${(args ?? [])
								.map(arg => WindowsTerminalPty.#escapeArgument(arg))
								.join(" ")
							} & call echo %^ERRORLEVEL% >${WindowsTerminalPty
								.#escapeArgument(codeTmp.name)}`,
						]
						if (this.conhost) {
							cmd.unshift("C:\\Windows\\System32\\conhost.exe")
						}
						return [
							resizer,
							codeTmp,
							await spawnPromise(async () => (await childProcess).spawn(
								// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
								cmd.shift()!,
								cmd,
								{
									cwd,
									stdio: ["pipe", "pipe", "pipe"],
									windowsHide: resizer === null,
									windowsVerbatimArguments: true,
								},
							)),
						] as const
					} catch (error) {
						codeTmp.removeCallback()
						throw error
					}
				} catch (error) {
					resizer?.kill()
					throw error
				}
			})
			.then(async ([resizer, codeTmp, shell0]) => {
				try {
					if (resizer !== null) {
						try {
							await WindowsTerminalPty.#resize(resizer, `${shell0.pid ?? -1}`)
							const watchdog = window.setInterval(
								() => {
									WindowsTerminalPty.#resize(resizer, "\n").catch(() => { })
								},
								TERMINAL_RESIZER_WATCHDOG_INTERVAL,
							)
							try {
								resizer.once("exit", () => { window.clearInterval(watchdog) })
							} catch (error) {
								window.clearInterval(watchdog)
								throw error
							}
						} catch (error) {
							try {
								printError(
									error,
									() => this.plugin.language
										.i18n.t("errors.error-spawning-resizer"),
									this.plugin,
								)
							} finally {
								resizer.kill()
							}
						}
					}
				} catch (error) { void error }
				return [shell0, codeTmp] as const
			})
		this.shell = shell.then(([shell0]) => shell0)
		this.exit = shell
			.then(async ([shell0, codeTmp]) =>
				new Promise<NodeJS.Signals | number>(executeParanoidly(resolve =>
					shell0.once("exit", (conCode, signal) => {
						(async (): Promise<void> => {
							try {
								const termCode = parseInt(
									(await fs).readFileSync(
										codeTmp.name,
										{ encoding: "utf-8", flag: "r" },
									).trim(),
									10,
								)
								resolve(isNaN(termCode) ? conCode ?? signal ?? NaN : termCode)
							} catch {
								resolve(conCode ?? signal ?? NaN)
							} finally {
								codeTmp.removeCallback()
							}
						})().catch(() => { })
					}))))
	}

	static async #resize(
		resizer: PipedChildProcess,
		chunk: Buffer | string,
	): Promise<void> {
		const { stdin } = resizer
		return new Promise<void>(executeParanoidly((resolve, reject) => {
			const written = stdin.write(chunk, error => {
				if (error) { reject(error) } else if (written) { resolve() }
			})
			if (!written) { stdin.once("drain", () => { resolve() }) }
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
		const resizer = await this.#resizer
		if (resizer === null) {
			throw new Error(this.plugin.language.i18n.t("errors.resizer-disabled"))
		}
		await WindowsTerminalPty.#resize(resizer, `${columns}x${rows}\n`)
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
	public readonly exit

	public constructor(
		protected readonly plugin: TerminalPlugin,
		executable: string,
		cwd?: string,
		args?: readonly string[],
	) {
		const { settings, language } = plugin,
			{ pythonExecutable } = settings
		this.shell = spawnPromise(async () => {
			if (pythonExecutable === "") {
				throw new Error(language
					.i18n.t("errors.no-python-to-start-unix-pseudoterminal"))
			}
			return (await childProcess).spawn(
				pythonExecutable,
				["-c", unixPtyPy, executable].concat(args ?? []),
				{
					cwd,
					stdio: ["pipe", "pipe", "pipe", "pipe"],
					windowsHide: true,
				},
			)
		}).then(ret => {
			try {
				ret.stderr.on("data", (chunk: Buffer | string) => {
					console.error(chunk.toString())
				})
			} catch (error) { void error }
			return ret
		})
		this.exit = this.shell
			.then(async shell =>
				new Promise<NodeJS.Signals | number>(executeParanoidly(resolve =>
					shell.once("exit", (code, signal) => {
						resolve(code ?? signal ?? NaN)
					}))))
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
