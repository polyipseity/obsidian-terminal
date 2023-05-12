import { deepFreeze, typedKeys } from "sources/utils/util"
import { DOMClasses } from "sources/magic"
import { DocumentationMarkdownView } from "./view"
import type { PLACEHOLDERPlugin } from "sources/main"
import changelogMd from "CHANGELOG.md"
import { newCollabrativeState } from "sources/utils/obsidian"
import readmeMd from "README.md"
import { revealPrivate } from "sources/utils/private"

export const DOCUMENTATIONS = deepFreeze({
	async changelog(plugin: PLACEHOLDERPlugin, active: boolean) {
		await openMarkdown(plugin, active, {
			data: await changelogMd,
			displayTextI18nKey: "translation:generic.documentations.changelog",
			iconI18nKey: "asset:generic.documentations.changelog-icon",
		})
	},
	donate(plugin: PLACEHOLDERPlugin) {
		const { app, manifest } = plugin
		revealPrivate(plugin, [app], app0 => {
			const { setting: { settingTabs } } = app0
			for (const tab of settingTabs) {
				const { id, containerEl: { ownerDocument } } = tab
				if (id !== "community-plugins") { continue }
				const div = ownerDocument.createElement("div")
				tab.renderInstalledPlugin(manifest, div)
				const element = div.querySelector(
					`.${DOMClasses.SVG_ICON}.${DOMClasses.LUCIDE_HEART}`,
				)?.parentElement
				if (!element) { throw new Error(String(div)) }
				element.click()
				return
			}
			throw new Error(settingTabs.toString())
		}, error => { throw error })
	},
	async readme(plugin: PLACEHOLDERPlugin, active: boolean) {
		await openMarkdown(plugin, active, {
			data: await readmeMd,
			displayTextI18nKey: "translation:generic.documentations.readme",
			iconI18nKey: "asset:generic.documentations.readme-icon",
		})
	},
})
export type DocumentationKeys = readonly ["changelog", "donate", "readme"]
export const DOCUMENTATION_KEYS = typedKeys<DocumentationKeys>()(DOCUMENTATIONS)

async function openMarkdown(
	plugin: PLACEHOLDERPlugin,
	active: boolean,
	state: DocumentationMarkdownView.State,
): Promise<void> {
	const { app: { workspace } } = plugin
	return new Promise(resolve => {
		workspace.onLayoutReady(() => {
			resolve(workspace.getLeaf("tab").setViewState({
				active,
				state: newCollabrativeState(
					plugin,
					new Map([
						[
							DocumentationMarkdownView.type,
							state satisfies DocumentationMarkdownView.State,
						],
					]),
				),
				type: DocumentationMarkdownView.type.namespaced(plugin),
			}))
		})
	})
}
