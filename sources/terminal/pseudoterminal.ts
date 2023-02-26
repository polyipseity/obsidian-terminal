import {
	DEFAULT_ENCODING,
	DEFAULT_PYTHONIOENCODING,
	EXIT_SUCCESS,
	SI_PREFIX_SCALE,
	TERMINAL_EXIT_CLEANUP_DELAY,
	TERMINAL_RESIZER_WATCHDOG_INTERVAL,
	UNDEFINED,
	UNHANDLED_REJECTION_MESSAGE,
} from "../magic"
import {
	ESCAPE_SEQUENCE_INTRODUCER as ESC,
	TerminalTextArea,
	processText,
	writePromise as tWritePromise,
	writelnPromise as tWritelnPromise,
} from "./util"
import {
	Functions,
	PLATFORM,
	acquireConditionally,
	anyToError,
	clear,
	consumeEvent,
	getKeyModifiers,
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
import { isEmpty, noop } from "lodash"
import { notice2, printError } from "sources/utils/obsidian"
import AsyncLock from "async-lock"
import type { AsyncOrSync } from "ts-essentials"
import { DisposerAddon } from "./emulator"
import type { FileResultNoFd } from "tmp"
import type { Log } from "sources/patches"
import type {
	ChildProcessWithoutNullStreams as PipedChildProcess,
} from "node:child_process"
import type { Terminal } from "xterm"
import type { TerminalPlugin } from "../main"
import type { Writable } from "node:stream"
import ansi from "ansi-escape-sequences"
import { dynamicRequire } from "../imports"
import unixPseudoterminalPy from "./unix_pseudoterminal.py"
import win32ResizerPy from "./win32_resizer.py"

const
	childProcess =
		dynamicRequire<typeof import("node:child_process")>("node:child_process"),
	fs = dynamicRequire<typeof import("node:fs")>("node:fs"),
	process = dynamicRequire<typeof import("node:process")>("node:process"),
	tmp = dynamicRequire<typeof import("tmp")>("tmp")

async function clearTerminal(terminal: Terminal): Promise<void> {
	// Clear screen with scrollback kept
	await tWritePromise(
		terminal,
		`${`\r${ansi.erase.inLine()}\n`.repeat(terminal.rows -
			1)}\r${ansi.erase.inLine()}${ansi.cursor.position()}`,
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
	protected readonly lock = new AsyncLock()
	#text: string

	public constructor(text = "") {
		super()
		this.#text = text
	}

	public get text(): string {
		return this.#text
	}

	public set text(value: string) {
		this.rewrite(processText(this.#text = value)).catch(logError)
	}

	public override async pipe(terminal: Terminal): Promise<void> {
		await super.pipe(terminal)
		await this.rewrite(processText(this.text), [terminal])
	}

	protected async rewrite(
		text: string,
		terminals: readonly Terminal[] = this.terminals,
	): Promise<void> {
		const terminals0 = [...terminals]
		return new Promise((resolve, reject) => {
			this.lock.acquire(TextPseudoterminal.syncLock, async () => {
				const writers = terminals0.map(async terminal => {
					terminal.clear()
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
	protected readonly lock = new AsyncLock()
	protected readonly buffer = new TerminalTextArea()

	public constructor(protected readonly log: Log) {
		super()
		this.onExit
			.finally(log.logger.listen(async event => this.write([event])))
			.finally(() => { this.buffer.dispose() })
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
		terminal.clear()
		let block = false
		const disposer = new Functions(
			{ async: false, settled: true },
			...[
				terminal.onData(data => {
					if (block) {
						block = false
						return
					}
					let writing = true
					this.buffer.write(data)
						.catch(logError)
						.finally(() => { writing = false });
					(async (): Promise<void> => {
						try {
							// eslint-disable-next-line no-unmodified-loop-condition
							while (writing) {
								// eslint-disable-next-line no-await-in-loop
								await this.syncBuffer()
							}
							await this.syncBuffer()
						} catch (error) {
							console.log(error)
						}
					})()
				}),
				terminal.onKey(({ domEvent }) => {
					if (domEvent.key === "Enter" && isEmpty(getKeyModifiers(domEvent))) {
						this.eval().catch(logError)
						consumeEvent(domEvent)
						block = true
					}
				}),
			].map(disposer0 => () => { disposer0.dispose() }),
		)
		this.onExit.finally(() => { disposer.call() })
		await this.write(this.log.history, [terminal])
	}

	protected async eval(): Promise<void> {
		const { buffer, lock, terminals } = this,
			code =
				await lock.acquire(ConsolePseudoterminal.syncLock, async () => {
					const code0 = buffer.values.join("")
					await buffer.clear()
					await this.syncBuffer("sync", terminals, false)
					return code0
				})
		console.log(code)
		let ret: unknown = null
		try {
			ret = self.eval(code)
		} catch (error) {
			console.error(error)
			return
		}
		console.log(ret)
	}

	protected async syncBuffer(
		type: "clear" | "sync" = "sync",
		terminals: readonly Terminal[] = this.terminals,
		lock = true,
	): Promise<void> {
		const terminals0 = [...terminals],
			{ values } = this.buffer,
			processed = type === "sync"
				? [processText(values[0]), processText(values[1])] as const
				: ["", ""] as const
		return new Promise((resolve, reject) => {
			acquireConditionally(
				this.lock,
				ConsolePseudoterminal.syncLock,
				lock,
				async () => {
					const writers = terminals0.map(async terminal => tWritePromise(
						terminal,
						`${ESC}8${ansi.erase.display()}${processed
							.join("")}${ESC}8${processed[0]}`,
					))
					resolve(Promise.all(writers).then(noop))
					await Promise.allSettled(writers)
				},
			).catch(reject)
		})
	}

	protected async write(
		events: readonly Log.Event[],
		terminals: readonly Terminal[] = this.terminals,
		lock = true,
	): Promise<void> {
		const terminals0 = [...terminals],
			lines = events.map(event =>
				processText(ConsolePseudoterminal.format(event)))
		await acquireConditionally(
			this.lock,
			ConsolePseudoterminal.syncLock,
			lock,
			async () => {
				await this.syncBuffer("clear", terminals0, false)
				await Promise.allSettled(terminals0.map(async terminal => {
					for (const line of lines) {
						// eslint-disable-next-line no-await-in-loop
						await tWritelnPromise(terminal, line)
					}
					await tWritePromise(terminal, `${ESC}7`)
				}))
				await this.syncBuffer("sync", terminals0, false)
			},
		)
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
					(await childProcess).spawn(pythonExecutable, ["-c", win32ResizerPy], {
						env: {
							...(await process).env,
							// eslint-disable-next-line @typescript-eslint/naming-convention
							PYTHONIOENCODING: DEFAULT_PYTHONIOENCODING,
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
				typeof resizerInitial,
			]> => {
				const resizer = await resizerInitial.catch(() => null)
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
											TERMINAL_RESIZER_WATCHDOG_INTERVAL * SI_PREFIX_SCALE,
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
						codeTmp.removeCallback()
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
								(async (): Promise<void> => {
									try {
										await sleep2(TERMINAL_EXIT_CLEANUP_DELAY)
										codeTmp.removeCallback()
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
		await clearTerminal(terminal)
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
				["-c", unixPseudoterminalPy, executable].concat(args ?? []),
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
		await clearTerminal(terminal)
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
	export const PLATFORM_PSEUDOTERMINALS = Object.freeze({
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
