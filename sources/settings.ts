import {
	type ButtonComponent,
	type ExtraButtonComponent,
	PluginSettingTab,
	Setting,
	type ValueComponent,
} from "obsidian"
import type { Mutable } from "./util"
import { RESOURCES } from "assets/locales"
import { TerminalPlugin } from "./main"

export interface Settings {
	readonly language: string
	readonly command: boolean
	readonly contextMenu: boolean
	readonly noticeTimeout: number
	readonly executables: Settings.Executables
}
export namespace Settings {
	export type Executables = {
		readonly [key in TerminalPlugin.Platform]: Executables.Entry
	}
	export namespace Executables {
		export interface Entry {
			readonly name: string
			readonly args: readonly string[]
		}
	}
}
export type MutableSettings = Mutable<Settings>
export const DEFAULT_SETTINGS: Settings = {
	command: true,
	contextMenu: true,
	executables: {
		darwin: {
			args: [],
			name: "Terminal.app",
		},
		linux: {
			args: [],
			name: "xterm-256color",
		},
		win32: {
			args: [],
			name: "C:\\Windows\\System32\\cmd.exe",
		},
	},
	language: "",
	noticeTimeout: 5,
} as const

export class SettingTab extends PluginSettingTab {
	public constructor(protected readonly plugin: TerminalPlugin) {
		super(plugin.app, plugin)
	}

	public display(): void {
		const { containerEl, plugin } = this,
			{ i18n } = plugin
		containerEl.empty()
		containerEl.createEl("h1", { text: plugin.i18n.t("name") })

		new Setting(containerEl)
			.setName(i18n.t("settings.language"))
			.setDesc(i18n.t("settings.language-description"))
			.addDropdown(this.#linkSetting(
				() => plugin.settings.language,
				value => void (plugin.settings.language = value),
				{
					post: (dropdown, activate) => void dropdown
						.onChange(async value => {
							await activate(value)
							await plugin.language.changeLanguage(value)
							this.display()
						}),
					pre: dropdown => void dropdown
						.addOption("", i18n.t("settings.language-default"))
						.addOptions(Object
							.fromEntries(Object
								.entries(RESOURCES.en.language)
								.filter(entry => entry.every(half => typeof half === "string")))),
				},
			))
			.addExtraButton(this.#resetButton(
				() => void (plugin.settings.language = DEFAULT_SETTINGS.language),
				i18n.t("asset:settings.language-icon"),
				{
					post: (button, activate) => void button
						.onClick(async () => {
							await activate()
							await plugin.language.changeLanguage(plugin.settings.language)
							this.display()
						}),
				},
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.reset-all"))
			.addButton(this.#resetButton(async () => {
				Object.assign(plugin.settings, DEFAULT_SETTINGS)
				await plugin.language.changeLanguage(plugin.settings.language)
			}))

		new Setting(containerEl)
			.setName(i18n.t("settings.add-to-commands"))
			.addToggle(this.#linkSetting(
				() => plugin.settings.command,
				value => void (plugin.settings.command = value),
			))
			.addExtraButton(this.#resetButton(
				() => void (plugin.settings.command = DEFAULT_SETTINGS.command),
				i18n.t("asset:settings.add-to-commands-icon"),
			))
		new Setting(containerEl)
			.setName(i18n.t("settings.add-to-context-menus"))
			.addToggle(this.#linkSetting(
				() => plugin.settings.contextMenu,
				value => void (plugin.settings.contextMenu = value),
			))
			.addExtraButton(this.#resetButton(
				() => void (plugin.settings.contextMenu =
					DEFAULT_SETTINGS.contextMenu),
				i18n.t("asset:settings.add-to-context-menus-icon"),
			))

		new Setting(containerEl)
			.setName(i18n.t("settings.notice-timeout"))
			.setDesc(i18n.t("settings.notice-timeout-description"))
			.addText(this.#linkSetting(
				() => plugin.settings.noticeTimeout.toString(),
				this.#setTextToNumber(value =>
					void (plugin.settings.noticeTimeout = value)),
			))
			.addExtraButton(this.#resetButton(
				() => void (plugin.settings.noticeTimeout =
					DEFAULT_SETTINGS.noticeTimeout),
				i18n.t("asset:settings.notice-timeout-icon"),
			))

		containerEl.createEl("h2", { text: i18n.t("settings.executables") })
		for (const key of TerminalPlugin.PLATFORMS) {
			new Setting(containerEl)
				.setName(i18n.t(`settings.executable-list.${key}`))
				.addText(this.#linkSetting(
					() => plugin.settings.executables[key].name,
					value => void (plugin.settings.executables[key].name = value),
				))
				.addExtraButton(this.#resetButton(
					() => void (plugin.settings.executables[key].name =
						DEFAULT_SETTINGS.executables[key].name),
					i18n.t("asset:settings.executable-list-icon"),
				))
		}
	}

	#linkSetting<
		C extends ValueComponent<V> & {
			onChange: (
				callback: (value: V) => any) => C
		},
		V,
	>(
		getter: () => V,
		setter: (value: V, component: C, getter: () => V) => any,
		action: SettingTab.ComponentAction<C, V> = {},
	) {
		return (component: C): void => {
			(action.pre ?? ((): void => { }))(component)
			const activate = async (value: V): Promise<void> => {
				const ret: unknown = await setter(value, component, getter)
				if (typeof ret === "boolean" && !ret) {
					return
				}
				await this.plugin.saveSettings()
			}
			component.setValue(getter()).onChange(activate);
			(action.post ?? ((): void => { }))(component, activate)
		}
	}

	#setTextToNumber<C extends ValueComponent<string>>(
		setter: (value: number, component: C, getter: () => string) => any,
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
			const ret: unknown = await setter(num, component, getter)
			if (typeof ret === "boolean" && !ret) {
				return false
			}
			return true
		}
	}

	#resetButton<C extends ButtonComponent | ExtraButtonComponent>(
		resetter: (component: C) => any,
		icon: string = this.plugin.i18n.t("asset:settings.reset-icon"),
		action: SettingTab.ComponentAction<C, void> = {},
	) {
		return (component: C): void => {
			(action.pre ?? ((): void => { }))(component)
			const activate = async (): Promise<void> => {
				const ret: unknown = await resetter(component)
				if (typeof ret === "boolean" && !ret) {
					return
				}
				const save = this.plugin.saveSettings()
				this.display()
				await save
			}
			component
				.setTooltip(this.plugin.i18n.t("settings.reset"))
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
			activate: (value: V) => Promise<void>,
		) => void
	}
}
