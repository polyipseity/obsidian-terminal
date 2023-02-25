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
	rangeCodePoint,
	replaceAllRegex,
} from "sources/utils/util"
import { constant, isUndefined, padEnd, range, size } from "lodash"
import AsyncLock from "async-lock"
import ansi from "ansi-escape-sequences"
import { codePoint } from "sources/utils/types"

export const ESCAPE_SEQUENCE_INTRODUCER = "\u001b"
const ESC = ESCAPE_SEQUENCE_INTRODUCER
export const CONTROL_SEQUENCE_INTRODUCER = `${ESC}[`
const CSI = CONTROL_SEQUENCE_INTRODUCER
export const
	FUNCTION_IDENTIFIER_PREFIXES =
		rangeCodePoint(codePoint("\x3c"), codePoint("\x3f")),
	FUNCTION_IDENTIFIER_INTERMEDIATES =
		rangeCodePoint(codePoint("\x20"), codePoint("\x2f")),
	FUNCTION_IDENTIFIER_FINAL = deepFreeze({
		"long": rangeCodePoint(codePoint("\x30"), codePoint("\x7e")),
		"short": rangeCodePoint(codePoint("\x40"), codePoint("\x7e")),
	} as const),
	ALL_CSI_IDENTIFIERS = deepFreeze(cartesianProduct(
		FUNCTION_IDENTIFIER_PREFIXES,
		FUNCTION_IDENTIFIER_INTERMEDIATES,
		FUNCTION_IDENTIFIER_INTERMEDIATES,
		FUNCTION_IDENTIFIER_FINAL.short,
	).map(([prefix, intermediates0, intermediates1, final]) => ({
		final,
		intermediates: `${intermediates0}${intermediates1}`,
		prefix,
	} as const satisfies IFunctionIdentifier))),
	ALL_DCS_IDENTIFIERS = ALL_CSI_IDENTIFIERS,
	ALL_ESC_IDENTIFIERS = deepFreeze(cartesianProduct(
		FUNCTION_IDENTIFIER_INTERMEDIATES,
		FUNCTION_IDENTIFIER_INTERMEDIATES,
		FUNCTION_IDENTIFIER_FINAL.long,
	).map(([intermediates0, intermediates1, final]) => ({
		final,
		intermediates: `${intermediates0}${intermediates1}`,
	} as const satisfies IFunctionIdentifier))),
	// eslint-disable-next-line @typescript-eslint/no-magic-numbers
	MOST_OSC_IDENTIFIERS = range(1000)

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
	public readonly terminal
	protected readonly lock = new AsyncLock()
	#value: readonly string[] = [""]

	public constructor(options?: TerminalTextArea.Options) {
		this.terminal = new Terminal({
			...options,
			...{
				cols: TerminalTextArea.minCols,
				rows: TerminalTextArea.minRows,
			} satisfies TerminalTextArea.PredefinedOptions,
		})
		const { terminal: { parser } } = this,
			handler = constant(true)
		for (const id of ALL_CSI_IDENTIFIERS) {
			parser.registerCsiHandler(id, handler)
		}
		for (const id of ALL_DCS_IDENTIFIERS) {
			parser.registerDcsHandler(id, handler)
		}
		for (const id of ALL_ESC_IDENTIFIERS) {
			parser.registerEscHandler(id, handler)
		}
		for (const id of MOST_OSC_IDENTIFIERS) {
			parser.registerOscHandler(id, handler)
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
			for (let datum = data0.shift();
				!isUndefined(datum);
				datum = data0.shift()) {
				const { active: { cursorX, cursorY } } = buffer,
					lines = this.#value.map(size)
				switch (datum) {
					case "\u007f":
						if (cursorX > 0) {
							// eslint-disable-next-line no-await-in-loop
							await writePromise(terminal, `\b${CSI}P`)
							--lines[cursorY]
						} else if (cursorY > 0) {
							const length = this.#value[cursorY - 1]?.length ?? 0,
								remain = this.#value[cursorY] ?? ""
							// eslint-disable-next-line no-await-in-loop
							await writePromise(
								terminal,
								`${ansi.cursor.up()}${ansi.cursor
									.horizontalAbsolute(length + 1)}`,
							)
							lines.pop()
							data0.unshift(
								...remain,
								ansi.cursor.horizontalAbsolute(length + 1),
							)
						}
						break
					case "\r": {
						const remain = this.#value[cursorY]?.slice(cursorX) ?? ""
						// eslint-disable-next-line no-await-in-loop
						await writelnPromise(terminal, `${ansi.erase.inLine()}\r`)
						lines.push(remain.length)
						data0.unshift(...remain, ansi.cursor.horizontalAbsolute(1))
						break
					}
					default:
						// eslint-disable-next-line no-await-in-loop
						await writePromise(terminal, datum)
						++lines[cursorY]
						break
				}
				this.#sync(lines)
			}
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
			this.#sync([0])
		})
	}

	public dispose(): void {
		this.terminal.dispose()
	}

	#sync(lines: readonly number[]): void {
		const { terminal, lock } = this,
			{ buffer: { active } } = terminal
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
					}
					return left
				}, []),
			)
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
