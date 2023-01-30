import { type App, Plugin, type PluginManifest } from "obsidian"
import { DEFAULT_SETTINGS, SettingTab, Settings } from "./settings"
import { EventEmitterLite, type Mutable, cloneAsMutable } from "./utils/util"
import { TerminalView, registerTerminal } from "./terminal/view"
import { LanguageManager } from "./i18n"
import { StatusBarHider } from "./status-bar"

export class TerminalPlugin extends Plugin {
	public readonly language = new LanguageManager(this)
	public readonly statusBarHider = new StatusBarHider(this)
	readonly #settings = cloneAsMutable(DEFAULT_SETTINGS)
	readonly #onMutateSettings = new EventEmitterLite<[Settings]>()

	public constructor(app: App, manifest: PluginManifest) {
		TerminalView.namespacedViewType = TerminalView.type.namespaced(manifest)
		super(app, manifest)
	}

	public get settings(): Settings {
		return this.#settings
	}

	public async mutateSettings(mutator: (
		settings: Mutable<Settings>) => unknown): Promise<void> {
		await mutator(this.#settings)
		await this.#onMutateSettings.emit(this.settings)
	}

	public on<T>(
		_event: "mutate-settings",
		accessor: (settings: Settings) => T,
		callback: (
			cur: T,
			prev: T,
			settings: Settings,
		) => unknown,
	): () => void {
		let prev = accessor(this.settings)
		return this.#onMutateSettings
			.listen(async (settings: Settings): Promise<void> => {
				const cur = accessor(settings),
					prev0 = prev
				if (prev0 !== cur) {
					prev = cur
					await callback(cur, prev0, settings)
				}
			})
	}

	public override onload(): void {
		(async (): Promise<void> => {
			try {
				super.onload()
				await Settings.load(this.settings, this)
				await this.language.load()
				this.statusBarHider.load()
				this.addSettingTab(new SettingTab(this))
				registerTerminal(this)
			} catch (error) {
				console.error(error)
			}
		})()
	}
}
// Needed for loading
export default TerminalPlugin
