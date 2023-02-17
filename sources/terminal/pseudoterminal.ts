import {
	DEFAULT_ENCODING,
	EXIT_SUCCESS,
	TERMINAL_RESIZER_WATCHDOG_INTERVAL,
	UNDEFINED,
	UNHANDLED_REJECTION_MESSAGE,
} from "../magic"
import { LOGGER, type Log, log } from "sources/patches"
import {
	PLATFORM,
	anyToError,
	clear,
	inSet,
	isNullish,
	logError,
	logFormat,
	promisePromise,
	spawnPromise,
	typedKeys,
	writePromise,
} from "../utils/util"
import { notice2, printError } from "sources/utils/obsidian"
import type { AsyncOrSync } from "ts-essentials"
import type { FileResultNoFd } from "tmp"
import type {
	ChildProcessWithoutNullStreams as PipedChildProcess,
} from "node:child_process"
import type { Terminal } from "xterm"
import type { TerminalPlugin } from "../main"
import type { Writable } from "node:stream"
import { dynamicRequire } from "../imports"
import { processText } from "./emulator"
import unixPseudoterminalPy from "./unix_pseudoterminal.py"
import win32ResizerPy from "./win32_resizer.py"

const
	childProcess =
		dynamicRequire<typeof import("node:child_process")>("node:child_process"),
	fs = dynamicRequire<typeof import("node:fs")>("node:fs"),
	process = dynamicRequire<typeof import("node:process")>("node:process"),
	tmp = dynamicRequire<typeof import("tmp")>("tmp")

function clearTerminal(terminal: Terminal): void {
	// Clear screen with scrollback kept
	terminal.write(`${"\u001b[2K\n".repeat(terminal.rows - 1)}\u001b[2K\u001b[H`)
}

export interface Pseudoterminal {
	readonly shell?: Promise<PipedChildProcess>
	readonly kill: () => AsyncOrSync<void>
	readonly onExit: Promise<NodeJS.Signals | number>
	readonly pipe: (terminal: Terminal) => AsyncOrSync<void>
	readonly resize?: (columns: number, rows: number) => AsyncOrSync<void>
}

abstract class PseudoPseudoterminal implements Pseudoterminal {
	public readonly onExit
	protected exited = false
	readonly #exit = promisePromise<NodeJS.Signals | number>()

	public constructor() {
		this.onExit = this.#exit
			.then(async ({ promise }) => promise)
			.finally(() => { this.exited = true })
	}

	public async kill(): Promise<void> {
		(await this.#exit).resolve(EXIT_SUCCESS)
	}

	public abstract pipe(terminal: Terminal): AsyncOrSync<void>
}

export class TextPseudoterminal
	extends PseudoPseudoterminal
	implements Pseudoterminal {
	#writer: Promise<unknown> = Promise.resolve()
	readonly #terminals: Terminal[] = []
	#text: string

	public constructor(text = "") {
		super()
		this.#text = text
		this.onExit.finally(() => { clear(this.#terminals) })
	}

	public get text(): string {
		return this.#text
	}

	public set text(value: string) {
		this.rewrite(processText(this.#text = value)).catch(logError)
	}

	public override async pipe(terminal: Terminal): Promise<void> {
		if (this.exited) { throw new Error() }
		this.#terminals.push(terminal)
		await this.rewrite(processText(this.text), [terminal])
	}

	protected async rewrite(
		text: string,
		terminals: readonly Terminal[] = this.#terminals,
	): Promise<void> {
		await this.#writer
		const writers = terminals.map(async terminal =>
			Promise.resolve().then(() => {
				terminal.clear()
				terminal.write(text)
			}))
		this.#writer = Promise.allSettled(writers)
		await Promise.all(writers)
	}
}

export class ConsolePseudoterminal
	extends PseudoPseudoterminal
	implements Pseudoterminal {
	#writer: Promise<unknown> = Promise.resolve()
	readonly #terminals: Terminal[] = []

	public constructor() {
		super()
		this.onExit
			.finally(() => { clear(this.#terminals) })
			.finally(LOGGER.listen(async event => this.write([event])))
	}

	// eslint-disable-next-line consistent-return
	protected static format(event: Log.Event): string {
		switch (event.type) {
			case "debug":
			case "error":
			case "info":
			case "warn":
				return logFormat(...event.data)
			case "windowError":
				return logFormat(event.data.message, event.data)
			case "unhandledRejection":
				return logFormat(UNHANDLED_REJECTION_MESSAGE, event.data)
			// No default
		}
	}

	public override async pipe(terminal: Terminal): Promise<void> {
		if (this.exited) { throw new Error() }
		terminal.clear()
		this.#terminals.push(terminal)
		await this.write(log(), [terminal])
	}

	protected async write(
		events: readonly Log.Event[],
		terminals: readonly Terminal[] = this.#terminals,
	): Promise<void> {
		const logStrings = events.map(event =>
			processText(ConsolePseudoterminal.format(event)))
		await this.#writer
		const writers = terminals.map(async terminal =>
			Promise.resolve()
				.then(() => {
					for (const logString of logStrings) {
						terminal.writeln(logString)
					}
				}))
		this.#writer = Promise.allSettled(writers)
		await Promise.all(writers)
	}
}

export interface ShellPseudoterminalArguments {
	readonly executable: string
	readonly cwd?: URL | string | null
	readonly args?: readonly string[] | null
	readonly pythonExecutable?: string | null
	readonly useWin32Conhost?: boolean | null
}

class WindowsPseudoterminal implements Pseudoterminal {
	public readonly shell
	public readonly conhost
	public readonly onExit
	protected readonly resizer

	public constructor(
		protected readonly plugin: TerminalPlugin,
		{
			args,
			cwd,
			executable,
			useWin32Conhost,
			pythonExecutable,
		}: ShellPseudoterminalArguments,
	) {
		this.conhost = useWin32Conhost ?? false
		const { conhost } = this,
			{ language } = plugin,
			{ i18n } = language,
			resizer = (async (): Promise<PipedChildProcess | null> => {
				if (isNullish(pythonExecutable)) {
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
					ret.once("exit", (code, signal) => {
						if (code !== 0) {
							notice2(
								() => i18n.t(
									"errors.resizer-exited-unexpectedly",
									{
										code: code ?? signal,
										interpolation: { escapeValue: false },
									},
								),
								plugin.settings.errorNoticeTimeout,
								plugin,
							)
						}
					}).stderr.on("data", (chunk: Buffer | string) => {
						console.error(chunk.toString(DEFAULT_ENCODING))
					})
				} catch (error) { console.warn(error) }
				return ret
			})(),
			shell = (async (): Promise<readonly [
				PipedChildProcess,
				FileResultNoFd,
			]> => {
				const [resizer0, resizerError] = await resizer
					.then(resizer1 => Object.freeze([resizer1, null] as const))
					.catch(error => Object.freeze([null, anyToError(error)] as const))
				try {
					const codeTmp = (await tmp).fileSync({ discardDescriptor: true })
					try {
						const
							cmd = Object.freeze([
								...conhost
									? ["C:\\Windows\\System32\\conhost.exe"] as const
									: [] as const,
								"C:\\Windows\\System32\\cmd.exe",
								"/C",
								`${WindowsPseudoterminal.escapeArgument(executable)} ${(
									args ?? [])
									.map(arg => WindowsPseudoterminal.escapeArgument(arg))
									.join(" ")
								} & call echo %^ERRORLEVEL% >${WindowsPseudoterminal
									.escapeArgument(codeTmp.name)}`,
							] as const),
							ret = await spawnPromise(async () => (await childProcess).spawn(
								cmd[0],
								cmd.slice(1),
								{
									cwd: cwd ?? UNDEFINED,
									stdio: ["pipe", "pipe", "pipe"],
									windowsHide: resizer0 === null,
									windowsVerbatimArguments: true,
								},
							))
						try {
							let resizerError0 = resizerError
							if (resizer0 !== null) {
								try {
									await writePromise(resizer0.stdin, `${ret.pid ?? -1}\n`)
									const watchdog = window.setInterval(
										() => {
											writePromise(resizer0.stdin, "\n")
												.catch(error => { console.debug(error) })
										},
										TERMINAL_RESIZER_WATCHDOG_INTERVAL,
									)
									try {
										resizer0.once(
											"exit",
											() => { window.clearInterval(watchdog) },
										)
									} catch (error) {
										window.clearInterval(watchdog)
										throw error
									}
								} catch (error) {
									resizerError0 = anyToError(error)
									resizer0.kill()
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
					resizer0?.kill()
					throw error
				}
			})()
		this.resizer = resizer
		this.shell = shell.then(([shell0]) => shell0)
		this.onExit = shell
			.then(async ([shell0, codeTmp]) =>
				new Promise(resolve => {
					shell0.once("exit", (conCode, signal) => {
						resolve((async (): Promise<NodeJS.Signals | number> => {
							try {
								const termCode = parseInt(
									(await fs).readFileSync(
										codeTmp.name,
										{ encoding: DEFAULT_ENCODING, flag: "r" },
									).trim(),
									10,
								)
								return isNaN(termCode) ? conCode ?? signal ?? NaN : termCode
							} catch (error) {
								console.debug(error)
								return conCode ?? signal ?? NaN
							} finally {
								try {
									codeTmp.removeCallback()
								} catch (error) { console.warn(error) }
							}
						})())
					})
				}))
	}

	protected static escapeArgument(arg: string, shell = false): string {
		const ret = `"${arg.replace("\"", "\\\"")}"`
		return shell ? ret.replace(/(?<meta>[()%!^"<>&|])/gu, "^$<meta>") : ret

		/*
		 * Replace 1: quote argument
		 * Replace 2: escape cmd.exe metacharacters
		 */
	}

	public async kill(): Promise<void> {
		if (!(await this.shell).kill()) {
			throw new Error(this.plugin.language
				.i18n.t("errors.error-killing-pseudoterminal"))
		}
	}

	public async resize(columns: number, rows: number): Promise<void> {
		const { resizer, plugin } = this,
			resizer0 = await resizer
		if (resizer0 === null) {
			throw new Error(plugin.language.i18n.t("errors.resizer-disabled"))
		}
		await writePromise(resizer0.stdin, `${columns}x${rows}\n`)
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

class UnixPseudoterminal implements Pseudoterminal {
	public readonly shell
	public readonly onExit

	public constructor(
		protected readonly plugin: TerminalPlugin,
		{
			args,
			cwd,
			executable,
			pythonExecutable,
		}: ShellPseudoterminalArguments,
	) {
		const { language } = plugin
		this.shell = spawnPromise(async () => {
			if (isNullish(pythonExecutable)) {
				throw new Error(language
					.i18n.t("errors.no-Python-to-spawn-Unix-pseudoterminal"))
			}
			return (await childProcess).spawn(
				pythonExecutable,
				["-c", unixPseudoterminalPy, executable].concat(args ?? []),
				{
					cwd: cwd ?? UNDEFINED,
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
				new Promise<NodeJS.Signals | number>(resolve => {
					shell.once("exit", (code, signal) => {
						resolve(code ?? signal ?? NaN)
					})
				}))
	}

	public async kill(): Promise<void> {
		if ((await this.shell).kill()) {
			throw new Error(this.plugin.language
				.i18n.t("errors.error-killing-pseudoterminal"))
		}
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

export namespace Pseudoterminal {
	export const PLATFORM_PSEUDOTERMINALS = Object.freeze({
		darwin: UnixPseudoterminal,
		linux: UnixPseudoterminal,
		win32: WindowsPseudoterminal,
	} as const)
	export const SUPPORTED_PLATFORMS =
		typedKeys<readonly ["darwin", "linux", "win32"]>()(PLATFORM_PSEUDOTERMINALS)
	export type SupportedPlatform = typeof SUPPORTED_PLATFORMS[number]
	export const PLATFORM_PSEUDOTERMINAL =
		inSet(SUPPORTED_PLATFORMS, PLATFORM)
			? PLATFORM_PSEUDOTERMINALS[PLATFORM]
			: null
}
