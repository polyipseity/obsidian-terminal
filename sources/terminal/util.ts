import type { DeepReadonly, DeepRequired } from "ts-essentials"
import type {
	IDisposable,
	IFunctionIdentifier,
	Terminal,
	ITerminalOptions as TerminalOptions,
	ITerminalInitOnlyOptions as TerminalOptionsInit,
} from "xterm"
import {
	acquireConditionally,
	alternativeRegExp,
	cartesianProduct,
	clear,
	codePoint,
	deepFreeze,
	dynamicRequireLazy,
	insertAt,
	lazyProxy,
	rangeCodePoint,
	removeAt,
	replaceAllRegex,
} from "@polyipseity/obsidian-plugin-library"
import { isUndefined, range } from "lodash-es"
import AsyncLock from "async-lock"
import { BUNDLE } from "../import.js"
import { MAX_LOCK_PENDING } from "../magic.js"
import ansi from "ansi-escape-sequences"
import { Set as valueSet } from "immutable"

const xterm = dynamicRequireLazy<typeof import("xterm")
>(BUNDLE, "xterm")

type IFunctionIdentifier0 = DeepReadonly<DeepRequired<IFunctionIdentifier>>
export const ESCAPE_SEQUENCE_INTRODUCER = "\u001b" as const
const ESC = ESCAPE_SEQUENCE_INTRODUCER
export const CONTROL_SEQUENCE_INTRODUCER = `${ESC}[` as const
const CSI = CONTROL_SEQUENCE_INTRODUCER
export const
	DEVICE_CONTROL_STRING = `${ESC}P` as const,
	OPERATING_SYSTEM_COMMAND = `${ESC}]` as const,
	PREFIX_IDENTIFIERS = deepFreeze([
		"",
		...rangeCodePoint(codePoint("\x3c"), codePoint("\x40")),
	]),
	INTERMEDIATES_IDENTIFIERS = deepFreeze([
		"",
		...rangeCodePoint(codePoint("\x20"), codePoint("\x30")),
	]),
	LONG_FINAL_IDENTIFIERS = rangeCodePoint(codePoint("\x30"), codePoint("\x7f")),
	SHORT_FINAL_IDENTIFIERS =
		rangeCodePoint(codePoint("\x40"), codePoint("\x7f")),
	CSI_IDENTIFIERS = lazyProxy(() =>
		valueSet<IFunctionIdentifier0>(cartesianProduct(
			PREFIX_IDENTIFIERS,
			INTERMEDIATES_IDENTIFIERS,
			INTERMEDIATES_IDENTIFIERS,
			SHORT_FINAL_IDENTIFIERS,
		).map(([prefix, intermediates0, intermediates1, final]) => ({
			final,
			intermediates: `${intermediates0}${intermediates1}`,
			prefix,
		})))),
	DCS_IDENTIFIERS = CSI_IDENTIFIERS,
	ESC_IDENTIFIERS = lazyProxy(() =>
		valueSet<IFunctionIdentifier0>(cartesianProduct(
			INTERMEDIATES_IDENTIFIERS,
			INTERMEDIATES_IDENTIFIERS,
			LONG_FINAL_IDENTIFIERS,
		).map(([intermediates0, intermediates1, final]) => ({
			final,
			intermediates: `${intermediates0}${intermediates1}`,
			prefix: "",
		})))),
	// eslint-disable-next-line @typescript-eslint/no-magic-numbers
	OSC_IDENTIFIERS = lazyProxy(() => valueSet(range(2022))),
	MAX_CHARACTER_WIDTH = 2,
	NORMALIZED_LINE_FEED = "\r\n"

export function normalizeText(text: string): string {
	return text
		.replace(replaceAllRegex(NORMALIZED_LINE_FEED), "\n")
		.replace(replaceAllRegex("\n"), NORMALIZED_LINE_FEED)
}

export async function writePromise(
	self0: Terminal,
	data: Uint8Array | string,
): Promise<void> {
	return new Promise(resolve => { self0.write(data, resolve) })
}

export class TerminalTextArea implements IDisposable {
	protected static readonly margin = MAX_CHARACTER_WIDTH
	protected static readonly splitters = alternativeRegExp([ESC, "\u007f", "\r"])
	protected static readonly writeLock = "write"
	// See https://xtermjs.org/docs/api/vtfeatures/
	protected static readonly allowedIdentifiers = deepFreeze({
		csi: valueSet<IFunctionIdentifier0>([
			{ "final": "@", intermediates: "", prefix: "" },
			{ "final": "A", intermediates: "", prefix: "" },
			{ "final": "B", intermediates: "", prefix: "" },
			{ "final": "C", intermediates: "", prefix: "" },
			{ "final": "D", intermediates: "", prefix: "" },
			{ "final": "E", intermediates: "", prefix: "" },
			{ "final": "F", intermediates: "", prefix: "" },
			{ "final": "G", intermediates: "", prefix: "" },
			{ "final": "H", intermediates: "", prefix: "" },
			{ "final": "I", intermediates: "", prefix: "" },
			{ "final": "J", intermediates: "", prefix: "" },
			{ "final": "J", intermediates: "", prefix: "?" },
			{ "final": "K", intermediates: "", prefix: "" },
			{ "final": "K", intermediates: "", prefix: "?" },
			{ "final": "L", intermediates: "", prefix: "" },
			{ "final": "M", intermediates: "", prefix: "" },
			{ "final": "P", intermediates: "", prefix: "" },
			{ "final": "S", intermediates: "", prefix: "" },
			{ "final": "T", intermediates: "", prefix: "" },
			{ "final": "X", intermediates: "", prefix: "" },
			{ "final": "Z", intermediates: "", prefix: "" },
			{ "final": "`", intermediates: "", prefix: "" },
			{ "final": "a", intermediates: "", prefix: "" },
			{ "final": "b", intermediates: "", prefix: "" },
			{ "final": "d", intermediates: "", prefix: "" },
			{ "final": "e", intermediates: "", prefix: "" },
			{ "final": "f", intermediates: "", prefix: "" },
			{ "final": "g", intermediates: "", prefix: "" },
			{ "final": "h", intermediates: "", prefix: "" },
			{ "final": "h", intermediates: "", prefix: "?" },
			{ "final": "l", intermediates: "", prefix: "" },
			{ "final": "l", intermediates: "", prefix: "?" },
			{ "final": "m", intermediates: "", prefix: "" },
			{ "final": "n", intermediates: "", prefix: "" },
			{ "final": "m", intermediates: "", prefix: "?" },
			{ "final": "p", intermediates: "$", prefix: "" },
			{ "final": "p", intermediates: "", prefix: "!" },
			{ "final": "q", intermediates: "\"", prefix: "" },
			{ "final": "q", intermediates: "SP", prefix: "" },
			{ "final": "r", intermediates: "", prefix: "" },
			{ "final": "s", intermediates: "", prefix: "" },
			{ "final": "u", intermediates: "", prefix: "" },
		]),
		dcs: valueSet<IFunctionIdentifier0>([
			{ "final": "q", intermediates: "", prefix: "" },
			{ "final": "|", intermediates: "\\", prefix: "" },
			{ "final": "q", intermediates: "", prefix: "+" },
			{ "final": "p", intermediates: "", prefix: "+" },
			{ "final": "q", intermediates: "", prefix: "$" },
		]),
		esc: valueSet<IFunctionIdentifier0>([
			{ "final": "7", intermediates: "", prefix: "" },
			{ "final": "8", intermediates: "", prefix: "" },
			{ "final": "D", intermediates: "", prefix: "" },
			{ "final": "E", intermediates: "", prefix: "" },
			{ "final": "H", intermediates: "", prefix: "" },
			{ "final": "M", intermediates: "", prefix: "" },
			{ "final": "P", intermediates: "", prefix: "" },
			{ "final": "[", intermediates: "", prefix: "" },
			{ "final": "\\", intermediates: "", prefix: "" },
			{ "final": "]", intermediates: "", prefix: "" },
			{ "final": "^", intermediates: "", prefix: "" },
			{ "final": "_", intermediates: "", prefix: "" },
		]),
		// eslint-disable-next-line @typescript-eslint/no-magic-numbers
		osc: valueSet([0, 1, 2, 4, 8, 10, 11, 12, 104, 110, 111, 112]),
	})

	public readonly terminal
	protected readonly lock = new AsyncLock({ maxPending: MAX_LOCK_PENDING })
	readonly #cell
	#sequence = false
	readonly #widths = [0]
	#value: CursoredText = deepFreeze({ cursor: 0, string: "" })

	readonly #cursor = {
		xx: 0,
	}

	public constructor(options?: TerminalTextArea.Options) {
		this.terminal = new xterm.Terminal({
			...options,
			...{
				cols: TerminalTextArea.margin,
				rows: TerminalTextArea.margin,
			} satisfies TerminalTextArea.PredefinedOptions,
		})
		const { terminal: { buffer, parser } } = this,
			handler = ((): (handled: boolean) => () => boolean => {
				const
					handler0 = (handled: boolean) => (): boolean => {
						this.#sequence = false
						return handled
					},
					trueHandler = handler0(true),
					falseHandler = handler0(false)
				return (cancel: boolean): () => boolean =>
					cancel ? trueHandler : falseHandler
			})()
		this.#cell = buffer.active.getNullCell()
		for (const id of CSI_IDENTIFIERS) {
			parser.registerCsiHandler(
				id,
				handler(TerminalTextArea.allowedIdentifiers.csi.has(id)),
			)
		}
		for (const id of DCS_IDENTIFIERS) {
			parser.registerDcsHandler(
				id,
				handler(TerminalTextArea.allowedIdentifiers.dcs.has(id)),
			)
		}
		for (const id of ESC_IDENTIFIERS) {
			parser.registerEscHandler(
				id,
				handler(TerminalTextArea.allowedIdentifiers.esc.has(id)),
			)
		}
		for (const id of OSC_IDENTIFIERS) {
			parser.registerOscHandler(
				id,
				handler(TerminalTextArea.allowedIdentifiers.osc.has(id)),
			)
		}
	}

	public get value(): CursoredText {
		return this.#value
	}

	public async write(data: string, lock = true): Promise<void> {
		const { terminal, lock: alock } = this,
			{ buffer: { active } } = terminal,
			split = (str: string): string[] => str.split(TerminalTextArea.splitters),
			data0 = split(data)
		await acquireConditionally(
			alock,
			TerminalTextArea.writeLock,
			lock,
			async () => {
				for (let datum = data0.shift();
					!isUndefined(datum);
					datum = data0.shift()) {
					const { cursorX, cursorY } = active,
						lineWidth = this.#widths[cursorY] ?? 0,
						line = active.getLine(cursorY)
					switch (datum) {
						case "": break
						case ESC: {
							// eslint-disable-next-line no-await-in-loop
							await writePromise(terminal, datum)
							const [seq] = data0
							if (!isUndefined(seq)) {
								this.#sequence = true
								let consumed = 0
								for (const char of seq) {
									// eslint-disable-next-line no-await-in-loop
									await writePromise(terminal, char)
									consumed += char.length
									// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
									if (!this.#sequence) { break }
								}
								this.#sequence = false
								data0[0] = seq.slice(consumed)
							}
							break
						}
						case "\r": {
							const rest =
								line?.translateToString(false, cursorX, lineWidth) ?? ""
							terminal.resize(terminal.cols, terminal.rows + 1)
							// eslint-disable-next-line no-await-in-loop
							await writePromise(
								terminal,
								`${ansi.erase.inLine()}${ansi.cursor.down()}${CSI}L`,
							)
							this.#widths[cursorY] = cursorX
							insertAt(this.#widths, cursorY + 1, 0)
							data0.unshift(...split(`${rest}${ansi.cursor
								.horizontalAbsolute(1)}`))
							break
						}
						case "\u007f": {
							if (line) {
								let width = 0
								for (let xx = cursorX - 1, cell0 = line.getCell(xx, this.#cell);
									width <= 0 && cell0;
									cell0 = line.getCell(--xx, this.#cell)) {
									width = cell0.getWidth()
								}
								if (width > 0) {
									// eslint-disable-next-line no-await-in-loop
									await writePromise(
										terminal,
										`${ansi.cursor.back(width)}${CSI}${width}P`,
									)
									this.#widths[cursorY] -= width
								} else if (cursorY > 0) {
									const
										rest = line.translateToString(false, 0, lineWidth),
										prev = this.#widths[cursorY - 1] ?? 0
									// eslint-disable-next-line no-await-in-loop
									await writePromise(
										terminal,
										`${CSI}M${ansi.cursor.up()}${ansi.cursor
											.horizontalAbsolute(1 + prev)}`,
									)
									removeAt(this.#widths, cursorY)
									data0.unshift(...split(`${rest}${ansi.cursor
										.horizontalAbsolute(1 + prev)}`))
								}
							}
							break
						}
						default: {
							const reserve = MAX_CHARACTER_WIDTH * datum.length
							terminal.resize(terminal.cols + reserve, terminal.rows)
							// eslint-disable-next-line no-await-in-loop
							await writePromise(
								terminal,
								`${CSI}${reserve}@${datum}`,
							)
							this.#widths[cursorY] += reserve
							const lossX = reserve - (active.cursorX - cursorX)
							// eslint-disable-next-line no-await-in-loop
							await writePromise(terminal, `${CSI}${lossX}P`)
							this.#widths[cursorY] -= lossX
							break
						}
					}
					// eslint-disable-next-line no-await-in-loop
					await this.#sync()
				}
			},
		)
	}

	public async setValue(value: string): Promise<void> {
		const norm = normalizeText(value)
			.replace(replaceAllRegex(NORMALIZED_LINE_FEED), "\r")
		await this.lock.acquire(TerminalTextArea.writeLock, async () => {
			await this.clear(false)
			await this.write(norm, false)
		})
	}

	public async clear(lock = true): Promise<typeof this["value"]> {
		return acquireConditionally(
			this.lock,
			TerminalTextArea.writeLock,
			lock,
			async () => {
				const ret = this.value
				this.terminal.reset()
				clear(this.#widths)
				this.#widths.push(0)
				await this.#sync()
				return ret
			},
		)
	}

	public dispose(): void {
		this.terminal.dispose()
	}

	async #sync(): Promise<void> {
		const { terminal, lock } = this,
			{ buffer: { active } } = terminal
		if (!lock.isBusy(TerminalTextArea.writeLock)) { throw new Error() }
		let { cursorX, cursorY } = active
		if (cursorY >= this.#widths.length) {
			cursorY = this.#widths.length - 1
		}
		if (cursorX > (this.#widths[cursorY] ?? 0)) {
			cursorX = this.#widths[cursorY] ?? 0
		}
		await writePromise(terminal, ansi.cursor.position(1 + cursorY, 1 + cursorX))
		const values: readonly [before: string[], after: string[]] = [[], []]
		let yy = 0
		for (const width of this.#widths) {
			const line = active.getLine(yy)
			if (line && yy === cursorY) {
				const direction = cursorX - this.#cursor.xx < 0 ? -1 : 1
				for (let cell = line.getCell(cursorX, this.#cell);
					cell && cell.getWidth() <= 0;
					cell = line.getCell(cursorX += direction, this.#cell)) {
					// Noop
				}
				values[0].push(line.translateToString(false, 0, cursorX))
				values[1].push(line.translateToString(false, cursorX, width))
				// eslint-disable-next-line no-await-in-loop
				await writePromise(
					terminal,
					ansi.cursor.horizontalAbsolute(1 + cursorX),
				)
			} else {
				values[cursorY > yy ? 0 : 1]
					.push(line?.translateToString(false, 0, width) ?? "")
			}
			++yy
		}
		const before = values[0].join("\n")
		this.#value = deepFreeze({
			cursor: before.length,
			string: `${before}${values[1].join("\n")}`,
		})
		this.#cursor.xx = cursorX
		terminal.resize(
			Math.max(...this.#widths) + TerminalTextArea.margin,
			this.#widths.length + TerminalTextArea.margin,
		)
	}
}
export namespace TerminalTextArea {
	type InitialOptions = Readonly<TerminalOptions & TerminalOptionsInit>
	export type PredefinedOptions = {
		readonly [K in ("cols" | "rows")]: InitialOptions[K]
	}
	export type Options = Omit<InitialOptions, keyof PredefinedOptions>
}

export interface CursoredText {
	readonly string: string
	readonly cursor: number
}
export namespace CursoredText {
	export interface Info {
		readonly lines: readonly string[]
		readonly cols: number
		readonly rows: number
		readonly cursor: readonly [x: number, y: number]
		readonly startX: number
		readonly endX: number
	}
	export async function info(
		terminal: Terminal,
		text: CursoredText,
		startX = 0,
	): Promise<Info> {
		const { options, cols } = terminal,
			{ string, cursor } = text,
			before = normalizeText(string.slice(0, cursor)),
			after = normalizeText(string.slice(cursor)),
			simulation = new xterm.Terminal({
				...options,
				cols,
				rows: 1,
				scrollback: Infinity,
			}),
			{ buffer: { active } } = simulation,
			{ baseY: startBaseY } = active
		await writePromise(
			simulation,
			`${ansi.cursor.horizontalAbsolute(1 + startX)}${before}`,
		)
		const { cursorX, baseY: cursorBaseY } = active
		await writePromise(simulation, after)
		const { cursorX: endX, baseY: endBaseY } = active
		return deepFreeze({
			cols,
			cursor: [cursorX, cursorBaseY - startBaseY],
			endX,
			lines: range(startBaseY, endBaseY + 1)
				.map(yy => active.getLine(yy)
					?.translateToString(
						true,
						yy === startBaseY ? startX : 0,
						yy === endBaseY ? endX : cols,
					) ?? ""),
			rows: endBaseY - startBaseY + 1,
			startX,
		})
	}
}
