import {
	type App,
	Plugin,
	type PluginManifest,
} from "obsidian"
import { DEFAULT_SETTINGS, SettingTab, Settings } from "./settings"
import {
	type Mutable,
	cloneAsMutable,
} from "./util"
import { TerminalView, registerTerminal } from "./terminal"
import { LanguageManager } from "./i18n"
import { StatusBarHider } from "./status-bar"

export class TerminalPlugin extends Plugin {
	public readonly state: TerminalPlugin.State = {
		language: new LanguageManager(this),
		settings: cloneAsMutable(DEFAULT_SETTINGS),
		statusBarHider: new StatusBarHider(this),
	}

	public constructor(app: App, manifest: PluginManifest) {
		TerminalView.namespacedViewType = TerminalView.type.namespaced(manifest)
		super(app, manifest)
	}

	public override async onload(): Promise<void> {
		super.onload()
		const { state } = this,
			{ settings, language, statusBarHider } = state
		await Settings.load(settings, this)
		await language.load()
		statusBarHider.load()
		this.addSettingTab(new SettingTab(this))
		registerTerminal(this)
	}
}
export namespace TerminalPlugin {
	export interface State {
		readonly settings: Mutable<Settings>
		readonly language: LanguageManager
		readonly statusBarHider: StatusBarHider
	}
}
// Needed for loading
export default TerminalPlugin
