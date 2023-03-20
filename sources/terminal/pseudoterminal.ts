import {
	DEFAULT_ENCODING,
	DEFAULT_PYTHONIOENCODING,
	EXIT_SUCCESS,
	MAX_LOCK_PENDING,
	SI_PREFIX_SCALE,
	TERMINAL_EXIT_CLEANUP_WAIT,
	TERMINAL_RESIZER_WATCHDOG_WAIT,
	UNDEFINED,
	UNHANDLED_REJECTION_MESSAGE,
	WINDOWS_CMD_PATH,
	WINDOWS_CONHOST_PATH,
} from "../magic"
import {
	Functions,
	PLATFORM,
	acquireConditionally,
	anyToError,
	clear,
	deepFreeze,
	inSet,
	isNonNullish,
	isNullish,
	logError,
	logFormat,
	promisePromise,
	remove,
	replaceAllRegex,
	sleep2,
	spawnPromise,
	typedKeys,
	writePromise,
} from "../utils/util"
import type { IMarker, Terminal } from "xterm"
import {
	NORMALIZED_LINE_FEED,
	normalizeText,
	writePromise as tWritePromise,
} from "./util"
import { notice2, printError } from "sources/utils/obsidian"
import AsyncLock from "async-lock"
import type { AsyncOrSync } from "ts-essentials"
import { DisposerAddon } from "./emulator-addons"
import type { FileResult } from "tmp-promise"
import type { Log } from "sources/patches"
import type {
	ChildProcessWithoutNullStreams as PipedChildProcess,
} from "node:child_process"
import { Readline } from "xterm-readline"
import type { TerminalPlugin } from "../main"
import type { Writable } from "node:stream"
import ansi from "ansi-escape-sequences"
import { dynamicRequire } from "../imports"
import { noop } from "lodash-es"
import unixPseudoterminalPy from "./unix_pseudoterminal.py"
import win32ResizerPy from "./win32_resizer.py"

const
	childProcess =
		dynamicRequire<typeof import("node:child_process")>("node:child_process"),
	fsPromises =
		dynamicRequire<typeof import("node:fs/promises")>("node:fs/promises"),
	process = dynamicRequire<typeof import("node:process")>("node:process"),
	tmpPromise = dynamicRequire<typeof import("tmp-promise")>("tmp-promise")

async function clearTerminal(terminal: Terminal, keep = false): Promise<void> {
	const { rows } = terminal
	await tWritePromise(
		terminal,
		`${keep
			? `${NORMALIZED_LINE_FEED.repeat(Math.max(rows - 1, 0))}`
			// eslint-disable-next-line @typescript-eslint/no-magic-numbers
			: ""}${ansi.erase.display(keep ? 2 : 3)}${ansi.cursor.position()}`,
	)
}

export interface Pseudoterminal {
	readonly shell?: Promise<PipedChildProcess> | undefined
	readonly kill: () => AsyncOrSync<void>
	readonly onExit: Promise<NodeJS.Signals | number>
	readonly pipe: (terminal: Terminal) => AsyncOrSync<void>
	readonly resize?: (columns: number, rows: number) => AsyncOrSync<void>
}

export class RefPsuedoterminal<T extends Pseudoterminal,
> implements Pseudoterminal {
	public readonly onExit
	protected readonly delegate: T
	readonly #exit = promisePromise<NodeJS.Signals | number>()
	readonly #ref: [number]

	public constructor(delegate: RefPsuedoterminal<T> | T) {
		this.onExit = this.#exit.then(async ({ promise }) => promise)
		if (delegate instanceof RefPsuedoterminal) {
			this.delegate = delegate.delegate
			this.#ref = delegate.#ref
		} else {
			this.delegate = delegate
			this.#ref = [0]
		}
		this.delegate.onExit.then(
			async ret => { (await this.#exit).resolve(ret) },
			async error => { (await this.#exit).reject(error) },
		)
		++this.#ref[0]
	}

	public get shell(): Promise<PipedChildProcess> | undefined {
		return this.delegate.shell
	}

	public dup(): RefPsuedoterminal<T> {
		return new RefPsuedoterminal(this)
	}

	public async kill(): Promise<void> {
		if (--this.#ref[0] <= 0) {
			await this.delegate.kill()
		} else {
			(await this.#exit).resolve(EXIT_SUCCESS)
		}
	}

	public pipe(terminal: Terminal): AsyncOrSync<void> {
		return this.delegate.pipe(terminal)
	}

	public resize(columns: number, rows: number): AsyncOrSync<void> {
		const { delegate } = this
		if (delegate.resize) {
			return delegate.resize(columns, rows)
		}
		return UNDEFINED
	}
}

abstract class PseudoPseudoterminal implements Pseudoterminal {
	public readonly onExit
	protected readonly terminals: Terminal[] = []
	protected exited = false
	readonly #exit = promisePromise<NodeJS.Signals | number>()

	public constructor() {
		this.onExit = this.#exit
			.then(async ({ promise }) => promise)
			.finally(() => { this.exited = true })
			.finally(() => { clear(this.terminals) })
	}

	public async kill(): Promise<void> {
		(await this.#exit).resolve(EXIT_SUCCESS)
	}

	public pipe(terminal: Terminal): AsyncOrSync<void> {
		if (this.exited) { throw new Error() }
		terminal.loadAddon(new DisposerAddon(
			() => { remove(this.terminals, terminal) },
		))
		this.terminals.push(terminal)
	}
}

export class TextPseudoterminal
	extends PseudoPseudoterminal
	implements Pseudoterminal {
	protected static readonly syncLock = "sync"
	protected readonly lock = new AsyncLock({ maxPending: MAX_LOCK_PENDING })
	#text: string

	public constructor(text = "") {
		super()
		this.#text = text
	}

	public get text(): string {
		return this.#text
	}

	public set text(value: string) {
		this.rewrite(normalizeText(this.#text = value)).catch(logError)
	}

	public override async pipe(terminal: Terminal): Promise<void> {
		await super.pipe(terminal)
		await this.rewrite(normalizeText(this.text), [terminal])
	}

	protected async rewrite(
		text: string,
		terminals: readonly Terminal[] = this.terminals,
	): Promise<void> {
		const terminals0 = [...terminals]
		return new Promise((resolve, reject) => {
			this.lock.acquire(TextPseudoterminal.syncLock, async () => {
				const writers = terminals0.map(async terminal => {
					await clearTerminal(terminal)
					await tWritePromise(terminal, text)
				})
				resolve(Promise.all(writers).then(noop))
				await Promise.allSettled(writers)
			}).catch(reject)
		})
	}
}

export class ConsolePseudoterminal
	extends PseudoPseudoterminal
	implements Pseudoterminal {
	protected static readonly syncLock = "sync"
	protected readonly lock = new AsyncLock({ maxPending: MAX_LOCK_PENDING })
	readonly #readlines = new Map<Terminal, Readline>()

	public constructor(
		protected readonly console: Console,
		protected readonly log: Log,
	) {
		super()
		this.onExit
			.finally(log.logger.listen(async event => this.write([event])))
			.finally(() => {
				new Functions(
					{ async: false, settled: true },
					...[...this.#readlines.values()]
						.map(readline => (): void => { readline.dispose() }),
					() => { this.#readlines.clear() },
				).call()
			})
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
		await super.pipe(terminal)
		const readline = new Readline()
		terminal.loadAddon(new DisposerAddon(
			() => { this.#readlines.delete(terminal) },
		))
		this.#readlines.set(terminal, readline)
		terminal.loadAddon(readline)
		readline.tty().clearScreen()
		await this.write(this.log.history, [terminal])
		this.repl(terminal, readline)
	}

	protected repl(terminal: Terminal, readline: Readline): void {
		const { console } = this
		readline.read("> ")
			.then(code => {
				console.log(code)
				let ret: unknown = null
				try {
					ret = self.eval(code)
				} catch (error) {
					console.error(error)
					return
				}
				console.log(ret)
			})
			.then(() => {
				const readline0 = this.#readlines.get(terminal)
				if (!readline0) { return }
				this.repl(terminal, readline0)
			})
			.catch(logError)
	}

	protected async write(
		events: readonly Log.Event[],
		terminals: readonly Terminal[] = this.terminals,
		lock = true,
	): Promise<void> {
		const terminals0 = [...terminals],
			text = `${ansi.erase.inLine() + normalizeText(events
				.map(event => ConsolePseudoterminal.format(event)).join("\n"))
				.replace(
					replaceAllRegex(NORMALIZED_LINE_FEED),
					`${NORMALIZED_LINE_FEED}${ansi.erase.inLine()}`,
				)}${NORMALIZED_LINE_FEED}`
		await new Promise((resolve, reject) => {
			acquireConditionally(
				this.lock,
				ConsolePseudoterminal.syncLock,
				lock,
				async () => {
					const writers = terminals0
						.map(terminal => this.#readlines.get(terminal))
						.filter(isNonNullish)
						.map(async readline => Promise.resolve()
							.then(() => { readline.write(text) }))
					resolve(Promise.all(writers))
					await Promise.allSettled(writers)
				},
			).catch(reject)
		})
	}
}
export namespace ConsolePseudoterminal {
	export interface $Editor {
		readonly startX: number
		readonly startYMarker: IMarker | undefined
		renderEndY: number
		readonly close: () => void
	}
}

export interface ShellPseudoterminalArguments {
	readonly executable: string
	readonly cwd?: URL | string | null
	readonly args?: readonly string[] | null
	readonly terminal?: string | null
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
			resizerInitial = (async (): Promise<PipedChildProcess | null> => {
				if (isNullish(pythonExecutable)) {
					return null
				}
				const ret = await spawnPromise(async () =>
					(await childProcess).spawn(
						pythonExecutable,
						["-c", await win32ResizerPy],
						{
							env: {
								...(await process).env,
								// eslint-disable-next-line @typescript-eslint/naming-convention
								PYTHONIOENCODING: DEFAULT_PYTHONIOENCODING,
							},
							stdio: ["pipe", "pipe", "pipe"],
							windowsHide: true,
						},
					))
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
				FileResult,
				typeof resizerInitial,
			]> => {
				const resizer = await resizerInitial.catch(() => null)
				try {
					const codeTmp = await (await tmpPromise)
						.file({ discardDescriptor: true })
					try {
						const
							cmd = Object.freeze([
								...conhost
									? [WINDOWS_CONHOST_PATH] as const
									: [] as const,
								WINDOWS_CMD_PATH,
								"/C",
								`${WindowsPseudoterminal.escapeArgument(executable)} ${(
									args ?? [])
									.map(arg => WindowsPseudoterminal.escapeArgument(arg))
									.join(" ")
								} & call echo %^ERRORLEVEL% >${WindowsPseudoterminal
									.escapeArgument(codeTmp.path)}`,
							] as const),
							ret = await spawnPromise(async () => (await childProcess).spawn(
								cmd[0],
								cmd.slice(1),
								{
									cwd: cwd ?? UNDEFINED,
									stdio: ["pipe", "pipe", "pipe"],
									windowsHide: !resizer,
									windowsVerbatimArguments: true,
								},
							))
						return [
							ret, codeTmp, resizerInitial.then(async resizer0 => {
								if (resizer0) {
									try {
										await writePromise(resizer0.stdin, `${ret.pid ?? -1}\n`)
										const watchdog = self.setInterval(
											() => {
												writePromise(resizer0.stdin, "\n")
													.catch(error => { console.debug(error) })
											},
											TERMINAL_RESIZER_WATCHDOG_WAIT * SI_PREFIX_SCALE,
										)
										resizer0.once(
											"exit",
											() => { self.clearInterval(watchdog) },
										)
									} catch (error) {
										resizer0.kill()
										throw error
									}
								}
								return resizer0
							}).catch(error => {
								const error0 = anyToError(error)
								printError(
									error0,
									() => i18n.t("errors.error-spawning-resizer"),
									plugin,
								)
								throw error0
							}),
						]
					} catch (error) {
						await codeTmp.cleanup()
						throw error
					}
				} catch (error) {
					resizer?.kill()
					throw error
				}
			})()
		this.resizer = shell.then(async ([, , resizer]) => resizer)
		this.shell = shell.then(([shell0]) => shell0)
		this.onExit = shell
			.then(async ([shell0, codeTmp]) =>
				new Promise<NodeJS.Signals | number>(resolve => {
					shell0.once("exit", (conCode, signal) => {
						resolve((async (): Promise<NodeJS.Signals | number> => {
							try {
								const termCode = parseInt(
									(await (await fsPromises).readFile(
										codeTmp.path,
										{ encoding: DEFAULT_ENCODING, flag: "r" },
									)).trim(),
									10,
								)
								return isNaN(termCode) ? conCode ?? signal ?? NaN : termCode
							} catch (error) {
								console.debug(error)
								return conCode ?? signal ?? NaN
							} finally {
								(async (): Promise<void> => {
									try {
										await sleep2(TERMINAL_EXIT_CLEANUP_WAIT)
										await codeTmp.cleanup()
									} catch (error) { console.warn(error) }
								})()
							}
						})())
					})
				}))
	}

	protected static escapeArgument(arg: string, shell = false): string {
		const ret = `"${arg.replace(replaceAllRegex("\""), "\\\"")}"`
		return shell ? ret.replace(/(?<meta>[()%!^"<>&|])/ug, "^$<meta>") : ret

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
		if (!resizer0) {
			throw new Error(plugin.language.i18n.t("errors.resizer-disabled"))
		}
		await writePromise(resizer0.stdin, `${columns}x${rows}\n`)
	}

	public async pipe(terminal: Terminal): Promise<void> {
		let init = !this.conhost
		const shell = await this.shell,
			reader = (chunk: Buffer | string): void => {
				if (!init) {
					init = true
					return
				}
				tWritePromise(terminal, chunk).catch(logError)
			}
		await clearTerminal(terminal, true)
		terminal.loadAddon(new DisposerAddon(
			() => { shell.stdout.removeListener("data", reader) },
			() => { shell.stderr.removeListener("data", reader) },
		))
		shell.stdout.on("data", reader)
		shell.stderr.on("data", reader)
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
			terminal,
			pythonExecutable,
		}: ShellPseudoterminalArguments,
	) {
		const { language } = plugin
		this.shell = spawnPromise(async () => {
			if (isNullish(pythonExecutable)) {
				throw new Error(language
					.i18n.t("errors.no-Python-to-spawn-Unix-pseudoterminal"))
			}
			const env: NodeJS.ProcessEnv = {
				...(await process).env,
				// eslint-disable-next-line @typescript-eslint/naming-convention
				PYTHONIOENCODING: DEFAULT_PYTHONIOENCODING,
			}
			if (isNonNullish(terminal)) { env["TERM"] = terminal }
			return (await childProcess).spawn(
				pythonExecutable,
				["-c", await unixPseudoterminalPy, executable].concat(args ?? []),
				{
					cwd: cwd ?? UNDEFINED,
					env,
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
		if (!(await this.shell).kill()) {
			throw new Error(this.plugin.language
				.i18n.t("errors.error-killing-pseudoterminal"))
		}
	}

	public async pipe(terminal: Terminal): Promise<void> {
		const shell = await this.shell,
			reader = (chunk: Buffer | string): void => {
				tWritePromise(terminal, chunk).catch(logError)
			}
		await clearTerminal(terminal, true)
		terminal.loadAddon(new DisposerAddon(
			() => { shell.stdout.removeListener("data", reader) },
			() => { shell.stderr.removeListener("data", reader) },
		))
		shell.stdout.on("data", reader)
		shell.stderr.on("data", reader)
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
	export const PLATFORM_PSEUDOTERMINALS = deepFreeze({
		darwin: UnixPseudoterminal,
		linux: UnixPseudoterminal,
		win32: WindowsPseudoterminal,
	} as const)
	export type SupportedPlatforms = readonly ["darwin", "linux", "win32"]
	export const SUPPORTED_PLATFORMS =
		typedKeys<SupportedPlatforms>()(PLATFORM_PSEUDOTERMINALS)
	export const PLATFORM_PSEUDOTERMINAL =
		inSet(SUPPORTED_PLATFORMS, PLATFORM)
			? PLATFORM_PSEUDOTERMINALS[PLATFORM]
			: null
}
