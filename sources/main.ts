import {
	type FileSystemAdapter,
	MarkdownView,
	type Menu,
	Platform,
	Plugin,
	TFolder,
} from "obsidian"
import { SettingTab, type TerminalExecutables, getDefaultSettings } from "./settings"
import { TerminalView, type TerminalViewState } from "./terminal"
import type Settings from "./settings"
import { notice } from "./util"
import { platform } from "process"
import { spawn } from "child_process"

export default class ObsidianTerminalPlugin extends Plugin {
	public readonly settings: Settings = getDefaultSettings()
	protected readonly adapter = this.app.vault.adapter as FileSystemAdapter
	protected readonly platform: keyof TerminalExecutables | null =
		platform in this.settings.executables
			? platform as keyof TerminalExecutables
			: null

	public async onload(): Promise<void> {
		if (!Platform.isDesktopApp) {
			return
		}

		await this.loadSettings()
		this.addSettingTab(new SettingTab(this.app, this))

		this.registerView(TerminalView.viewType, leaf => new TerminalView(leaf))

		const spawnTerminal = async (cwd: string, mode: "external" | "integrated"): Promise<void> => {
			if (this.platform === null) {
				return
			}
			const executable =
				this.settings.executables[this.platform],
				noticeTimeout = 5000
			notice(`Spawning terminal: ${executable}`, noticeTimeout)
			switch (mode) {
				case "external": {
					spawn(executable, {
						cwd,
						detached: true,
						shell: true,
						stdio: "ignore",
					})
						.on("error", err => {
							console.error(`Error spawning terminal: ${err.name}: ${err.message}`)
							notice(`Error spawning terminal: ${err.name}: ${err.message}`)
						})
						.unref()
					break
				}
				case "integrated": {
					const leaf = this.app.workspace.getLeaf("split", "horizontal"),
						state: TerminalViewState =
						{
							cwd,
							executable,
							platform: this.platform,
							type: "TerminalViewState",
						}
					await leaf.setViewState({
						active: true,
						state,
						type: TerminalView.viewType,
					})
					this.app.workspace.revealLeaf(leaf)
					this.app.workspace.setActiveLeaf(leaf, { focus: true })
					break
				}
				default:
					throw new TypeError(mode)
			}
		}

		this.addCommand({
			checkCallback: checking => {
				if (!this.settings.command) {
					return false
				}
				if (!checking) {
					void spawnTerminal(this.adapter.getBasePath(), "external")
				}
				return true
			},
			id: "open-external-terminal-root",
			name: "Open in external terminal (root)",
		})
		this.addCommand({
			checkCallback: checking => {
				if (!this.settings.command) {
					return false
				}
				if (!checking) {
					void spawnTerminal(this.adapter.getBasePath(), "integrated")
				}
				return true
			},
			id: "open-integrated-terminal-root",
			name: "Open in integrated terminal (root)",
		})
		this.addCommand({
			editorCheckCallback: (checking, _0, ctx) => {
				if (!this.settings.command || ctx.file === null) {
					return false
				}
				if (!checking) {
					void spawnTerminal(this.adapter.getFullPath(ctx.file.parent.path), "external")
				}
				return true
			},
			id: "open-external-terminal-editor",
			name: "Open in external terminal (editor)",
		})
		this.addCommand({
			editorCheckCallback: (checking, _0, ctx) => {
				if (!this.settings.command || ctx.file === null) {
					return false
				}
				if (!checking) {
					void spawnTerminal(this.adapter.getFullPath(ctx.file.parent.path), "integrated")
				}
				return true
			},
			id: "open-integrated-terminal-editor",
			name: "Open in integrated terminal (editor)",
		})

		const addContextMenus = (menu: Menu, cwd: TFolder): void => {
			menu
				.addSeparator()
				.addItem(item => item
					.setTitle("Open in external terminal")
					.setIcon("terminal")
					.onClick(async () => {
						await spawnTerminal(this.adapter.getFullPath(cwd.path), "external")
					}))
				.addItem(item => item
					.setTitle("Open in integrated terminal")
					.setIcon("terminal-square")
					.onClick(async () => {
						await spawnTerminal(this.adapter.getFullPath(cwd.path), "integrated")
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
