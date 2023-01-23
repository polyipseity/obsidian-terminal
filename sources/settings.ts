import {
	type ButtonComponent,
	type ExtraButtonComponent,
	type Plugin,
	PluginSettingTab,
	Setting,
	type ValueComponent,
} from "obsidian"
import { type Mutable, inSet } from "./util"
import { NOTICE_NO_TIMEOUT } from "./magic"
import { RESOURCES } from "assets/locales"
import type { TerminalPlugin } from "./main"
import { TerminalPty } from "./terminal/pty"

export interface Settings {
	readonly language: string
	readonly addToCommand: boolean
	readonly addToContextMenu: boolean
	readonly hideStatusBar: Settings.HideStatusBarOption
	readonly noticeTimeout: number
	readonly errorNoticeTimeout: number
	readonly pythonExecutable: string
	readonly executables: Settings.Executables
	readonly enableWindowsConhostWorkaround: boolean
}
export namespace Settings {
	export const HIDE_STATUS_BAR_OPTIONS =
		["never", "always", "focused", "running"] as const
	export type HideStatusBarOption = typeof HIDE_STATUS_BAR_OPTIONS[number]
	export type Executables = {
		readonly [key in
		typeof TerminalPty.SUPPORTED_PLATFORMS[number]]: Executables.Entry
	}
	export namespace Executables {
		export interface Entry {
			readonly intExe: string
			readonly intArgs: readonly string[]
			readonly extExe: string
			readonly extArgs: readonly string[]
		}
	}
	export async function load(self: Settings, plugin: Plugin): Promise<void> {
		Object.assign(self, await plugin.loadData())
	}
	export async function save(self: Settings, plugin: Plugin): Promise<void> {
		await plugin.saveData(self)
	}
}
export type MutableSettings = Mutable<Settings>
export const DEFAULT_SETTINGS: Settings = {
	addToCommand: true,
	addToContextMenu: true,
	enableWindowsConhostWorkaround: true,
	errorNoticeTimeout: NOTICE_NO_TIMEOUT,
	executables: {
		darwin: {
			extArgs: [],
			extExe: "xterm",
			intArgs: [],
			intExe: "/bin/zsh",
		},
		linux: {
			extArgs: [],
			extExe: "Terminal.app",
			intArgs: [],
			intExe: "/bin/sh",
		},
		win32: {
			extArgs: [],
			extExe: "C:\\Windows\\System32\\cmd.exe",
			intArgs: [],
			intExe: "C:\\Windows\\System32\\cmd.exe",
		},
	},
	hideStatusBar: "focused",
	language: "",
	noticeTimeout: 5,
	pythonExecutable: "python3",
} as const

export class SettingTab extends PluginSettingTab {
	public constructor(protected readonly plugin: TerminalPlugin) {
		super(plugin.app, plugin)
	}

	public display(): void {
		const { containerEl, plugin } = this,
			{ settings, language, statusBarHider } = plugin,
			{ i18n } = language
		containerEl.empty()
		containerEl.createEl("h1", { text: i18n.t("name") })

		new Setting(containerEl)
			.setName(i18n.t("settings.language"))
			.setDesc(i18n.t("settings.language-description"))
			.addDropdown(this.#linkSetting(
				() => settings.language,
				value => void (settings.language = value),
				{
					post: (dropdown, activate) => void dropdown
						.onChange(async value => {
							await activate(value)
							await language.updateLanguage()
							this.display()
						}),
					pre: dropdown => void dropdown
						.addOption("", i18n.t("settings.language-default"))
						.addOptions(Object
							.fromEntries(Object
								.entries(RESOURCES.en.language)
								.filter(entry => entry
									.every(half => typeof half === "string")))),
				},
			))
			.addExtraButton(this.#resetButton(
				() => void (settings.language = DEFAULT_SETTINGS.language),
				i18n.t("asset:settings.language-icon"),
				{
					post: (button, activate) => void button
						.onClick(async () => {
							await activate()
							await language.updateLanguage()
							this.display()
						}),
				},
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.reset-all"))
			.addButton(this.#resetButton(async () => {
				Object.assign(settings, structuredClone(DEFAULT_SETTINGS))
				await language.updateLanguage()
			}))

		new Setting(containerEl)
			.setName(i18n.t("settings.add-to-command"))
			.addToggle(this.#linkSetting(
				() => settings.addToCommand,
				value => void (settings.addToCommand = value),
			))
			.addExtraButton(this.#resetButton(
				() => void (settings.addToCommand = DEFAULT_SETTINGS.addToCommand),
				i18n.t("asset:settings.add-to-command-icon"),
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.add-to-context-menu"))
			.addToggle(this.#linkSetting(
				() => settings.addToContextMenu,
				value => void (settings.addToContextMenu = value),
			))
			.addExtraButton(this.#resetButton(
				() => void (settings.addToContextMenu =
					DEFAULT_SETTINGS.addToContextMenu),
				i18n.t("asset:settings.add-to-context-menu-icon"),
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.hide-status-bar"))
			.addDropdown(this.#linkSetting(
				() => settings.hideStatusBar as string,
				value => {
					if (inSet(Settings.HIDE_STATUS_BAR_OPTIONS, value)) {
						settings.hideStatusBar = value
						return true
					}
					return false
				},
				{
					post: (dropdown, activate) => void dropdown
						.onChange(async value => {
							await activate(value)
							statusBarHider.update()
						}),
					pre: dropdown => void dropdown
						.addOptions(Object
							.fromEntries(Settings.HIDE_STATUS_BAR_OPTIONS
								.map(value => [
									value,
									i18n.t(`settings.hide-status-bar-options.${value}`),
								]))),
				},
			))
			.addExtraButton(this.#resetButton(
				() => void (settings.hideStatusBar = DEFAULT_SETTINGS.hideStatusBar),
				i18n.t("asset:settings.hide-status-bar-icon"),
				{
					post: (button, activate) => void button
						.onClick(async () => {
							await activate()
							statusBarHider.update()
						}),
				},
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.notice-timeout"))
			.setDesc(i18n.t("settings.notice-timeout-description"))
			.addText(this.#linkSetting(
				() => settings.noticeTimeout.toString(),
				this.#setTextToNumber(value =>
					void (settings.noticeTimeout = value)),
			))
			.addExtraButton(this.#resetButton(
				() => void (settings.noticeTimeout =
					DEFAULT_SETTINGS.noticeTimeout),
				i18n.t("asset:settings.notice-timeout-icon"),
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.error-notice-timeout"))
			.setDesc(i18n.t("settings.error-notice-timeout-description"))
			.addText(this.#linkSetting(
				() => settings.errorNoticeTimeout.toString(),
				this.#setTextToNumber(value =>
					void (settings.errorNoticeTimeout = value)),
			))
			.addExtraButton(this.#resetButton(
				() => void (settings.noticeTimeout =
					DEFAULT_SETTINGS.noticeTimeout),
				i18n.t("asset:settings.error-notice-timeout-icon"),
			))

		new Setting(containerEl)
			.setName(i18n.t("settings.python-executable"))
			.setDesc(i18n.t("settings.python-executable-description"))
			.addText(this.#linkSetting(
				() => settings.pythonExecutable,
				value => void (settings.pythonExecutable = value),
				{
					post: component => void component
						.setPlaceholder(i18n.t("settings.python-executable-placeholder")),
				},
			))
			.addExtraButton(this.#resetButton(
				() => void (settings.pythonExecutable =
					DEFAULT_SETTINGS.pythonExecutable),
				i18n.t("asset:settings.python-executable-icon"),
			))
		containerEl.createEl("h2", { text: i18n.t("settings.executables") })
		for (const key of TerminalPty.SUPPORTED_PLATFORMS) {
			new Setting(containerEl)
				.setName(`${i18n.t(`settings.executable-list.${key}`)}${i18n
					.t("settings.executable-list.type.external")}`)
				.addText(this.#linkSetting(
					() => settings.executables[key].extExe,
					value => void (settings.executables[key].extExe = value),
				))
				.addExtraButton(this.#resetButton(
					() => void (settings.executables[key].extExe =
						DEFAULT_SETTINGS.executables[key].extExe),
					i18n.t("asset:settings.executable-list-external-icon"),
				))
			new Setting(containerEl)
				.setName(`${i18n.t(`settings.executable-list.${key}`)}${i18n
					.t("settings.executable-list.type.integrated")}`)
				.addText(this.#linkSetting(
					() => settings.executables[key].intExe,
					value => void (settings.executables[key].intExe = value),
				))
				.addExtraButton(this.#resetButton(
					() => void (settings.executables[key].intExe =
						DEFAULT_SETTINGS.executables[key].intExe),
					i18n.t("asset:settings.executable-list-integrated-icon"),
				))
		}

		new Setting(containerEl)
			.setName(i18n.t("settings.enable-Windows-conhost-workaround"))
			.setDesc(i18n.t("settings.enable-Windows-conhost-workaround-description"))
			.addToggle(this.#linkSetting(
				() => settings.enableWindowsConhostWorkaround,
				value => void (settings.enableWindowsConhostWorkaround = value),
			))
			.addExtraButton(this.#resetButton(
				() => void (settings.enableWindowsConhostWorkaround =
					DEFAULT_SETTINGS.enableWindowsConhostWorkaround),
				i18n.t("asset:settings.enable-Windows-conhost-workaround-icon"),
			))
	}

	#linkSetting<
		V,
		C extends ValueComponent<V> & {
			onChange: (
				callback: (value: V) => unknown) => C
		},
	>(
		getter: () => V,
		setter: (value: V, component: C, getter: () => V) => unknown,
		action: SettingTab.ComponentAction<C, V> = {},
	) {
		return (component: C): void => {
			(action.pre ?? ((): void => { }))(component)
			const activate = async (value: V): Promise<void> => {
				const ret = await setter(value, component, getter)
				if (typeof ret === "boolean" && !ret) {
					return
				}
				await Settings.save(this.plugin.settings, this.plugin)
			}
			component.setValue(getter()).onChange(activate);
			(action.post ?? ((): void => { }))(component, activate)
		}
	}

	#setTextToNumber<C extends ValueComponent<string>>(
		setter: (value: number, component: C, getter: () => string) => unknown,
		integer = false,
	) {
		return async (
			value: string,
			component: C,
			getter: () => string,
		): Promise<boolean> => {
			const num = Number(value)
			if (!(integer ? Number.isSafeInteger(num) : isFinite(num))) {
				component.setValue(getter())
				return false
			}
			const ret = await setter(num, component, getter)
			if (typeof ret === "boolean" && !ret) {
				return false
			}
			return true
		}
	}

	#resetButton<C extends ButtonComponent | ExtraButtonComponent>(
		resetter: (component: C) => unknown,
		icon: string = this.plugin.language
			.i18n.t("asset:settings.reset-icon"),
		action: SettingTab.ComponentAction<C, void> = {},
	) {
		return (component: C): void => {
			(action.pre ?? ((): void => { }))(component)
			const activate = async (): Promise<void> => {
				const ret = await resetter(component)
				if (typeof ret === "boolean" && !ret) {
					return
				}
				const save = Settings.save(this.plugin.settings, this.plugin)
				this.display()
				await save
			}
			component
				.setTooltip(this.plugin.language.i18n.t("settings.reset"))
				.setIcon(icon)
				.onClick(activate);
			(action.post ?? ((): void => { }))(component, activate)
		}
	}
}
namespace SettingTab {
	export interface ComponentAction<C, V> {
		readonly pre?: (component: C) => void
		readonly post?: (
			component: C,
			activate: (value: V) => PromiseLike<void>,
		) => void
	}
}
