import { type App, Plugin, type PluginManifest } from "obsidian"
import {
	LanguageManager,
	type PluginContext,
	SI_PREFIX_SCALE,
	SettingsManager,
	StatusBarHider,
	createI18n,
	semVerString,
} from "@polyipseity/obsidian-plugin-library"
import { PLUGIN_UNLOAD_DELAY } from "./magic.js"
import { PluginLocales } from "../assets/locales.js"
import { Settings } from "./settings-data.js"
import { isNil } from "lodash-es"
import { loadDocumentations } from "./documentations.js"
import { loadSettings } from "./settings.js"

export class PLACEHOLDERPlugin
	extends Plugin
	implements PluginContext<Settings> {
	public readonly version
	public readonly language: LanguageManager
	public readonly settings: SettingsManager<Settings>
	public readonly statusBarHider = new StatusBarHider(this)

	public constructor(app: App, manifest: PluginManifest) {
		super(app, manifest)
		try {
			this.version = semVerString(manifest.version)
		} catch (error) {
			self.console.warn(error)
			this.version = null
		}
		this.language = new LanguageManager(
			this,
			async () => createI18n(
				PluginLocales.RESOURCES,
				PluginLocales.FORMATTERS,
				{
					defaultNS: PluginLocales.DEFAULT_NAMESPACE,
					fallbackLng: PluginLocales.FALLBACK_LANGUAGES,
					returnNull: PluginLocales.RETURN_NULL,
				},
			),
		)
		this.settings = new SettingsManager(this, Settings.fix)
	}

	public displayName(unlocalized = false): string {
		return unlocalized
			? this.language.value.t("name", {
				interpolation: { escapeValue: false },
				lng: PluginLocales.DEFAULT_LANGUAGE,
			})
			: this.language.value.t("name")
	}

	public override onload(): void {
		(async (): Promise<void> => {
			try {
				const loaded: unknown = await this.loadData(),
					{ language, statusBarHider, settings } = this,
					earlyChildren = [language, settings],
					children = [statusBarHider]
				for (const child of earlyChildren) { child.unload() }
				for (const child of earlyChildren) {
					// Delay unloading as there are unload tasks that cannot be awaited
					this.register(() => {
						const id = self.setTimeout(() => {
							child.unload()
						}, PLUGIN_UNLOAD_DELAY * SI_PREFIX_SCALE)
						child.register(() => { self.clearTimeout(id) })
					})
					child.load()
				}
				await Promise.all(earlyChildren.map(async child => child.onLoaded))
				for (const child of children) { this.addChild(child) }
				await Promise.all([
					Promise.resolve().then(() => {
						loadSettings(this, loadDocumentations(this, isNil(loaded)))
					}),
				])
			} catch (error) {
				self.console.error(error)
			}
		})()
	}
}
// Needed for loading
export default PLACEHOLDERPlugin
