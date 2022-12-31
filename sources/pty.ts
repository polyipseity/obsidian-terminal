import { type ChildProcessWithoutNullStreams, spawn } from "child_process"
import type ObsidianTerminalPlugin from "./main"
import { TERMINAL_WATCHDOG_INTERVAL } from "./magic"
import { printError } from "./util"
import { promisify } from "util"
import { readFileSync } from "fs"
import resizerPy from "./resizer.py"
import { fileSync as tmpFileSync } from "tmp"

export default interface TerminalPty {
	readonly shell: ChildProcessWithoutNullStreams
	readonly resizable: boolean
	readonly resize: (columns: number, rows: number) => Promise<void>
	readonly once: (event: "exit", listener: (code: NodeJS.Signals | number) => void) => this
}
// eslint-disable-next-line @typescript-eslint/no-redeclare, @typescript-eslint/naming-convention
export declare const TerminalPty: new (
	plugin: ObsidianTerminalPlugin,
	executable: string,
	cwd?: string,
	args?: string[],
) => TerminalPty

abstract class BaseTerminalPty implements TerminalPty {
	public abstract readonly shell: ChildProcessWithoutNullStreams
	public abstract readonly resizable: boolean
	protected constructor(protected readonly plugin: ObsidianTerminalPlugin) { }
	public abstract resize(columns: number, rows: number): Promise<void>
	public abstract once(event: "exit", listener: (code: NodeJS.Signals | number) => void): this
}

abstract class PtyWithResizer extends BaseTerminalPty implements TerminalPty {
	protected readonly asdd = resizerPy
	protected resizable0 = false
	protected readonly resizer = spawn("python", ["-c", resizerPy], {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	})
		.once("spawn", () => {
			this.resizable0 = true
			const watchdog = this.plugin.registerInterval(window.setInterval(() => {
				void this._write("\n").catch(() => { })
			}, TERMINAL_WATCHDOG_INTERVAL))
			try {
				this.resizer.once("exit", () => { window.clearInterval(watchdog) })
			} catch (err) {
				window.clearInterval(watchdog)
				throw err
			}
		})
		.once("error", error => {
			this.resizable0 = false
			printError(error, this.plugin.i18n.t("errors.error-spawning-resizer"))
		})
		.once("exit", () => { this.resizable0 = false })

	private readonly _write =
		promisify(this.resizer.stdin.write.bind(this.resizer.stdin) as
			(chunk: any, callback: (error?: Error | null) => void) => boolean)

	protected constructor(
		plugin: ObsidianTerminalPlugin,
		public readonly shell: ChildProcessWithoutNullStreams,
	) {
		super(plugin)
		const { resizer } = this
		shell
			.once("spawn", () => {
				const { pid } = shell
				if (typeof pid === "undefined") {
					resizer.kill()
					return
				}
				this._write(`${pid}\n`)
					.catch(reason => {
						resizer.kill()
						printError(reason, this.plugin.i18n.t("errors.error-spawning-resizer"))
					})
			})
			.once("error", () => { this.resizer.kill() })
			.once("exit", () => { this.resizer.kill() })
	}

	public get resizable(): boolean {
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

	public abstract override once(event: "exit", listener: (code: NodeJS.Signals | number) => void): this
}

export class WindowsTerminalPty
	extends PtyWithResizer
	implements TerminalPty {
	protected readonly codeTmp
	protected exitCode?: NodeJS.Signals | number
	protected readonly exitListeners: (
		(code: NodeJS.Signals | number) => void)[] = []

	public constructor(
		plugin: ObsidianTerminalPlugin,
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
							code = isNaN(termCode) ? conCode ?? signal ?? NaN : termCode
						this.exitCode = code
						for (const listener of this.exitListeners) { listener(code) }
						this.exitListeners.length = 0
					} finally {
						this.codeTmp.removeCallback()
					}
				})
		super(plugin, shell)
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
}

export class GenericTerminalPty
	extends PtyWithResizer
	implements TerminalPty {
	public constructor(
		plugin: ObsidianTerminalPlugin,
		executable: string,
		cwd?: string,
		args?: string[],
	) {
		const shell = spawn(executable, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: false,
		})
		super(plugin, shell)
	}

	public once(event: "exit", listener: (code: NodeJS.Signals | number) => void): this {
		this.shell.once(event, (code, signal) => {
			listener(code ?? signal ?? NaN)
		})
		return this
	}
}
