import {
	CursoredText,
	NORMALIZED_LINE_FEED,
	TerminalTextArea,
	normalizeText,
	writePromise as tWritePromise,
} from "./util"
import {
	DEFAULT_ENCODING,
	DEFAULT_PYTHONIOENCODING,
	EXIT_SUCCESS,
	MAX_LOCK_PENDING,
	SI_PREFIX_SCALE,
	TERMINAL_EXIT_CLEANUP_WAIT,
	TERMINAL_RESIZER_WATCHDOG_WAIT,
	UNDEFINED,
	WINDOWS_CMD_PATH,
	WINDOWS_CONHOST_PATH,
} from "../magic"
import {
	Functions,
	acquireConditionally,
	anyToError,
	clear,
	consumeEvent,
	deepFreeze,
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
import type { IMarker, Terminal } from "xterm"
import type { Options, StyleType } from "browser-util-inspect"
import { isEmpty, isUndefined, noop } from "lodash-es"
import { notice2, printError } from "sources/utils/obsidian"
import AsyncLock from "async-lock"
import type { AsyncOrSync } from "ts-essentials"
import { DisposerAddon } from "./emulator-addons"
import type { FileResult } from "tmp-promise"
import type { Log } from "sources/patches"
import type {
	ChildProcessWithoutNullStreams as PipedChildProcess,
} from "node:child_process"
import { Platform } from "sources/utils/platforms"
import type { TerminalPlugin } from "../main"
import type { Writable } from "node:stream"
import ansi from "ansi-escape-sequences"
import { deopaque } from "sources/utils/types"
import { dynamicRequire } from "../imports"
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
	public static readonly colors = deepFreeze({
		debug: "blue",
		error: "red",
		info: "white",
		warn: "yellow",
	} as const satisfies Readonly<Record<string, ansi.Style>>)

	protected static readonly syncLock = "sync"
	static readonly #formatCache = new WeakMap<Log.Event, string>()
	protected readonly lock = new AsyncLock({ maxPending: MAX_LOCK_PENDING })
	protected readonly buffer = new TerminalTextArea()
	readonly #history = [""]
	#historyIndex = 0
	readonly #editors = new Map<Terminal, ConsolePseudoterminal.$Editor>()

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
					...[...this.#editors.keys()]
						.map(terminal => (): void => { this.#setEditor(terminal) }),
				).call()
			})
			.finally(() => { this.buffer.dispose() })
	}

	public static options(styles: readonly ansi.Style[]): Options {
		const stylizer: {
			readonly [_ in StyleType]: readonly ansi.Style[]
		} = deepFreeze({
			"boolean": ["yellow"],
			date: ["magenta"],
			name: [],
			"null": ["bold"],
			number: ["yellow"],
			regexp: ["red"],
			special: ["cyan"],
			string: ["green"],
			undefined: ["grey"],
		} as const)
		return deepFreeze({
			colors: false,
			customInspect: true,
			depth: 0,
			showHidden: true,
			stylize(str, styleType) {
				return `${ansi.styles(stylizer[styleType])}${str}${ansi.style
					.reset}${ansi.styles(styles)}`
			},
		})
	}

	protected static format(event: Log.Event): string {
		let ret = this.#formatCache.get(event)
		if (isUndefined(ret)) {
			const { colors } = ConsolePseudoterminal,
				{ data, type } = event,
				styles: ansi.Style[] = []
			switch (type) {
				case "debug":
				case "error":
				case "info":
				case "warn":
					styles.push(colors[type])
					ret = logFormat(
						ConsolePseudoterminal.options(styles),
						...data,
					)
					break
				case "windowError":
					styles.push(colors.error)
					ret = logFormat(
						ConsolePseudoterminal.options(styles),
						data.message,
						data,
					)
					break
				case "unhandledRejection":
					styles.push(colors.error)
					ret = logFormat(
						ConsolePseudoterminal.options(styles),
						data.reason,
						data,
					)
					break
				// No default
			}
			this.#formatCache.set(event, ret =
				`${ansi.styles(styles)}${ret}${ansi.style.reset}`)
		}
		return ret
	}

	public override async pipe(terminal: Terminal): Promise<void> {
		await super.pipe(terminal)
		terminal.loadAddon(new DisposerAddon(
			() => { this.#setEditor(terminal) },
		))
		const { buffer, lock, terminals } = this
		let block = false,
			resizing = false
		const disposer = new Functions(
			{ async: false, settled: true },
			...[
				terminal.onData(async data => {
					if (block) {
						block = false
						return
					}
					await lock.acquire(ConsolePseudoterminal.syncLock, async () => {
						let writing = true
						const write = buffer.write(data)
							.finally(() => { writing = false })
							.then(async () => {
								this.#history[this.#history.length - 1] = buffer.value.string
								await this.syncBuffer(terminals, false)
							})
						// eslint-disable-next-line no-unmodified-loop-condition
						while (writing) {
							// eslint-disable-next-line no-await-in-loop
							await this.syncBuffer(terminals, false)
						}
						await write
					})
				}),
				terminal.onKey(({ domEvent }) => {
					if (!isEmpty(getKeyModifiers(domEvent))) { return }
					const { key } = domEvent
					switch (key) {
						case "Enter":
							this.eval().catch(logError)
							break
						case "ArrowUp":
						case "ArrowDown":
							if ((this.#history.at(-1) ?? "").includes("\n")) { return }
							lock.acquire(ConsolePseudoterminal.syncLock, async () => {
								if ((this.#history.at(-1) ?? "").includes("\n")) { return }
								const { length } = this.#history
								if (length <= 0) { return }
								const text = this.#history.at(this.#historyIndex =
									(this.#historyIndex + (key === "ArrowDown"
										? 1
										: -1)) % length)
								if (isUndefined(text)) { return }
								let writing = true
								const write = buffer.setValue(text)
									.finally(() => { writing = false })
									.then(async () => this.syncBuffer(terminals, false))
								// eslint-disable-next-line no-unmodified-loop-condition
								while (writing) {
									// eslint-disable-next-line no-await-in-loop
									await this.syncBuffer(terminals, false)
								}
								await write
							}).catch(logError)
							break
						default:
							return
					}
					block = true
					consumeEvent(domEvent)
				}),
				terminal.onResize(() => {
					if (resizing) { return }
					resizing = true
					this.syncBuffer([terminal])
						.finally(() => { resizing = false })
						.catch(logError)
				}),
			].map(disposer0 => () => { disposer0.dispose() }),
		)
		this.onExit.finally(() => { disposer.call() })
		await this.write(this.log.history, [terminal])
	}

	protected async eval(): Promise<void> {
		const { buffer, console, lock, terminals } = this,
			code = await lock.acquire(ConsolePseudoterminal.syncLock, async () => {
				const { string: ret } = await buffer.clear(),
					{ length } = this.#history
				this.#history.splice(length - 1, 1, ret, "")
				this.#historyIndex = length
				await this.syncBuffer(terminals, false)
				return ret
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
		terminals: readonly Terminal[] = this.terminals,
		lock = true,
	): Promise<void> {
		const terminals0 = [...terminals]
		return new Promise((resolve, reject) => {
			acquireConditionally(
				this.lock,
				ConsolePseudoterminal.syncLock,
				lock,
				async () => {
					const writers = terminals0.map(async terminal => {
						const editor = this.#editors.get(terminal),
							info = await CursoredText.info(
								terminal,
								this.buffer.value,
								editor?.startX,
							),
							{ rows, buffer: { active } } = terminal,
							{ baseY } = active,
							startBaseY = editor?.startYMarker?.line ?? baseY,
							lastRenderEndY = editor?.renderEndY ?? 0,
							renderRows = Math.min(info.rows, rows),
							renderStartY = info.rows - renderRows,
							prerenderStartY = startBaseY + lastRenderEndY - baseY,
							skipPreRenderRows = Math.max(-prerenderStartY, 0),
							firstUp = renderRows - 1,
							secondUp = info.rows - 1 - info.cursor[1]
						await tWritePromise(
							terminal,
							`${ansi.cursor.position(
								1 + prerenderStartY + skipPreRenderRows,
								1 + (lastRenderEndY > 0 ? 0 : info.startX),
							)}${ansi.erase.display()}${info.lines.slice(
								lastRenderEndY + skipPreRenderRows,
								info.rows,
							).join(NORMALIZED_LINE_FEED)}${ansi.cursor.horizontalAbsolute(
								1 + (renderStartY > 0 ? 0 : info.startX),
							)}${firstUp > 0 ? ansi.cursor.up(firstUp) : ""
							}${ansi.erase.display()}${info.lines.slice(
								renderStartY,
								info.rows,
							).join(NORMALIZED_LINE_FEED)}${ansi.cursor.horizontalAbsolute(
								1 + (info.cursor[1] < renderStartY ? 0 : info.cursor[0]),
							)}${secondUp > 0 ? ansi.cursor.up(secondUp) : ""}`,
						)
						if (editor) { editor.renderEndY = info.rows - 1 }
					})
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
			text = `${ansi.erase.inLine() + normalizeText(events
				.map(event => ConsolePseudoterminal.format(event)).join("\n"))
				.replace(
					replaceAllRegex(NORMALIZED_LINE_FEED),
					`${NORMALIZED_LINE_FEED}${ansi.erase.inLine()}`,
				)}${NORMALIZED_LINE_FEED}`
		await acquireConditionally(
			this.lock,
			ConsolePseudoterminal.syncLock,
			lock,
			async () => {
				await Promise.allSettled(terminals0.map(async terminal => {
					const { buffer: { active } } = terminal,
						editor = this.#editors.get(terminal),
						{ baseY } = active,
						startBaseY = editor?.startYMarker?.line ?? baseY + active.cursorY
					await tWritePromise(terminal, `${ansi.cursor.position(
						1 + (startBaseY - baseY),
						1,
					)}${ansi.erase.display()}${text}`)
					this.#setEditor(terminal, {
						close() { this.startYMarker?.dispose() },
						renderEndY: 0,
						startX: active.cursorX,
						startYMarker: terminal.registerMarker(),
					})
				}))
				await this.syncBuffer(terminals0, false)
			},
		)
	}

	#setEditor(
		terminal: Terminal,
		editor?: ConsolePseudoterminal.$Editor,
	): void {
		this.#editors.get(terminal)?.close()
		if (editor) {
			this.#editors.set(terminal, editor)
		} else {
			this.#editors.delete(terminal)
		}
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
		inSet(SUPPORTED_PLATFORMS, Platform.CURRENT)
			? PLATFORM_PSEUDOTERMINALS[deopaque(Platform.CURRENT)]
			: null
}
