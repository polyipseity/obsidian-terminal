import {
	type ButtonComponent,
	type ExtraButtonComponent,
	PluginSettingTab,
	Setting,
	type ValueComponent,
} from "obsidian"
import type TerminalPlugin from "./main"

export default interface Settings {
	command: boolean
	contextMenu: boolean
	noticeTimeout: number
	executables: TerminalExecutables
}
interface TerminalExecutable {
	name: string
	args: string[]
}
export interface TerminalExecutables {
	darwin: TerminalExecutable
	linux: TerminalExecutable
	win32: TerminalExecutable
}
export function getDefaultSettings(): Settings {
	return {
		command: true,
		contextMenu: true,
		executables: {
			darwin: {
				args: [],
				name: "Terminal.app",
			},
			linux: {
				args: [],
				name: "xterm",
			},
			win32: {
				args: [],
				name: "C:\\Windows\\System32\\cmd.exe",
			},
		},
		noticeTimeout: 5000,
	}
}

export class SettingTab extends PluginSettingTab {
	public constructor(protected readonly plugin: TerminalPlugin) {
		super(plugin.app, plugin)
	}

	public async display(): Promise<void> {
		const { containerEl, plugin } = this,
			{ i18n } = plugin
		containerEl.empty()
		containerEl.createEl("h1", { text: plugin.i18n.t("name") })

		const linkSetting = <C extends ValueComponent<V>
			& {
				onChange: (callback: (value: V) => any) => C
			}, V>(
				getter: () => V,
				setter: ((value: V, component: C, getter: () => V) => boolean) | (
					(value: V, component: C, getter: () => V) => void),
				action = (_0: C): void => { },
			) => (component: C) => {
				component
					.setValue(getter())
					.onChange(async value => {
						const ret = setter(value, component, getter)
						if (typeof ret === "boolean" && !ret) {
							return
						}
						await plugin.saveSettings()
					})
				action(component)
			},
			resetButton = <C extends ButtonComponent | ExtraButtonComponent>(
				resetter: ((component: C) => boolean) | ((component: C) => void),
				action = (_0: C): void => { },
			) =>
				(component: C) => {
					component
						.setTooltip(i18n.t("settings.reset"))
						.setIcon(i18n.t("assets:settings.reset-icon"))
						.onClick(async () => {
							const ret = resetter(component)
							if (typeof ret === "boolean" && !ret) {
								return
							}
							await Promise.all([plugin.saveSettings(), this.display()])
						})
					action(component)
				},
			textToNumberSetter = <C extends ValueComponent<string>>(
				setter: ((
					value: number,
					component: C,
					getter: () => string,
				) => boolean) | ((
					value: number,
					component: C,
					getter: () => string,
				) => void),
				parser = (value: string): number => parseInt(value, 10),
			) => (value: string, component: C, getter: () => string) => {
				const num = parser(value)
				if (isNaN(num)) {
					component.setValue(getter())
					return false
				}
				const ret = setter(num, component, getter)
				if (typeof ret === "boolean" && !ret) {
					return false
				}
				return true
			}

		new Setting(containerEl)
			.setName(i18n.t("settings.reset-all"))
			.addButton(resetButton(() => {
				Object.assign(plugin.settings, getDefaultSettings())
			}))

		new Setting(containerEl)
			.setName(i18n.t("settings.add-to-commands"))
			.addToggle(linkSetting(
				() => plugin.settings.command,
				value => {
					plugin.settings.command = value
				},
			))
			.addExtraButton(resetButton(() => {
				plugin.settings.command = getDefaultSettings().command
			}))
		new Setting(containerEl)
			.setName(i18n.t("settings.add-to-context-menus"))
			.addToggle(linkSetting(
				() => plugin.settings.contextMenu,
				value => {
					plugin.settings.contextMenu = value
				},
			))
			.addExtraButton(resetButton(() => {
				plugin.settings.contextMenu = getDefaultSettings().contextMenu
			}))

		new Setting(containerEl)
			.setName(i18n.t("settings.notice-timeout"))
			.addText(linkSetting(
				() => plugin.settings.noticeTimeout.toString(),
				textToNumberSetter(value => {
					plugin.settings.noticeTimeout = value
				})
			))
			.addExtraButton(resetButton(() => {
				plugin.settings.noticeTimeout =
					getDefaultSettings().noticeTimeout
			}))

		containerEl.createEl("h2", { text: i18n.t("settings.executables") })
		for (const key of Object.keys(getDefaultSettings().executables)) {
			const key0 = key as keyof TerminalExecutables
			new Setting(containerEl)
				.setName(i18n.t(`settings.executable-list.${key0}`))
				.addText(linkSetting(
					() => plugin.settings.executables[key0].name,
					value => {
						plugin.settings.executables[key0].name = value
					},
				))
				.addExtraButton(resetButton(() => {
					plugin.settings.executables[key0].name =
						getDefaultSettings().executables[key0].name
				}))
		}
		await Promise.resolve()
	}
}
