import {
	DEFAULT_ENCODING,
	EXIT_SUCCESS,
	TERMINAL_RESIZER_WATCHDOG_INTERVAL,
	UNHANDLED_REJECTION_MESSAGE,
} from "../magic"
import { LOGGER, type Log, log } from "sources/patches"
import {
	PLATFORM,
	anyToError,
	clear,
	executeParanoidly,
	inSet,
	isUndefined,
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
		this.#rewrite(this.#terminals, processText(this.#text = value))
			.catch(error => { console.error(error) })
	}

	public override async pipe(terminal: Terminal): Promise<void> {
		if (this.exited) { throw new Error() }
		this.#terminals.push(terminal)
		await this.#rewrite([terminal], processText(this.text))
	}

	async #rewrite(terminals: readonly Terminal[], text: string): Promise<void> {
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
			.finally(LOGGER.listen(async event =>
				this.#write(this.#terminals, [event])))
	}

	// eslint-disable-next-line consistent-return
	static #format(event: Log.Event): string {
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
		await this.#write([terminal], log())
	}

	async #write(
		terminals: readonly Terminal[],
		events: readonly Log.Event[],
	): Promise<void> {
		const logStrings = events.map(event =>
			processText(ConsolePseudoterminal.#format(event)))
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
	readonly cwd?: string | undefined
	readonly args?: readonly string[] | undefined
	readonly pythonExecutable?: string | undefined
	readonly enableWindowsConhostWorkaround?: boolean | undefined
}

class WindowsPseudoterminal implements Pseudoterminal {
	public readonly shell
	public readonly conhost
	public readonly onExit
	readonly #resizer

	public constructor(
		protected readonly plugin: TerminalPlugin,
		{
			args,
			cwd,
			executable,
			enableWindowsConhostWorkaround,
			pythonExecutable,
		}: ShellPseudoterminalArguments,
	) {
		this.conhost = enableWindowsConhostWorkaround ?? false
		const { conhost } = this,
			{ language } = plugin,
			{ i18n } = language,
			resizer = (async (): Promise<PipedChildProcess | null> => {
				if (isUndefined(pythonExecutable)) {
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
									plugin.settings.errorNoticeTimeout,
									plugin,
								)
							}
						})
					}
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
								`${WindowsPseudoterminal.#escapeArgument(executable)} ${(
									args ?? [])
									.map(arg => WindowsPseudoterminal.#escapeArgument(arg))
									.join(" ")
								} & call echo %^ERRORLEVEL% >${WindowsPseudoterminal
									.#escapeArgument(codeTmp.name)}`,
							] as const),
							ret = await spawnPromise(async () => (await childProcess).spawn(
								cmd[0],
								cmd.slice(1),
								{
									cwd,
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
												.catch(error => { console.trace(error) })
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
		this.#resizer = resizer
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
								} finally {
									try {
										codeTmp.removeCallback()
									} catch (error) { console.warn(error) }
								}
							} catch (error) { console.error(error) }
						})()
					}))))
	}

	static #escapeArgument(arg: string, shell = false): string {
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
				.i18n.t("errors.failed-to-kill-pseudoterminal"))
		}
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
			if (isUndefined(pythonExecutable)) {
				throw new Error(language
					.i18n.t("errors.no-python-to-start-unix-pseudoterminal"))
			}
			return (await childProcess).spawn(
				pythonExecutable,
				["-c", unixPseudoterminalPy, executable].concat(args ?? []),
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

	public async kill(): Promise<void> {
		if ((await this.shell).kill()) {
			throw new Error(this.plugin.language
				.i18n.t("errors.failed-to-kill-pseudoterminal"))
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
