import {
	type ButtonComponent,
	type ExtraButtonComponent,
	PluginSettingTab,
	Setting,
	type ValueComponent,
} from "obsidian"
import { I18N } from "./i18n"
import type ObsidianTerminalPlugin from "./main"

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
		containerEl.createEl("h1", { text: I18N.t("name") })

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
						.setTooltip(I18N.t("settings.reset"))
						.setIcon(I18N.t("assets:settings.reset-icon"))
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
			.setName(I18N.t("settings.reset-all"))
			.addButton(resetButton(() => {
				Object.assign(this.plugin.settings, getDefaultSettings())
			}))

		new Setting(containerEl)
			.setName(I18N.t("settings.add-to-commands"))
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
			.setName(I18N.t("settings.add-to-context-menus"))
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
			.setName(I18N.t("settings.notice-timeout"))
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

		containerEl.createEl("h2", { text: I18N.t("settings.executables") })
		for (const key of Object.keys(getDefaultSettings().executables)) {
			const key0 = key as keyof TerminalExecutables
			new Setting(containerEl)
				.setName(I18N.t(`settings.executable-list.${key0}`))
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
