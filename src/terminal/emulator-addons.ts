import {
	Functions,
	activeSelf,
	consumeEvent,
	deepFreeze,
	isNonNil,
	replaceAllRegex,
} from "@polyipseity/obsidian-plugin-library"
import type { ITerminalAddon, ITheme, Terminal } from "@xterm/xterm"
import type { CanvasAddon } from "@xterm/addon-canvas"
import type { WebglAddon } from "@xterm/addon-webgl"
import { constant, isUndefined } from "lodash-es"
import type { Workspace } from "obsidian"

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

export namespace FollowThemeAddon {
	export interface Options {
		/**
		 * Whether the addon should apply changes.
		 * Default: always true
		 */
		readonly enabled?: () => boolean

		/**
		 * CSS custom properties to read. If a value is itself another var(), we
		 * resolve it by delegating to the browser.
		 */
		readonly bgVar?: string            // Default: --background-primary
		readonly fgVar?: string            // Default: --text-normal
		readonly accentVar?: string        // Default: --interactive-accent

		/**
		 * Selection overlay alpha. 0..1
		 * Default: 0.3
		 */
		readonly selectionAlpha?: number

		/**
		 * Min contrast for cursor vs background. If accent cannot reach this,
		 * fall back to the best of white/black/foreground.
		 * Default: 3
		 */
		readonly minCursorContrast?: number
	}

	export interface RGBA {
		readonly r: number;
		readonly g: number;
		readonly b: number;
		readonly a: number;
	}
}
export class FollowThemeAddon implements ITerminalAddon {
	readonly #disposer = new Functions({ async: false, settled: true })

	#lastThemeKey = ''

	public constructor(
		protected readonly element: HTMLElement,
		protected readonly workspace: Workspace,
		protected readonly opts: FollowThemeAddon.Options = {},
	) { }

	public activate(terminal: Terminal): void {
		const update = (): void => {
			if (this.opts.enabled && !this.opts.enabled()) return
			const next = this.#computeTheme()
			if (!next) return

			// No-op if unchanged
			const key = this.#themeKey(next)
			if (key === this.#lastThemeKey) return
			this.#lastThemeKey = key

			// Use existing way of setting options (no setOption)
			if (!terminal.options.theme) {
				terminal.options.theme = {}
			}
			if (next.background) {
				terminal.options.theme.background = next.background
			}
			if (next.foreground) {
				terminal.options.theme.foreground = next.foreground
			}
			if (next.cursor) {
				terminal.options.theme.cursor = next.cursor
			}
			if (next.selectionBackground) {
				terminal.options.theme.selectionBackground = next.selectionBackground
			}
		}

		// Initial apply
		update()

		// Keep in sync with app CSS/theme changes (no throttling)
		const ref = this.workspace.on('css-change', update)
		this.#disposer.push(() => this.workspace.offref(ref))
	}

	public dispose(): void {
		this.#disposer.call()
	}

	/**
	 * Derive an xterm theme from host CSS variables. Returns `null` if
	 * nothing useful is computed.
	 */
	#computeTheme(): ITheme | null {
		const doc = this.element.ownerDocument
		const win = doc.defaultView!
		const body = doc.body

		const bgVar = this.opts.bgVar ?? '--background-primary'
		const fgVar = this.opts.fgVar ?? '--text-normal'
		const accentVar = this.opts.accentVar ?? '--interactive-accent'

		// Resolve CSS variables to final, computed css color strings
		const bgStr = this.#resolveCssColor(bgVar, body)?.trim() ?? ''
		const fgVarStr = this.#resolveCssColor(fgVar, body)?.trim() ?? ''
		const accentStr = this.#resolveCssColor(accentVar, body)?.trim() ?? ''

		const computedBodyColor = win.getComputedStyle(body).color

		const bg = this.#toRGBA(bgStr) ?? null
		if (!bg) return null // cannot theme without background

		const explicitFg = this.#toRGBA(fgVarStr) ?? this.#toRGBA(computedBodyColor)
		const autoFg = this.#bestOf([this.#rgb(0, 0, 0), this.#rgb(255, 255, 255)], bg)
		const fg = explicitFg ?? autoFg

		// Cursor: try accent first but ensure minimum contrast
		const minCursorContrast = this.opts.minCursorContrast ?? 3
		const cursorCandidates: FollowThemeAddon.RGBA[] = [
			this.#toRGBA(accentStr),
			fg,
			this.#rgb(0, 0, 0),
			this.#rgb(255, 255, 255),
		].filter(Boolean) as FollowThemeAddon.RGBA[]
		const cursor =
			this.#bestMeetingContrast(cursorCandidates, bg, minCursorContrast) ??
			this.#bestOf(cursorCandidates, bg)

		// Selection: overlay high-contrast color over background
		const alpha = Math.min(1, Math.max(0, this.opts.selectionAlpha ?? 0.3))
		const overlayBase = this.#bestOf([this.#rgb(0, 0, 0), this.#rgb(255, 255, 255)], bg)
		const selection = this.#mix(overlayBase, bg, alpha)

		const theme: ITheme = {
			background: this.#toCss(bg),
			foreground: this.#toCss(fg),
			cursor: this.#toCss(cursor),
			selectionBackground: this.#toCss(selection),
		}

		return theme
	}

	// --- CSS value resolution helpers ----------------------------------------

	/**
	 * Resolves a CSS custom property to its final computed color string,
	 * even if it is defined via nested var() indirections.
	 */
	#resolveCssColor(varName: string, attachTo: HTMLElement): string | null {
		const doc = attachTo.ownerDocument
		const win = doc.defaultView!

		const raw = win.getComputedStyle(attachTo).getPropertyValue(varName)
		if (raw && !raw.includes('var(')) {
			return raw
		}

		// Robust path: let the browser resolve var(...) into a concrete color
		const probe = doc.createElement('div')
		probe.style.position = 'absolute'
		probe.style.width = '0'
		probe.style.height = '0'
		probe.style.pointerEvents = 'none'
		probe.style.visibility = 'hidden'
		probe.style.backgroundColor = `var(${varName})`
		attachTo.appendChild(probe)

		const resolved = win.getComputedStyle(probe).backgroundColor
		probe.remove()

		return resolved || null
	}

	// --- Color utilities (WCAG aware) ----------------------------------------

	#rgb(r: number, g: number, b: number, a = 1): FollowThemeAddon.RGBA { return { r, g, b, a } }

	/** Parse any CSS color the browser understands into FollowThemeAddon.RGBA, or null */
	#toRGBA(input: string | null | undefined): FollowThemeAddon.RGBA | null {
		if (!input) return null
		const doc = this.element.ownerDocument
		const win = doc.defaultView!
		const span = doc.createElement('span')
		span.style.color = ''
		span.style.color = input
		if (!span.style.color) return null
		doc.body.appendChild(span)
		const cs = win.getComputedStyle(span).color // 'rgb(r,g,b)' or 'FollowThemeAddon.RGBA(r,g,b,a)'
		span.remove()

		const m = cs.match(/\d+(\.\d+)?/g)
		if (!m) return null
		const [r, g, b, a] = m.map(Number)
		if (isUndefined(r) || isUndefined(g) || isUndefined(b)) return null
		return { r, g, b, a: a ?? 1 }
	}

	#toCss(c: FollowThemeAddon.RGBA): string {
		if (c.a === 1) {
			return `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`
		}
		return `FollowThemeAddon.RGBA(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${+c.a.toFixed(3)})`
	}

	/** WCAG relative luminance of sRGB color */
	#lum(c: FollowThemeAddon.RGBA): number {
		const toLin = (v: number) => {
			v /= 255
			return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
		}
		const r = toLin(c.r), g = toLin(c.g), b = toLin(c.b)
		return 0.2126 * r + 0.7152 * g + 0.0722 * b
	}

	/** Contrast ratio per WCAG between two colors */
	#contrast(a: FollowThemeAddon.RGBA, b: FollowThemeAddon.RGBA): number {
		const L1 = this.#lum(a)
		const L2 = this.#lum(b)
		const [hi, lo] = L1 >= L2 ? [L1, L2] : [L2, L1]
		return (hi + 0.05) / (lo + 0.05)
	}

	/** Alpha blend: result = (1 - alpha) * base + alpha * top */
	#mix(top: FollowThemeAddon.RGBA, base: FollowThemeAddon.RGBA, alpha: number): FollowThemeAddon.RGBA {
		const a = Math.min(1, Math.max(0, alpha))
		return {
			r: base.r * (1 - a) + top.r * a,
			g: base.g * (1 - a) + top.g * a,
			b: base.b * (1 - a) + top.b * a,
			a: 1, // terminal selection background is rendered as opaque color
		}
	}

	/** Pick color with highest contrast vs bg */
	#bestOf(
		candidates: readonly FollowThemeAddon.RGBA[],
		bg: FollowThemeAddon.RGBA
	): FollowThemeAddon.RGBA {
		return candidates.reduce((best, current) => {
			const bestC = this.#contrast(best, bg)
			const curC = this.#contrast(current, bg)
			return curC > bestC ? current : best
		})
	}

	/** First candidate that meets min contrast, else null */
	#bestMeetingContrast(candidates: FollowThemeAddon.RGBA[], bg: FollowThemeAddon.RGBA, min: number): FollowThemeAddon.RGBA | null {
		for (const c of candidates) {
			if (this.#contrast(c, bg) >= min) return c
		}
		return null
	}

	// --- Change detection -----------------------------------------------------

	#themeKey(t: ITheme): string {
		return JSON.stringify({
			background: t.background ?? null,
			foreground: t.foreground ?? null,
			cursor: t.cursor ?? null,
			selectionBackground: t.selectionBackground ?? null,
		})
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

export class RightClickActionAddon implements ITerminalAddon {
	readonly #disposer = new Functions({ async: false, settled: true })

	public constructor(
		protected readonly action: () => RightClickActionAddon.Action =
			constant("default"),
	) { }

	public activate(terminal: Terminal): void {
		const { element } = terminal
		if (!element) { throw new Error() }
		const contextMenuListener = (ev: MouseEvent): void => {
			const action = this.action()
			if (action === "default") { return }
			(async (): Promise<void> => {
				try {
					// eslint-disable-next-line default-case
					switch (action) {
						case "nothing":
							// How to send right click to the terminal?
							break
						// @ts-expect-error: fallthrough
						case "copyPaste":
							if (terminal.hasSelection()) {
								await activeSelf(element).navigator.clipboard
									.writeText(terminal.getSelection())
								terminal.clearSelection()
								break
							}
						// eslint-disable-next-line no-fallthrough
						case "paste":
							terminal.paste(await activeSelf(element).navigator.clipboard
								.readText())
							break
					}
				} catch (error) {
					activeSelf(element).console.error(error)
				}
			})()
			consumeEvent(ev)
		}
		this.#disposer.push(() => {
			element.removeEventListener("contextmenu", contextMenuListener)
		})
		element.addEventListener("contextmenu", contextMenuListener)
	}

	public dispose(): void {
		this.#disposer.call()
	}
}
export namespace RightClickActionAddon {
	export const ACTIONS = deepFreeze([
		"copyPaste", "default", "nothing", "paste",
	])
	export type Action = typeof ACTIONS[number]
}
