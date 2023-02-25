import type { DeepReadonly, DeepRequired } from "ts-essentials"
import {
	type IDisposable,
	type IFunctionIdentifier,
	Terminal,
	type ITerminalOptions as TerminalOptions,
	type ITerminalInitOnlyOptions as TerminalOptionsInit,
} from "xterm"
import {
	cartesianProduct,
	deepFreeze,
	insertAt,
	rangeCodePoint,
	removeAt,
	replaceAllRegex,
} from "sources/utils/util"
import { isUndefined, padEnd, range, size } from "lodash"
import AsyncLock from "async-lock"
import ansi from "ansi-escape-sequences"
import { codePoint } from "sources/utils/types"
import { Set as valueSet } from "immutable"

type IFunctionIdentifier0 = DeepReadonly<DeepRequired<IFunctionIdentifier>>
export const ESCAPE_SEQUENCE_INTRODUCER = "\u001b"
const ESC = ESCAPE_SEQUENCE_INTRODUCER
export const CONTROL_SEQUENCE_INTRODUCER = `${ESC}[`
const CSI = CONTROL_SEQUENCE_INTRODUCER
export const
	FUNCTION_IDENTIFIER_PREFIXES = deepFreeze([
		"",
		...rangeCodePoint(codePoint("\x3c"), codePoint("\x40")),
	] as const),
	FUNCTION_IDENTIFIER_INTERMEDIATES = deepFreeze([
		"",
		...rangeCodePoint(codePoint("\x20"), codePoint("\x30")),
	] as const),
	FUNCTION_IDENTIFIER_FINAL = deepFreeze({
		"long": rangeCodePoint(codePoint("\x30"), codePoint("\x7f")),
		"short": rangeCodePoint(codePoint("\x40"), codePoint("\x7f")),
	} as const),
	ALL_CSI_IDENTIFIERS = valueSet<IFunctionIdentifier0>(cartesianProduct(
		FUNCTION_IDENTIFIER_PREFIXES,
		FUNCTION_IDENTIFIER_INTERMEDIATES,
		FUNCTION_IDENTIFIER_INTERMEDIATES,
		FUNCTION_IDENTIFIER_FINAL.short,
	).map(([prefix, intermediates0, intermediates1, final]) => ({
		final,
		intermediates: `${intermediates0}${intermediates1}`,
		prefix,
	} as const))),
	ALL_DCS_IDENTIFIERS = ALL_CSI_IDENTIFIERS,
	ALL_ESC_IDENTIFIERS = valueSet<IFunctionIdentifier0>(cartesianProduct(
		FUNCTION_IDENTIFIER_INTERMEDIATES,
		FUNCTION_IDENTIFIER_INTERMEDIATES,
		FUNCTION_IDENTIFIER_FINAL.long,
	).map(([intermediates0, intermediates1, final]) => ({
		final,
		intermediates: `${intermediates0}${intermediates1}`,
		prefix: "",
	} as const))),
	// eslint-disable-next-line @typescript-eslint/no-magic-numbers
	MOST_OSC_IDENTIFIERS = valueSet(range(2022))

export function processText(text: string): string {
	return text
		.replace(replaceAllRegex("\r\n"), "\n")
		.replace(replaceAllRegex("\n"), "\r\n")
}

export async function writePromise(
	self: Terminal,
	data: Uint8Array | string,
): Promise<void> {
	return new Promise(resolve => { self.write(data, resolve) })
}

export async function writelnPromise(
	self: Terminal,
	data: Uint8Array | string,
): Promise<void> {
	return new Promise(resolve => { self.writeln(data, resolve) })
}

export class TerminalTextArea implements IDisposable {
	protected static readonly margin = 2
	protected static readonly minCols = TerminalTextArea.margin
	protected static readonly minRows = TerminalTextArea.margin
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
		osc: valueSet<number>([0, 1, 2, 4, 8, 10, 11, 12, 104, 110, 111, 112]),
	})

	public readonly terminal
	protected readonly lock = new AsyncLock()
	#sequence = false
	#value = deepFreeze([""])

	public constructor(options?: TerminalTextArea.Options) {
		this.terminal = new Terminal({
			...options,
			...{
				cols: TerminalTextArea.minCols,
				rows: TerminalTextArea.minRows,
			} satisfies TerminalTextArea.PredefinedOptions,
		})
		const { terminal: { parser } } = this,
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
		for (const id of ALL_CSI_IDENTIFIERS) {
			parser.registerCsiHandler(
				id,
				handler(TerminalTextArea.allowedIdentifiers.csi.has(id)),
			)
		}
		for (const id of ALL_DCS_IDENTIFIERS) {
			parser.registerDcsHandler(
				id,
				handler(TerminalTextArea.allowedIdentifiers.dcs.has(id)),
			)
		}
		for (const id of ALL_ESC_IDENTIFIERS) {
			parser.registerEscHandler(
				id,
				handler(TerminalTextArea.allowedIdentifiers.esc.has(id)),
			)
		}
		for (const id of MOST_OSC_IDENTIFIERS) {
			parser.registerOscHandler(
				id,
				handler(TerminalTextArea.allowedIdentifiers.osc.has(id)),
			)
		}
	}

	public get values(): readonly [string, string] {
		const { terminal: { buffer: { active: { cursorX, cursorY } } } } = this
		return deepFreeze([
			[
				...this.#value.slice(0, cursorY),
				this.#value[cursorY]?.slice(0, cursorX) ?? "",
			].join("\n"),
			[
				this.#value[cursorY]?.slice(cursorX) ?? "",
				...this.#value.slice(cursorY + 1),
			].join("\n"),
		])
	}

	public async write(data: string): Promise<void> {
		const { terminal, lock } = this,
			{ buffer } = terminal,
			data0 = Array.from(data)
		await lock.acquire(TerminalTextArea.writeLock, async () => {
			let postSequence = false
			for (let datum = data0.shift();
				!isUndefined(datum);
				datum = data0.shift()) {
				if (this.#sequence) {
					// eslint-disable-next-line no-await-in-loop
					await writePromise(terminal, datum)
					continue
				}
				const { active } = buffer,
					{ cursorX, cursorY } = active,
					lines = this.#value.map(size),
					current = this.#value[cursorY] ?? ""
				if (postSequence) {
					// eslint-disable-next-line no-await-in-loop
					await this.#sync(lines)
					postSequence = false
				}
				switch (datum) {
					case ESC: {
						// eslint-disable-next-line no-await-in-loop
						await writePromise(terminal, datum)
						this.#sequence = true
						postSequence = true
						continue
					}
					case "\u007f": {
						if (cursorX > 0) {
							// eslint-disable-next-line no-await-in-loop
							await writePromise(terminal, `\b${CSI}P`)
							--lines[cursorY]
						} else if (cursorY > 0) {
							const length = this.#value[cursorY - 1]?.length ?? 0
							// eslint-disable-next-line no-await-in-loop
							await writePromise(
								terminal,
								`${CSI}M${ansi.cursor.up()}${ansi.cursor
									.horizontalAbsolute(length + 1)}`,
							)
							removeAt(lines, cursorY)
							data0.unshift(
								...current,
								...ansi.cursor.horizontalAbsolute(length + 1),
							)
						}
						break
					}
					case "\r": {
						const remain = this.#value[cursorY]?.slice(cursorX) ?? ""
						// eslint-disable-next-line no-await-in-loop
						await writePromise(
							terminal,
							`${ansi.erase.inLine()}${ansi.cursor.down()}${CSI}L`,
						)
						lines[cursorY] -= remain.length
						insertAt(lines, cursorY + 1, 0)
						data0.unshift(...remain, ...ansi.cursor.horizontalAbsolute(1))
						break
					}
					default: {
						// eslint-disable-next-line no-await-in-loop
						await writePromise(terminal, `${CSI}@${datum}`)
						++lines[cursorY]
						break
					}
				}
				// eslint-disable-next-line no-await-in-loop
				await this.#sync(lines)
			}
			if (postSequence) { await this.#sync(this.#value.map(size)) }
		})
	}

	public async clear(): Promise<void> {
		const { terminal, lock } = this
		await lock.acquire(TerminalTextArea.writeLock, async () => {
			await writePromise(
				terminal,
				// eslint-disable-next-line @typescript-eslint/no-magic-numbers
				`${ansi.erase.display(2)}${ansi.cursor.position()}`,
			)
			await this.#sync([0])
		})
	}

	public dispose(): void {
		this.terminal.dispose()
	}

	async #sync(lines: readonly number[]): Promise<void> {
		const { terminal, lock } = this,
			{ buffer: { active } } = terminal,
			{ cursorX, cursorY } = active
		if (!lock.isBusy(TerminalTextArea.writeLock)) { throw new Error() }
		this.#value =
			deepFreeze(
				range(lines.length).reduce<string[]>((left, right) => {
					const line = active.getLine(right)
					if (line) {
						let { length } = left
						if (line.isWrapped && length > 0) {
							left[length - 1] += line.translateToString(true)
						} else {
							length = left.push(line.translateToString(true))
						}
						left[length - 1] = padEnd(left[length - 1], lines[right], " ")
							.slice(0, lines[right])
					}
					return left
				}, []),
			)
		const yy = Math.min(cursorY, this.#value.length - 1)
		await writePromise(terminal, ansi.cursor.position(
			1 + yy,
			1 + Math.min(cursorX, this.#value[yy]?.length ?? 0),
		))
		terminal.resize(
			Math.max(
				TerminalTextArea.minCols,
				...this.#value.map(line => line.length + TerminalTextArea.margin),
			),
			Math.max(
				TerminalTextArea.minRows,
				this.#value.length + TerminalTextArea.margin,
			),
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
