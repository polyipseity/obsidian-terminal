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
import { DEFAULT_SETTINGS, SettingTab, type Settings } from "./settings"
import { GenericTerminalPty, WindowsTerminalPty } from "./pty"
import {
	type Mutable,
	cloneAsMutable,
	commandNamer,
	inSet,
	notice,
	printError,
	statusBar,
} from "./util"
import i18next, { type i18n } from "i18next"
import { DEFAULT_LANGUAGE } from "assets/locales"
import { I18N } from "./i18n"
import { NOTICE_NO_TIMEOUT } from "./magic"
import type { TerminalPty } from "./pty"
import { TerminalView } from "./terminal"
import { spawn } from "child_process"

export class TerminalPlugin extends Plugin {
	public readonly state: TerminalPlugin.State = {
		language: new TerminalPlugin.LanguageManager(this),
		settings: cloneAsMutable(DEFAULT_SETTINGS),
		statusBarHider: new TerminalPlugin.StatusBarHider(this),
	}

	public readonly platform = ((): TerminalPlugin.PlatformDispatch => {
		const platform = inSet(TerminalPlugin.PLATFORMS, process.platform)
			? process.platform
			: null
		return {
			spawnTerminal: ((): TerminalPlugin.PlatformDispatch["spawnTerminal"] => {
				if (platform === null) {
					return plugin => {
						throw Error(plugin.i18n.t("errors.unsupported-platform"))
					}
				}
				return async (plugin, cwd, type) => {
					const { settings } = plugin.state,
						executable = settings.executables[platform]
					notice(
						() => plugin.i18n.t(
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
										() => plugin.i18n.t("errors.error-spawning-terminal"),
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
			})(),
			terminalPty: platform === "win32"
				? WindowsTerminalPty
				: GenericTerminalPty,
		}
	})()

	#i18n0: i18n = i18next

	public constructor(app: App, manifest: PluginManifest) {
		TerminalView.namespacedViewType = TerminalView.type.namespaced(manifest)
		super(app, manifest)
	}

	public get i18n(): i18n {
		return this.#i18n0
	}

	public override async onload(): Promise<void> {
		super.onload()
		if (!Platform.isDesktopApp) {
			return
		}
		const [i18n] = await Promise.all([I18N, this.loadSettings()])
		this.#i18n0 = i18n
		const { state } = this,
			{ settings } = this.state
		await state.language.load()
		state.statusBarHider.load()

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

	public async loadSettings(): Promise<void> {
		Object.assign(this.state.settings, await this.loadData())
	}

	public async saveSettings(): Promise<void> {
		await this.saveData(this.state.settings)
	}
}
export namespace TerminalPlugin {
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
	export interface State {
		readonly settings: Mutable<Settings>
		readonly language: LanguageManager
		readonly statusBarHider: StatusBarHider
	}
	export class LanguageManager {
		readonly #uses: (() => unknown)[] = []
		public constructor(protected readonly plugin: TerminalPlugin) { }

		public async load(): Promise<void> {
			await this.changeLanguage(this.plugin.state.settings.language)
		}

		public async changeLanguage(language: string): Promise<void> {
			await this.plugin.i18n.changeLanguage(language === ""
				? moment.locale()
				: language)
			await Promise.all(this.#uses.map(use => use()))
		}

		public registerUse(use: () => any): () => void {
			this.#uses.push(use)
			return () => { this.#uses.remove(use) }
		}
	}
	export class StatusBarHider {
		readonly #hiders: (() => boolean)[] = []
		public constructor(protected readonly plugin: TerminalPlugin) { }

		public load(): void {
			const { plugin } = this
			plugin.app.workspace.onLayoutReady(() => {
				if (statusBar(div => {
					const obs = new MutationObserver(this.#maybeHide.bind(this, div))
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
						() => plugin.i18n.t("errors.cannot-find-status-bar"),
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
			if (this.plugin.state.settings.hideStatusBar === "always" ||
				this.#hiders.some(hider0 => hider0())) {
				div.style.visibility = "hidden"
			}
		}

		#unhide(div: HTMLDivElement): void {
			div.style.visibility = ""
		}
	}
}
// Needed for loading
export default TerminalPlugin
