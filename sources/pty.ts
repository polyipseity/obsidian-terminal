import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "child_process"
import { TERMINAL_WATCHDOG_INTERVAL } from "./magic"
import { i18n } from "./i18n"
import { printError } from "./util"
import { promisify } from "util"
import { readFileSync } from "fs"
import resizerPy from "./resizer.py"
import { fileSync as tmpFileSync } from "tmp"

export default interface TerminalPty {
	readonly shell: () => ChildProcessWithoutNullStreams
	readonly resizable: () => boolean
	readonly resize: (columns: number, rows: number) => Promise<void>
	readonly once: (event: "exit", listener: (code: NodeJS.Signals | number) => void) => this
}
export type TerminalPtyConstructor =
	new (executable: string, cwd?: string, args?: string[]) => TerminalPty

abstract class PtyWithResizer implements TerminalPty {
	protected resizable0 = false
	protected readonly resizer = spawn("python", ["-c", resizerPy], {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	})
		.once("spawn", () => {
			this.resizable0 = true
			const watchdog = window.setInterval(() => {
				void this._write("\n")
			}, TERMINAL_WATCHDOG_INTERVAL)
			try {
				this.resizer.once("exit", () => { window.clearInterval(watchdog) })
			} catch (err) {
				window.clearInterval(watchdog)
				throw err
			}
		})
		.once("error", error => {
			this.resizable0 = false
			printError(error, i18n.t("errors.error-spawning-resizer"))
		})
		.once("exit", () => { this.resizable0 = false })

	private readonly _write =
		promisify(this.resizer.stdin.write.bind(this.resizer.stdin) as
			(chunk: any, callback: (error?: Error | null) => void) => boolean)

	protected constructor(process: ChildProcess) {
		const { resizer } = this
		process
			.once("spawn", () => {
				const { pid } = process
				if (typeof pid === "undefined") {
					resizer.kill()
					return
				}
				this._write(`${pid}\n`)
					.catch(reason => {
						resizer.kill()
						printError(reason, i18n.t("errors.error-spawning-resizer"))
					})
			})
			.once("error", () => { this.resizer.kill() })
			.once("exit", () => { this.resizer.kill() })
	}

	public resizable(): boolean {
		return this.resizable0
	}

	public async resize(columns: number, rows: number): Promise<void> {
		const { resizer } = this,
			{ stdout } = resizer
		await this._write(`${columns}x${rows}\n`)
		return new Promise((resolve, reject) => {
			const succ = (chunk: Buffer): void => {
				if (chunk.toString().includes("resized")) {
					// eslint-disable-next-line @typescript-eslint/no-use-before-define
					resizer.removeListener("error", fail)
					stdout.removeListener("data", succ)
					resolve()
				}
			}
			function fail(err: Error): void {
				stdout.removeListener("data", succ)
				reject(err)
			}
			stdout.on("data", succ)
			resizer.once("error", fail)
		})
	}

	public abstract shell(): ChildProcessWithoutNullStreams
	public abstract once(event: "exit", listener: (code: NodeJS.Signals | number) => void): this
}

export class WindowsTerminalPty
	extends PtyWithResizer
	implements TerminalPty {
	protected readonly codeTmp
	protected readonly shell0: ChildProcessWithoutNullStreams
	protected exitCode?: NodeJS.Signals | number
	protected readonly exitListeners: (
		(code: NodeJS.Signals | number) => void)[] = []

	public constructor(
		executable: string,
		cwd?: string,
		args?: string[],
	) {
		const args0 = args ?? [],
			codeTmp = tmpFileSync({ discardDescriptor: true }),
			shell = spawn("C:\\Windows\\System32\\conhost.exe", [
				"C:\\Windows\\System32\\cmd.exe",
				"/C",
				`"${executable}" ${args0.length === 0 ? "" : "\""}${args0.join("\" \"")}${args0.length === 0 ? "" : "\""} & call echo %^ERRORLEVEL% >"${codeTmp.name}"`,
			], {
				cwd,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: false,
				windowsVerbatimArguments: true,
			})
				.once("exit", (conCode, signal) => {
					try {
						const termCode =
							parseInt(
								readFileSync(this.codeTmp.name, { encoding: "utf-8", flag: "r" }).trim(),
								10
							),
							code = isNaN(termCode)
								? conCode === null
									? signal === null
										? NaN
										: signal
									: conCode
								: termCode
						this.exitCode = code
						for (const listener of this.exitListeners) { listener(code) }
						this.exitListeners.length = 0
					} finally {
						this.codeTmp.removeCallback()
					}
				})
		super(shell)
		this.shell0 = shell
		this.codeTmp = codeTmp
	}

	public once(_0: "exit", listener: (code: NodeJS.Signals | number) => void): this {
		const { exitCode } = this
		if (typeof exitCode === "undefined") {
			this.exitListeners.push(listener)
			return this
		}
		listener(exitCode)
		return this
	}

	public shell(): ChildProcessWithoutNullStreams {
		return this.shell0
	}
}

export class GenericTerminalPty
	extends PtyWithResizer
	implements TerminalPty {
	protected readonly shell0: ChildProcessWithoutNullStreams

	public constructor(
		executable: string,
		cwd?: string,
		args?: string[],
	) {
		const shell = spawn(executable, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: false,
		})
		super(shell)
		this.shell0 = shell
	}

	public once(event: "exit", listener: (code: NodeJS.Signals | number) => void): this {
		this.shell0.once(event, (code, signal) => {
			listener(code === null ? signal === null ? NaN : signal : code)
		})
		return this
	}

	public shell(): ChildProcessWithoutNullStreams {
		return this.shell0
	}
}
