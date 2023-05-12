import { DOMClasses } from "./magic"
import type { PLACEHOLDERPlugin } from "./main"
import { UnnamespacedID } from "./utils/obsidian"
import { remove } from "./utils/util"

export function statusBar(callback?: (
	element: Element) => void): Element | null {
	// Okay to use `document` as it only exists on the main one
	const ret = self.document.querySelector(`.${DOMClasses.STATUS_BAR}`)
	if (ret && callback) { callback(ret) }
	return ret
}

export class StatusBarHider {
	public static readonly class =
		new UnnamespacedID(DOMClasses.Namespaced.HIDE_STATUS_BAR)

	readonly #hiders: (() => boolean)[] = []

	public constructor(protected readonly plugin: PLACEHOLDERPlugin) { }

	public load(): void {
		const { plugin } = this
		plugin.app.workspace.onLayoutReady(() => { this.update() })
	}

	public hide(hider: () => boolean): () => void {
		this.#hiders.push(hider)
		this.update()
		return () => {
			remove(this.#hiders, hider)
			this.update()
		}
	}

	public update(): void {
		statusBar(div => {
			const { plugin } = this
			if (this.#hiders.some(hider0 => hider0())) {
				div.classList.add(StatusBarHider.class.namespaced(plugin))
			} else {
				div.classList.remove(StatusBarHider.class.namespaced(plugin))
			}
		})
	}
}
