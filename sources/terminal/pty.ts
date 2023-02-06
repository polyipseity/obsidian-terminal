import { DEFAULT_ENCODING, TERMINAL_RESIZER_WATCHDOG_INTERVAL } from "../magic"
import {
	PLATFORM,
	anyToError,
	deepFreeze,
	executeParanoidly,
	inSet,
	notice2,
	printError,
	spawnPromise,
	typedKeys,
	writePromise,
} from "../utils/util"
import type { FileResultNoFd } from "tmp"
import type {
	ChildProcessWithoutNullStreams as PipedChildProcess,
} from "node:child_process"
import type { Terminal } from "xterm"
import type { TerminalPlugin } from "../main"
import type { Writable } from "node:stream"
import { dynamicRequire } from "../bundle"
import unixPtyPy from "./unix_pty.py"
import win32ResizerPy from "./win32_resizer.py"

const
	childProcess =
		dynamicRequire<typeof import("node:child_process")>("node:child_process"),
	fs = dynamicRequire<typeof import("node:fs")>("node:fs"),
	process = dynamicRequire<typeof import("node:process")>("node:process"),
	tmp = dynamicRequire<typeof import("tmp")>("tmp")

export interface TerminalPty {
	readonly shell: Promise<PipedChildProcess>
	readonly onExit: Promise<NodeJS.Signals | number>
	readonly pipe: (terminal: Terminal) => Promise<void>
	readonly resize: (columns: number, rows: number) => Promise<void>
}

function clearTerminal(terminal: Terminal): void {
	// Clear screen with scrollback kept
	terminal.write(`${"\u001b[2K\n".repeat(terminal.rows - 1)}\u001b[2K\u001b[H`)
}

class WindowsTerminalPty implements TerminalPty {
	public readonly shell
	public readonly conhost
	public readonly onExit
	readonly #resizer = (async (): Promise<PipedChildProcess | null> => {
		const { plugin } = this,
			{ settings, language } = plugin,
			{ pythonExecutable } = settings,
			{ i18n } = language
		if (pythonExecutable === "") {
			return null
		}
		const ret = await spawnPromise(async () =>
			(await childProcess).spawn(pythonExecutable, ["-c", win32ResizerPy], {
				env: {
					...(await process).env,
					// eslint-disable-next-line @typescript-eslint/naming-convention
					PYTHONIOENCODING: "UTF-8:backslashreplace",
				},
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			}))
		try {
			try {
				ret.stderr.on("data", (chunk: Buffer | string) => {
					console.error(chunk.toString(DEFAULT_ENCODING))
				})
			} finally {
				ret.once("exit", (code, signal) => {
					if (code !== 0) {
						notice2(
							() => i18n.t(
								"errors.resizer-exited-unexpectedly",
								{ code: code ?? signal },
							),
							settings.errorNoticeTimeout,
							plugin,
						)
					}
				})
			}
		} catch (error) { console.warn(error) }
		return ret
	})()

	public constructor(
		protected readonly plugin: TerminalPlugin,
		executable: string,
		cwd?: string,
		args?: readonly string[],
	) {
		this.conhost = plugin.settings.enableWindowsConhostWorkaround
		const { conhost } = this,
			shell = (async (): Promise<readonly [
				PipedChildProcess,
				FileResultNoFd,
			]> => {
				const [resizer, resizerError] = await this.#resizer
					.then(resizer0 => Object.freeze([resizer0, null] as const))
					.catch(error => Object.freeze([null, anyToError(error)] as const))
				try {
					const codeTmp = (await tmp).fileSync({ discardDescriptor: true })
					try {
						const
							cmd = deepFreeze([
								...conhost
									? ["C:\\Windows\\System32\\conhost.exe"] as const
									: [] as const,
								"C:\\Windows\\System32\\cmd.exe",
								"/C",
								`${WindowsTerminalPty.#escapeArgument(executable)} ${(args ??
									[])
									.map(arg => WindowsTerminalPty.#escapeArgument(arg))
									.join(" ")
								} & call echo %^ERRORLEVEL% >${WindowsTerminalPty
									.#escapeArgument(codeTmp.name)}`,
							] as const),
							ret = await spawnPromise(async () => (await childProcess).spawn(
								cmd[0],
								cmd.slice(1),
								{
									cwd,
									stdio: ["pipe", "pipe", "pipe"],
									windowsHide: resizer === null,
									windowsVerbatimArguments: true,
								},
							))
						try {
							let resizerError0 = resizerError
							if (resizer !== null) {
								try {
									await writePromise(resizer.stdin, `${ret.pid ?? -1}\n`)
									const watchdog = window.setInterval(
										() => {
											writePromise(resizer.stdin, "\n")
												.catch(error => { console.trace(error) })
										},
										TERMINAL_RESIZER_WATCHDOG_INTERVAL,
									)
									try {
										resizer.once(
											"exit",
											() => { window.clearInterval(watchdog) },
										)
									} catch (error) {
										window.clearInterval(watchdog)
										throw error
									}
								} catch (error) {
									resizerError0 = anyToError(error)
									resizer.kill()
								}
							}
							if (resizerError0 !== null) {
								printError(
									resizerError0,
									() => this.plugin.language
										.i18n.t("errors.error-spawning-resizer"),
									this.plugin,
								)
							}
						} catch (error) { console.warn(error) }
						return [ret, codeTmp]
					} catch (error) {
						codeTmp.removeCallback()
						throw error
					}
				} catch (error) {
					resizer?.kill()
					throw error
				}
			})()
		this.shell = shell.then(([shell0]) => shell0)
		this.onExit = shell
			.then(async ([shell0, codeTmp]) =>
				new Promise<NodeJS.Signals | number>(executeParanoidly(resolve =>
					shell0.once("exit", (conCode, signal) => {
						(async (): Promise<void> => {
							try {
								try {
									const termCode = parseInt(
										(await fs).readFileSync(
											codeTmp.name,
											{ encoding: DEFAULT_ENCODING, flag: "r" },
										).trim(),
										10,
									)
									resolve(isNaN(termCode) ? conCode ?? signal ?? NaN : termCode)
								} catch (error) {
									resolve(conCode ?? signal ?? NaN)
									throw error
								} finally {
									codeTmp.removeCallback()
								}
							} catch (error) {
								console.warn(error)
							}
						})()
					}))))
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
		await writePromise(resizer.stdin, `${columns}x${rows}\n`)
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
		const writer =
			terminal.onData(async data => writePromise(shell.stdin, data))
		this.onExit.finally(() => { writer.dispose() })
	}
}

class UnixTerminalPty implements TerminalPty {
	public readonly shell
	public readonly onExit

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
					env: {
						...(await process).env,
						// eslint-disable-next-line @typescript-eslint/naming-convention
						PYTHONIOENCODING: `${DEFAULT_ENCODING}:backslashreplace`,
					},
					stdio: ["pipe", "pipe", "pipe", "pipe"],
					windowsHide: true,
				},
			)
		}).then(ret => {
			try {
				ret.stderr.on("data", (chunk: Buffer | string) => {
					console.error(chunk.toString(DEFAULT_ENCODING))
				})
			} catch (error) { console.warn(error) }
			return ret
		})
		this.onExit = this.shell
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
		const writer =
			terminal.onData(async data => writePromise(shell.stdin, data))
		this.onExit.finally(() => { writer.dispose() })
	}

	public async resize(columns: number, rows: number): Promise<void> {
		const CMDIO = 3
		await writePromise(
			(await this.shell).stdio[CMDIO] as Writable,
			`${columns}x${rows}\n`,
		)
	}
}

export namespace TerminalPty {
	export const PLATFORM_PTYS = Object.freeze({
		darwin: UnixTerminalPty,
		linux: UnixTerminalPty,
		win32: WindowsTerminalPty,
	} as const)
	export const SUPPORTED_PLATFORMS =
		typedKeys<["darwin", "linux", "win32"]>()(PLATFORM_PTYS)
	export type SupportedPlatform = typeof SUPPORTED_PLATFORMS[number]
	export const PLATFORM_PTY =
		inSet(SUPPORTED_PLATFORMS, PLATFORM) ? PLATFORM_PTYS[PLATFORM] : null
}
