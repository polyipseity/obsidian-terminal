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
		const childProcess0 = await childProcess,
			ret = childProcess0
				.spawn(pythonExecutable, ["-c", win32ResizerPy], {
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				}),
			op = new Promise<PipedChildProcess>(executeParanoidly((
				resolve,
				reject,
			) => {
				ret
					.once("spawn", () => { resolve(() => ret) })
					.once("error", error => { reject(() => error) })
			}))
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
		ret.stderr.on("data", (chunk: Buffer | string) => {
			console.error(chunk.toString())
		})
		return op
	})()

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
		this.shell = this.#resizer.then(async resizer0 => {
			if (resizer0 === null) {
				return spawnShell(false)
			}
			const ret = await spawnShell(true)
			try {
				await WindowsTerminalPty.#resize(resizer0, `${ret.pid ?? -1}`)
				const watchdog = window.setInterval(
					() => {
						WindowsTerminalPty.#resize(resizer0, "\n").catch(() => { })
					},
					TERMINAL_RESIZER_WATCHDOG_INTERVAL,
				)
				try {
					resizer0.once("close", () => { window.clearInterval(watchdog) })
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
					resizer0.kill()
				}
			}
			return ret
		}, async () => spawnShell(false))
		this.exit = this.shell
			.then(async shell0 => {
				const codeTmp0 = await codeTmp
				return new Promise<NodeJS.Signals | number>(executeParanoidly((
					resolve,
					reject,
				) => shell0
					.once("exit", (conCode, signal) => {
						resolve(async () => {
							const termCode = parseInt(
								(await fs).readFileSync(
									codeTmp0.name,
									{ encoding: "utf-8", flag: "r" },
								).trim(),
								10,
							)
							return isNaN(termCode) ? conCode ?? signal ?? NaN : termCode
						})
					}).once("error", error => { reject(() => error) })))
					.finally(() => {
						try { codeTmp0.removeCallback() } catch (error) { void error }
					})
			})
	}

	static async #resize(
		resizer: PipedChildProcess,
		chunk: Buffer | string,
	): Promise<void> {
		const { stdin } = resizer
		return new Promise<void>(executeParanoidly((resolve, reject) => {
			const written = stdin.write(chunk, error => {
				if (error) {
					reject(() => error)
				} else if (written) { resolve(() => { }) }
			})
			if (!written) { stdin.once("drain", () => { resolve(() => { }) }) }
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
		this.exit = this.shell
			.then(async shell =>
				new Promise<NodeJS.Signals | number>(executeParanoidly((
					resolve,
					reject,
				) => {
					shell.once(
						"exit",
						(code, signal) => { resolve(() => code ?? signal ?? NaN) },
					).once("error", error => { reject(() => error) })
				})))
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
