import { type App, Plugin, type PluginManifest } from "obsidian"
import type { AsyncOrSync, DeepWritable } from "ts-essentials"
import {
	EventEmitterLite,
	asyncDebounce,
	copyOnWriteAsync,
	deepFreeze,
	logError,
} from "./utils/util"
import {
	JSON_STRINGIFY_SPACE,
	SAVE_SETTINGS_WAIT,
	SI_PREFIX_SCALE,
} from "./magic"
import { constant, isNil, throttle } from "lodash-es"
import { LanguageManager } from "./i18n"
import { Settings } from "./settings/data"
import { StatusBarHider } from "./status-bar"
import { loadDocumentation } from "./documentation/load"
import { loadIcons } from "./icons"
import { loadSettings } from "./settings/load"
import { printMalformedData } from "./utils/obsidian"
import { semVerString } from "./utils/types"

export class PLACEHOLDERPlugin extends Plugin {
	public readonly version
	public readonly language = new LanguageManager(this)
	public readonly statusBarHider = new StatusBarHider(this)

	public readonly saveSettings = asyncDebounce(throttle((
		resolve: (value: AsyncOrSync<void>) => void,
	) => {
		resolve(this.saveData(this.settings))
	}, SAVE_SETTINGS_WAIT * SI_PREFIX_SCALE))

	readonly #onMutateSettings = new EventEmitterLite<readonly [Settings]>()
	#settings: Settings = deepFreeze(Settings.fix(Settings.DEFAULT).value)

	public constructor(app: App, manifest: PluginManifest) {
		super(app, manifest)
		try {
			this.version = semVerString(manifest.version)
		} catch (error) {
			self.console.warn(error)
			this.version = null
		}
	}

	public get settings(): Settings {
		return this.#settings
	}

	public async mutateSettings(mutator: (
		settings: DeepWritable<Settings>) => unknown): Promise<void> {
		await this.#onMutateSettings.emit(this.#settings =
			await copyOnWriteAsync(this.#settings, mutator))
	}

	public async loadSettings(
		settings: DeepWritable<Settings>,
		loader: () => unknown = async (): Promise<unknown> => this.loadData(),
	): Promise<void> {
		const loaded: unknown = await loader(),
			{ value, valid } = Settings.fix(loaded)
		Object.assign(settings, value)
		if (!isNil(loaded) && !valid) {
			printMalformedData(this, loaded, value)
			settings.recovery[new Date().toISOString()] =
				JSON.stringify(loaded, null, JSON_STRINGIFY_SPACE)
		}
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
		super.onload();
		(async (): Promise<void> => {
			try {
				const loaded: Promise<unknown> = this.loadData()
				// Initialization
				await Promise.all([
					this.mutateSettings(async settings => this.loadSettings(
						settings,
						constant(loaded),
					)).then(() => { this.saveSettings().catch(logError) }),
					this.language.load(),
					Promise.resolve().then(() => { loadIcons(this) }),
				])
				// Modules
				await Promise.all([
					Promise.resolve().then(() => { this.statusBarHider.load() }),
					Promise.resolve().then(() => { loadSettings(this) }),
					(async (): Promise<void> => {
						loadDocumentation(this, isNil(await loaded))
					})(),
				])
			} catch (error) {
				self.console.error(error)
			}
		})()
	}
}
// Needed for loading
export default PLACEHOLDERPlugin
