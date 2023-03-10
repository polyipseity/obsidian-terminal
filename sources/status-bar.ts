import { DOMClasses } from "./magic"
import type { TerminalPlugin } from "./main"
import { notice2 } from "./utils/obsidian"
import { remove } from "./utils/util"

export function statusBar(callback?: (
	element: HTMLDivElement) => void): HTMLDivElement | null {
	// Okay to use `document` as it only exists on the main one
	const ret = document
		.querySelector<HTMLDivElement>(`div.${DOMClasses.STATUS_BAR}`)
	if (ret && callback) { callback(ret) }
	return ret
}

export class StatusBarHider {
	readonly #hiders: (() => boolean)[] = []
	public constructor(protected readonly plugin: TerminalPlugin) { }

	public load(): void {
		const { plugin } = this
		plugin.app.workspace.onLayoutReady(() => {
			if (!statusBar(div => {
				const obs = new MutationObserver(() => { this.maybeHide(div) })
				plugin.register(() => {
					obs.disconnect()
					this.unhide(div)
				})
				this.update()
				obs.observe(div, { attributeFilter: ["style"] })
			})) {
				notice2(
					() => plugin.language.i18n.t("errors.cannot-find-status-bar"),
					plugin.settings.errorNoticeTimeout,
					plugin,
				)
			}
		})
		plugin.on(
			"mutate-settings",
			settings => settings.hideStatusBar,
			() => { this.update() },
		)
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
			this.unhide(div)
			this.maybeHide(div)
		})
	}

	protected maybeHide(div: HTMLDivElement): void {
		if (this.plugin.settings.hideStatusBar === "always" ||
			this.#hiders.some(hider0 => hider0())) {
			div.style.visibility = "hidden"
		}
	}

	protected unhide(div: HTMLDivElement): void {
		div.style.visibility = ""
	}
}
