import {
	type IDisposable,
	Terminal,
	type ITerminalOptions as TerminalOptions,
	type ITerminalInitOnlyOptions as TerminalOptionsInit,
} from "xterm"
import { deepFreeze, replaceAllRegex } from "sources/utils/util"
import { isUndefined, range } from "lodash"
import ansi from "ansi-escape-sequences"

export const ESCAPE_SEQUENCE_INTRODUCER = "\u001b"
const ESC = ESCAPE_SEQUENCE_INTRODUCER
export const CONTROL_SEQUENCE_INTRODUCER = `${ESC}[`
const CSI = CONTROL_SEQUENCE_INTRODUCER

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
	protected static readonly minCols = 1
	protected static readonly minRows = 1
	public readonly terminal
	#value: readonly string[] = [""]

	public constructor(options?: TerminalTextArea.Options) {
		this.terminal = new Terminal({
			...options,
			...{
				cols: TerminalTextArea.minCols,
				rows: TerminalTextArea.minRows,
			} satisfies TerminalTextArea.PredefinedOptions,
		})
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
		const { terminal } = this,
			{ buffer } = terminal,
			data0 = Array.from(data)
		for (let datum = data0.shift();
			!isUndefined(datum);
			datum = data0.shift()) {
			const { active: { cursorX, cursorY } } = buffer
			let lines = this.#value.length
			switch (datum) {
				case "\u007f":
					if (cursorX > 0) {
						// eslint-disable-next-line no-await-in-loop
						await writePromise(terminal, `\b${CSI}P`)
					} else if (cursorY > 0) {
						const length = this.#value[cursorY - 1]?.length ?? 0,
							remain = this.#value[cursorY] ?? ""
						// eslint-disable-next-line no-await-in-loop
						await writePromise(
							terminal,
							`${ansi.cursor.up()}${ansi.cursor
								.horizontalAbsolute(length + 1)}`,
						)
						--lines
						data0.unshift(...remain, ansi.cursor.horizontalAbsolute(length + 1))
					}
					break
				case "\r": {
					const remain = this.#value[cursorY]?.slice(cursorX) ?? ""
					// eslint-disable-next-line no-await-in-loop
					await writelnPromise(terminal, `${ansi.erase.inLine()}\r`)
					++lines
					data0.unshift(...remain, ansi.cursor.horizontalAbsolute(1))
					break
				}
				default:
					// eslint-disable-next-line no-await-in-loop
					await writePromise(terminal, datum)
					break
			}
			this.#sync(lines)
		}
	}

	public async clear(): Promise<void> {
		const { terminal } = this
		await writePromise(
			terminal,
			// eslint-disable-next-line @typescript-eslint/no-magic-numbers
			`${ansi.erase.display(2)}${ansi.cursor.position()}`,
		)
		this.#sync(TerminalTextArea.minRows)
	}

	public dispose(): void {
		this.terminal.dispose()
	}

	#sync(lines: number): void {
		const { terminal } = this,
			{ buffer: { active } } = terminal
		this.#value =
			deepFreeze(
				range(lines).reduce<string[]>((left, right) => {
					const line = active.getLine(right)
					if (line) {
						const { length } = left
						if (line.isWrapped && length > 0) {
							left[length - 1] += line.translateToString(true)
						} else {
							left.push(line.translateToString(true))
						}
					}
					return left
				}, []),
			)
		terminal.resize(
			Math.max(
				TerminalTextArea.minCols,
				...this.#value.map(line => line.length + 1),
			),
			Math.max(
				TerminalTextArea.minRows,
				this.#value.length + 1,
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
