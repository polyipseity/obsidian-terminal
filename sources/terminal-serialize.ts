import { SerializeAddon } from "xterm-addon-serialize"
import type { Terminal } from "xterm"

export interface TerminalSerial {
	readonly columns: number
	readonly rows: number
	readonly data: string
}
export class TerminalSerializer {
	public readonly serializer = new SerializeAddon()

	public constructor(protected readonly terminal: Terminal) {
		this.terminal.loadAddon(this.serializer)
	}

	public unserialize(serial: TerminalSerial): void {
		this.terminal.resize(serial.columns, serial.rows)
		this.terminal.write(serial.data)
	}

	public serialize(): TerminalSerial {
		return {
			columns: this.terminal.cols,
			data: this.serializer.serialize({
				excludeAltBuffer: true,
				excludeModes: true,
			}),
			rows: this.terminal.rows,
		}
	}
}
