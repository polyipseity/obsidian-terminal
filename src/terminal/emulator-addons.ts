import {
	Functions,
	activeSelf,
	consumeEvent,
	deepFreeze,
	isNonNil,
	replaceAllRegex,
} from "@polyipseity/obsidian-plugin-library"
import type { ITerminalAddon, Terminal } from "@xterm/xterm"
import type { CanvasAddon } from "@xterm/addon-canvas"
import type { WebglAddon } from "@xterm/addon-webgl"

export class DisposerAddon extends Functions implements ITerminalAddon {
	public constructor(...args: readonly (() => void)[]) {
		super({ async: false, settled: true }, ...args)
	}

	// eslint-disable-next-line @typescript-eslint/class-methods-use-this
	public activate(_terminal: Terminal): void {
		// Noop
	}

	public dispose(): void {
		this.call()
	}
}

export class DragAndDropAddon implements ITerminalAddon {
	readonly #disposer = new Functions({ async: false, settled: true })

	public constructor(protected readonly element: HTMLElement) { }

	public activate(terminal: Terminal): void {
		const { element } = this,
			drop = (event: DragEvent): void => {
				terminal.paste(Array.from(event.dataTransfer?.files ?? [])
					.map(file => file.path)
					.filter(isNonNil)
					.map(path => path.replace(replaceAllRegex("\""), "\\\""))
					.map(path => path.includes(" ") ? `"${path}"` : path)
					.join(" "))
				consumeEvent(event)
			},
			dragover = consumeEvent
		this.#disposer.push(
			() => { element.removeEventListener("dragover", dragover) },
			() => { element.removeEventListener("drop", drop) },
		)
		element.addEventListener("drop", drop)
		element.addEventListener("dragover", dragover)
	}

	public dispose(): void {
		this.#disposer.call()
	}
}

export class RendererAddon implements ITerminalAddon {
	public renderer: CanvasAddon | WebglAddon | null = null
	#terminal: Terminal | null = null

	public constructor(
		protected readonly canvasSupplier: () => CanvasAddon,
		protected readonly webglSupplier: () => WebglAddon,
	) { }

	public use(renderer: RendererAddon.RendererOption): void {
		const term = this.#terminal
		if (!term) { return }
		const { element } = term
		this.renderer?.dispose()
		switch (renderer) {
			case "dom":
				this.renderer = null
				break
			case "canvas":
				try {
					const renderer0 = this.canvasSupplier()
					term.loadAddon(this.renderer = renderer0)
					break
				} catch (error) {
					activeSelf(element).console.warn(error)
					this.use("dom")
				}
				break
			case "webgl": {
				try {
					const renderer0 = this.webglSupplier(),
						contextLoss = renderer0.onContextLoss(() => {
							try {
								this.use("webgl")
							} finally {
								contextLoss.dispose()
							}
						})
					term.loadAddon(this.renderer = renderer0)
				} catch (error) {
					activeSelf(element).console.warn(error)
					this.use("canvas")
				}
				break
			}
			// No default
		}
	}

	public activate(terminal: Terminal): void {
		this.#terminal = terminal
	}

	public dispose(): void {
		this.renderer?.dispose()
		this.#terminal = null
	}
}
export namespace RendererAddon {
	export const RENDERER_OPTIONS = deepFreeze(["dom", "canvas", "webgl"])
	export type RendererOption = typeof RENDERER_OPTIONS[number]
}
