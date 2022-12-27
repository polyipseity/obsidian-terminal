import {
	type ButtonComponent,
	type ExtraButtonComponent,
	PluginSettingTab,
	Setting,
	type ValueComponent,
} from "obsidian"
import type ObsidianTerminalPlugin from "./main"
import { i18n } from "./i18n"

export default interface Settings {
	command: boolean
	contextMenu: boolean
	noticeTimeout: number
	executables: TerminalExecutables
}
export interface TerminalExecutables {
	darwin: string
	linux: string
	win32: string
}
export function getDefaultSettings(): Settings {
	return {
		command: true,
		contextMenu: true,
		executables: {
			darwin: "Terminal.app",
			linux: "xterm",
			win32: "C:\\Windows\\System32\\cmd.exe",
		},
		noticeTimeout: 5000,
	}
}

export class SettingTab extends PluginSettingTab {
	public constructor(protected readonly plugin: ObsidianTerminalPlugin) {
		super(plugin.app, plugin)
	}

	public display(): void {
		const { containerEl } = this
		containerEl.empty()
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		containerEl.createEl("h1", { text: i18n.t("name") })

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
						await this.plugin.saveSettings()
					})
				action(component)
			},
			resetButton = <C extends ButtonComponent | ExtraButtonComponent>(
				resetter: ((component: C) => boolean) | ((component: C) => void),
				action = (_0: C): void => { },
			) =>
				(component: C) => {
					component
						.setTooltip("Reset")
						.setIcon("reset")
						.onClick(async () => {
							const ret = resetter(component)
							if (typeof ret === "boolean" && !ret) {
								return
							}
							await this.plugin.saveSettings()
							this.display()
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
			.setName("Reset all")
			.addButton(resetButton(() => {
				Object.assign(this.plugin.settings, getDefaultSettings())
			}))

		new Setting(containerEl)
			.setName("Command")
			.setDesc("Add terminal commands.")
			.addToggle(linkSetting(
				() => this.plugin.settings.command,
				value => {
					this.plugin.settings.command = value
				},
			))
			.addExtraButton(resetButton(() => {
				this.plugin.settings.command = getDefaultSettings().command
			}))
		new Setting(containerEl)
			.setName("Context menu")
			.setDesc("Add terminal buttons to context menus.")
			.addToggle(linkSetting(
				() => this.plugin.settings.contextMenu,
				value => {
					this.plugin.settings.contextMenu = value
				},
			))
			.addExtraButton(resetButton(() => {
				this.plugin.settings.contextMenu = getDefaultSettings().contextMenu
			}))

		new Setting(containerEl)
			.setName("Notice timeout")
			.setDesc("Timeout for informational notices.")
			.addText(linkSetting(
				() => this.plugin.settings.noticeTimeout.toString(),
				textToNumberSetter(value => {
					this.plugin.settings.noticeTimeout = value
				})
			))
			.addExtraButton(resetButton(() => {
				this.plugin.settings.noticeTimeout =
					getDefaultSettings().noticeTimeout
			}))

		containerEl.createEl("h2", { text: "Executables" })
		for (const key of Object.keys(getDefaultSettings().executables)) {
			const key0 = key as keyof TerminalExecutables
			new Setting(containerEl)
				.setName(key)
				.addText(linkSetting(
					() => this.plugin.settings.executables[key0],
					value => {
						this.plugin.settings.executables[key0] = value
					},
				))
				.addExtraButton(resetButton(() => {
					this.plugin.settings.executables[key0] =
						getDefaultSettings().executables[key0]
				}))
		}
	}
}
