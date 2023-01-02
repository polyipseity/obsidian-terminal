import { SerializeAddon } from "xterm-addon-serialize"
import { Terminal } from "xterm"

export interface TerminalSerial {
	readonly columns: number
	readonly rows: number
	readonly data: string
}
export class TerminalSerializer {
	readonly #terminal = new Terminal({
		allowProposedApi: true,
	})

	readonly #serializer = new SerializeAddon()

	public constructor() {
		this.#terminal.loadAddon(this.#serializer)
	}

	public write(data: Buffer | string): void {
		this.#terminal.write(data)
	}

	public resize(columns: number, rows: number): void {
		this.#terminal.resize(columns, rows)
	}

	public unserialize(serial: TerminalSerial): void {
		this.resize(serial.columns, serial.rows)
		this.write(serial.data)
	}

	public serialize(): TerminalSerial {
		return {
			columns: this.#terminal.cols,
			data: this.#serializer.serialize({
				excludeAltBuffer: true,
				excludeModes: true,
			}),
			rows: this.#terminal.rows,
		}
	}
}
