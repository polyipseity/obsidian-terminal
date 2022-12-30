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
import { GenericTerminalPty, type TerminalPtyConstructor, WindowsTerminalPty } from "./pty"
import { SettingTab, type TerminalExecutables, getDefaultSettings } from "./settings"
import TerminalView, { type TerminalViewState } from "./terminal"
import { notice, printError } from "./util"
import { I18N } from "./i18n"
import type Settings from "./settings"
import { spawn } from "child_process"

type TerminalType = "external" | "integrated"

interface PlatformDispatch {
	readonly spawnTerminal: (
		plugin: ObsidianTerminalPlugin,
		cwd: string,
		type: TerminalType
	) => Promise<void>
	readonly terminalPty: TerminalPtyConstructor
}

export default class ObsidianTerminalPlugin extends Plugin {
	public readonly settings: Settings = getDefaultSettings()
	public readonly platform = ((): PlatformDispatch => {
		const platform = process.platform in this.settings.executables
			? process.platform as keyof TerminalExecutables
			: null
		return {
			// eslint-disable-next-line no-underscore-dangle
			spawnTerminal: ObsidianTerminalPlugin._terminalSpawner(platform),
			terminalPty: platform === "win32" ? WindowsTerminalPty : GenericTerminalPty,
		}
	})()

	public constructor(app: App, manifest: PluginManifest) {
		super(app, manifest)
		TerminalView.namespacedViewType = TerminalView.viewType.namespaced(manifest)
	}

	private static _terminalSpawner(platform: keyof TerminalExecutables | null): PlatformDispatch["spawnTerminal"] {
		if (platform === null) {
			return () => {
				throw Error(I18N.t("errors.unsupported-platform"))
			}
		}
		return async (plugin, cwd, type) => {
			const executable = plugin.settings.executables[platform]
			notice(I18N.t("notices.spawning-terminal", { executable: executable.name }), plugin.settings.noticeTimeout)
			switch (type) {
				case "external": {
					spawn(executable.name, executable.args, {
						cwd,
						detached: true,
						shell: true,
						stdio: "ignore",
					})
						.once("error", error => {
							printError(error, I18N.t("errors.error-spawning-terminal"))
						})
						.unref()
					break
				}
				case "integrated": {
					const { workspace } = plugin.app,
						existingLeaves = workspace
							.getLeavesOfType(TerminalView.viewType.namespaced(plugin)),
						leaf = ((): WorkspaceLeaf => {
							const { length } = existingLeaves
							if (length === 0) {
								return workspace.getLeaf("split", "horizontal")
							}
							workspace.setActiveLeaf(
								existingLeaves[length - 1],
								{ focus: false },
							)
							return workspace.getLeaf("tab")
						})(),
						state: TerminalViewState = {
							args: executable.args,
							cwd,
							executable: executable.name,
							type: "TerminalViewState",
						}
					await leaf.setViewState({
						active: true,
						state,
						type: TerminalView.viewType.namespaced(plugin),
					})
					plugin.app.workspace.setActiveLeaf(leaf, { focus: true })
					break
				}
				default:
					throw new TypeError(type)
			}
		}
	}

	public async onload(): Promise<void> {
		if (!Platform.isDesktopApp) {
			return
		}
		const adapter = this.app.vault.adapter as FileSystemAdapter

		await I18N.changeLanguage(moment.locale())
		await this.loadSettings()
		this.addSettingTab(new SettingTab(this))
		this.registerView(
			TerminalView.viewType.namespaced(this),
			leaf => new TerminalView(this, leaf),
		)

		const terminalSpawnCommand = (type: TerminalType, cwd: "current" | "root") => (checking: boolean): boolean => {
			if (!this.settings.command) {
				return false
			}
			switch (cwd) {
				case "root": {
					if (!checking) {
						void this.platform.spawnTerminal(this, adapter.getBasePath(), type)
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
		for (const type of [
			"external",
			"integrated",
		] as const) {
			for (const cwd of [
				"root",
				"current",
			] as const) {
				const id = `open-terminal-${type}-${cwd}` as const
				this.addCommand({
					checkCallback: terminalSpawnCommand(type, cwd),
					id,
					name: I18N.t(`commands.${id}`),
				})
			}
		}

		const addContextMenus = (menu: Menu, cwd: TFolder): void => {
			menu
				.addSeparator()
				.addItem(item => item
					.setTitle(I18N.t("menus.open-terminal-external"))
					.setIcon(I18N.t("assets:menus.open-terminal-external-icon"))
					.onClick(async () => {
						await this.platform.spawnTerminal(this, adapter.getFullPath(cwd.path), "external")
					}))
				.addItem(item => item
					.setTitle(I18N.t("menus.open-terminal-integrated"))
					.setIcon(I18N.t("assets:menus.open-terminal-integrated-icon"))
					.onClick(async () => {
						await this.platform.spawnTerminal(this, adapter.getFullPath(cwd.path), "integrated")
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
