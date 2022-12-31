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
	moment,
} from "obsidian"
import { GenericTerminalPty, WindowsTerminalPty } from "./pty"
import { SettingTab, getDefaultSettings } from "./settings"
import i18next, { type i18n } from "i18next"
import { notice, printError } from "./util"
import I18N from "./i18n"
import type Settings from "./settings"
import type TerminalPty from "./pty"
import TerminalView from "./terminal"
import { spawn } from "child_process"

class TerminalPlugin extends Plugin {
	public readonly settings: Settings = getDefaultSettings()
	public readonly platform = ((): TerminalPlugin.PlatformDispatch => {
		const platform = process.platform in this.settings.executables
			? process.platform as TerminalPlugin.Platform
			: null
		return {
			spawnTerminal: ((): TerminalPlugin.PlatformDispatch["spawnTerminal"] => {
				if (platform === null) {
					return plugin => {
						throw Error(plugin.i18n.t("errors.unsupported-platform"))
					}
				}
				return async (plugin, cwd, type) => {
					const executable = plugin.settings.executables[platform]
					notice(plugin.i18n.t("notices.spawning-terminal", { executable: executable.name }), plugin.settings.noticeTimeout)
					switch (type) {
						case "external": {
							const process = spawn(executable.name, executable.args, {
								cwd,
								detached: true,
								shell: true,
								stdio: "ignore",
							})
								.once("error", error => {
									printError(error, plugin.i18n.t("errors.error-spawning-terminal"))
								})
							process.unref()
							return new Promise((resolve, reject) => { process.once("spawn", resolve).once("error", reject) })
						}
						case "integrated": {
							const { workspace } = plugin.app,
								existingLeaves = workspace
									.getLeavesOfType(TerminalView.viewType.namespaced(plugin)),
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
								type: TerminalView.viewType.namespaced(plugin),
							})
						}
						default:
							throw new TypeError(type)
					}
				}
			})(),
			terminalPty: platform === "win32" ? WindowsTerminalPty : GenericTerminalPty,
		}
	})()

	#i18n0: i18n = i18next

	public constructor(app: App, manifest: PluginManifest) {
		super(app, manifest)
		TerminalView.namespacedViewType = TerminalView.viewType.namespaced(manifest)
	}

	public get i18n(): i18n {
		return this.#i18n0
	}

	public override async onload(): Promise<void> {
		if (!Platform.isDesktopApp) {
			return
		}
		const [i18n] = await Promise.all([
			I18N.then(async i18n0 => {
				await i18n0.changeLanguage(moment.locale())
				return i18n0
			}),
			this.loadSettings(),
		])
		this.#i18n0 = i18n
		const adapter = this.app.vault.adapter as FileSystemAdapter

		this.addSettingTab(new SettingTab(this))
		this.registerView(
			TerminalView.viewType.namespaced(this),
			leaf => new TerminalView(this, leaf),
		)

		const CWD_TYPES = ["root", "current"] as const,
			terminalSpawnCommand = (
				type: TerminalPlugin.TerminalType,
				cwd: typeof CWD_TYPES[number],
			) => (checking: boolean): boolean => {
				if (!this.settings.command) {
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
				this.addCommand({
					checkCallback: terminalSpawnCommand(type, cwd),
					id,
					name: i18n.t(`commands.${id}`),
				})
			}
		}

		const addContextMenus = (menu: Menu, cwd: TFolder): void => {
			menu
				.addSeparator()
				.addItem(item => item
					.setTitle(i18n.t("menus.open-terminal-external"))
					.setIcon(i18n.t("assets:menus.open-terminal-external-icon"))
					.onClick(async () => {
						await this.platform.spawnTerminal(
							this,
							adapter.getFullPath(cwd.path),
							"external",
						)
					}))
				.addItem(item => item
					.setTitle(i18n.t("menus.open-terminal-integrated"))
					.setIcon(i18n.t("assets:menus.open-terminal-integrated-icon"))
					.onClick(async () => {
						await this.platform.spawnTerminal(
							this,
							adapter.getFullPath(cwd.path),
							"integrated",
						)
					}))
		}
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file,) => {
			if (!this.settings.contextMenu) {
				return
			}
			addContextMenus(menu, file instanceof TFolder ? file : file.parent)
		}))
		this.registerEvent(this.app.workspace.on(
			"editor-menu",
			(menu, _0, info,) => {
				if (!this.settings.contextMenu ||
					info instanceof MarkdownView ||
					info.file === null) {
					return
				}
				addContextMenus(menu, info.file.parent)
			},
		))
	}

	public async loadSettings(): Promise<void> {
		Object.assign(this.settings, await this.loadData())
	}

	public async saveSettings(): Promise<void> {
		await this.saveData(this.settings)
	}
}
namespace TerminalPlugin {
	export const PLATFORMS = ["darwin", "linux", "win32"] as const
	export type Platform = typeof PLATFORMS[number]
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
}
export default TerminalPlugin
