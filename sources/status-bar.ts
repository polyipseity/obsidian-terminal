import { NOTICE_NO_TIMEOUT } from "./magic"
import type TerminalPlugin from "./main"
import { notice } from "./util"

export function statusBar(callback?: (
	element: HTMLDivElement) => any): HTMLDivElement | null {
	const ret = document.querySelector<HTMLDivElement>("div.status-bar")
	if (ret !== null) {
		(callback ?? ((): void => { }))(ret)
	}
	return ret
}

export class StatusBarHider {
	readonly #hiders: (() => boolean)[] = []
	public constructor(protected readonly plugin: TerminalPlugin) { }

	public load(): void {
		const { plugin } = this
		plugin.app.workspace.onLayoutReady(() => {
			if (statusBar(div => {
				const obs = new MutationObserver(() => { this.#maybeHide(div) })
				plugin.register(() => {
					try {
						obs.disconnect()
					} finally {
						this.#unhide(div)
					}
				})
				this.update()
				obs.observe(div, { attributeFilter: ["style"] })
			}) === null) {
				notice(
					() => plugin.language.i18n.t("errors.cannot-find-status-bar"),
					NOTICE_NO_TIMEOUT,
					plugin,
				)
			}
		})
	}

	public hide(hider: () => boolean): () => void {
		this.#hiders.push(hider)
		this.update()
		return () => {
			this.#hiders.remove(hider)
			this.update()
		}
	}

	public update(): void {
		statusBar(div => {
			this.#unhide(div)
			this.#maybeHide(div)
		})
	}

	#maybeHide(div: HTMLDivElement): void {
		if (this.plugin.settings.hideStatusBar === "always" ||
			this.#hiders.some(hider0 => hider0())) {
			div.style.visibility = "hidden"
		}
	}

	#unhide(div: HTMLDivElement): void {
		div.style.visibility = ""
	}
}
