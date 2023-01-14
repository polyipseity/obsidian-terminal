import {
	type App,
	type FileSystemAdapter,
	MarkdownView,
	type Menu,
	Platform,
	Plugin,
	type PluginManifest,
	TFolder,
	type WorkspaceLeaf,
} from "obsidian"
import { DEFAULT_SETTINGS, SettingTab, Settings } from "./settings"
import { GenericTerminalPty, WindowsTerminalPty } from "./pty"
import {
	type Mutable,
	PLATFORM,
	cloneAsMutable,
	commandNamer,
	inSet,
	notice,
	printError,
} from "./util"
import { DEFAULT_LANGUAGE } from "assets/locales"
import { LanguageManager } from "./i18n"
import { StatusBarHider } from "./status-bar"
import type { TerminalPty } from "./pty"
import { TerminalView } from "./terminal"
import { spawn } from "child_process"

export class TerminalPlugin extends Plugin {
	public readonly state: TerminalPlugin.State = {
		language: new LanguageManager(this),
		settings: cloneAsMutable(DEFAULT_SETTINGS),
		statusBarHider: new StatusBarHider(this),
	}

	public readonly platform = ((): TerminalPlugin.PlatformDispatch => ({
		spawnTerminal: ((): TerminalPlugin.PlatformDispatch["spawnTerminal"] => {
			if (inSet(TerminalView.supportedPlatforms, PLATFORM)) {
				const platform = PLATFORM
				return async (plugin, cwd, type) => {
					const { settings, language } = plugin.state,
						{ i18n } = language,
						executable = settings.executables[platform]
					notice(
						() => i18n.t(
							"notices.spawning-terminal",
							{ executable: executable.name },
						),
						settings.noticeTimeout,
						plugin,
					)
					switch (type) {
						case "external": {
							const process = spawn(executable.name, executable.args, {
								cwd,
								detached: true,
								shell: true,
								stdio: "ignore",
							})
								.once("error", error => {
									printError(
										error,
										() => i18n.t("errors.error-spawning-terminal"),
										plugin,
									)
								})
							process.unref()
							return new Promise((resolve, reject) => {
								process.once("spawn", resolve).once("error", reject)
							})
						}
						case "integrated": {
							const { workspace } = plugin.app,
								existingLeaves = workspace
									.getLeavesOfType(TerminalView.type.namespaced(plugin)),
								state: TerminalView.State = {
									__type: TerminalView.State.TYPE,
									args: executable.args,
									cwd,
									executable: executable.name,
								}
							return ((): WorkspaceLeaf => {
								const existingLeaf = existingLeaves.last()
								if (typeof existingLeaf === "undefined") {
									return workspace.getLeaf("split", "horizontal")
								}
								workspace.setActiveLeaf(existingLeaf, { focus: false })
								return workspace.getLeaf("tab")
							})().setViewState({
								active: true,
								state,
								type: TerminalView.type.namespaced(plugin),
							})
						}
						default:
							throw new TypeError(type)
					}
				}
			}
			return plugin => {
				throw new Error(plugin.state.language
					.i18n.t("errors.unsupported-platform"))
			}
		})(),
		terminalPty: PLATFORM === "win32"
			? WindowsTerminalPty
			: GenericTerminalPty,
	}))()

	public constructor(app: App, manifest: PluginManifest) {
		TerminalView.namespacedViewType = TerminalView.type.namespaced(manifest)
		super(app, manifest)
	}

	public override async onload(): Promise<void> {
		super.onload()
		if (!Platform.isDesktopApp) {
			return
		}
		const { state } = this,
			{ settings, language, statusBarHider } = state
		await Settings.load(settings, this)
		await language.load()
		statusBarHider.load()
		const { i18n } = language

		this.addSettingTab(new SettingTab(this))
		this.registerView(
			TerminalView.type.namespaced(this),
			leaf => new TerminalView(this, leaf),
		)

		const adapter = this.app.vault.adapter as FileSystemAdapter,
			CWD_TYPES = ["root", "current"] as const,
			terminalSpawnCommand = (
				type: TerminalPlugin.TerminalType,
				cwd: typeof CWD_TYPES[number],
			) => (checking: boolean): boolean => {
				if (!settings.command) {
					return false
				}
				switch (cwd) {
					case "root": {
						if (!checking) {
							void this.platform.spawnTerminal(
								this,
								adapter.getBasePath(),
								type,
							)
						}
						return true
					}
					case "current": {
						const activeFile = this.app.workspace.getActiveFile()
						if (activeFile === null) {
							return false
						}
						if (!checking) {
							void this.platform.spawnTerminal(
								this,
								adapter.getFullPath(activeFile.parent.path),
								type,
							)
						}
						return true
					}
					default:
						throw new TypeError(cwd)
				}
			}
		for (const type of TerminalPlugin.TERMINAL_TYPES) {
			for (const cwd of CWD_TYPES) {
				const id = `open-terminal-${type}-${cwd}` as const
				let namer = (): string => i18n.t(`commands.${id}`)
				this.addCommand({
					checkCallback: terminalSpawnCommand(type, cwd),
					id,
					get name() { return namer() },
					set name(format) {
						namer = commandNamer(
							() => i18n.t(`commands.${id}`),
							() => i18n.t("name"),
							i18n.t("name", { lng: DEFAULT_LANGUAGE }),
							format,
						)
					},
				})
			}
		}
		const addContextMenus = (menu: Menu, cwd: TFolder): void => {
			menu
				.addSeparator()
				.addItem(item => item
					.setTitle(i18n.t("menus.open-terminal-external"))
					.setIcon(i18n.t("asset:menus.open-terminal-external-icon"))
					.onClick(async () => this.platform.spawnTerminal(
						this,
						adapter.getFullPath(cwd.path),
						"external",
					)))
				.addItem(item => item
					.setTitle(i18n.t("menus.open-terminal-integrated"))
					.setIcon(i18n.t("asset:menus.open-terminal-integrated-icon"))
					.onClick(async () => this.platform.spawnTerminal(
						this,
						adapter.getFullPath(cwd.path),
						"integrated",
					)))
		}
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (!settings.contextMenu) {
				return
			}
			addContextMenus(menu, file instanceof TFolder ? file : file.parent)
		}))
		this.registerEvent(this.app.workspace.on(
			"editor-menu",
			(menu, _0, info) => {
				if (!settings.contextMenu ||
					info instanceof MarkdownView ||
					info.file === null) {
					return
				}
				addContextMenus(menu, info.file.parent)
			},
		))
	}
}
export namespace TerminalPlugin {
	export const TERMINAL_TYPES = ["external", "integrated"] as const
	export type TerminalType = typeof TERMINAL_TYPES[number]
	export interface PlatformDispatch {
		readonly spawnTerminal: (
			plugin: TerminalPlugin,
			cwd: string,
			type: TerminalType
		) => Promise<void>
		readonly terminalPty: typeof TerminalPty
	}
	export interface State {
		readonly settings: Mutable<Settings>
		readonly language: LanguageManager
		readonly statusBarHider: StatusBarHider
	}
}
// Needed for loading
export default TerminalPlugin
