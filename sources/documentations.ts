import {
	DocumentationMarkdownView,
	addCommand,
	anyToError,
	deepFreeze,
	printError,
	revealPrivate,
	typedKeys,
} from "@polyipseity/obsidian-plugin-library"
import { DOMClasses2 } from "./magic.js"
import type { TerminalPlugin } from "./main.js"
import changelogMd from "../CHANGELOG.md"
import readmeMd from "../README.md"
import semverLt from "semver/functions/lt.js"

export const DOCUMENTATIONS = deepFreeze({
	async changelog(view: DocumentationMarkdownView.Registered, active: boolean) {
		await view.open(active, {
			data: await changelogMd,
			displayTextI18nKey: "translation:generic.documentations.changelog",
			iconI18nKey: "asset:generic.documentations.changelog-icon",
		})
	},
	donate(view: DocumentationMarkdownView.Registered) {
		const { context, context: { app, manifest } } = view
		revealPrivate(context, [app], app0 => {
			const { setting: { settingTabs } } = app0
			for (const tab of settingTabs) {
				const { id, containerEl: { ownerDocument } } = tab
				if (id !== "community-plugins") { continue }
				const div = ownerDocument.createElement("div")
				tab.renderInstalledPlugin(manifest, div)
				const element = div.querySelector(
					`.${DOMClasses2.SVG_ICON}.${DOMClasses2.LUCIDE_HEART}`,
				)?.parentElement
				if (!element) { throw new Error(String(div)) }
				element.click()
				return
			}
			throw new Error(settingTabs.toString())
		}, error => { throw error })
	},
	async readme(view: DocumentationMarkdownView.Registered, active: boolean) {
		await view.open(active, {
			data: await readmeMd,
			displayTextI18nKey: "translation:generic.documentations.readme",
			iconI18nKey: "asset:generic.documentations.readme-icon",
		})
	},
})
export type DocumentationKeys = readonly ["changelog", "donate", "readme"]
export const DOCUMENTATION_KEYS = typedKeys<DocumentationKeys>()(DOCUMENTATIONS)

class Loaded0 {
	public constructor(
		public readonly context: TerminalPlugin,
		public readonly docMdView: DocumentationMarkdownView.Registered,
	) { }

	public open(key: DocumentationKeys[number], active = true): void {
		const {
			context,
			context: { version, settings, language: { i18n } },
			docMdView,
		} = this;
		(async (): Promise<void> => {
			try {
				await DOCUMENTATIONS[key](docMdView, active)
				if (key === "changelog" && version !== null) {
					settings.mutate(settingsM => {
						settingsM.lastReadChangelogVersion = version
					}).then(async () => settings.write())
						.catch(error => { self.console.error(error) })
				}
			} catch (error) {
				printError(
					anyToError(error),
					() => i18n.t("errors.error-opening-documentation"),
					context,
				)
			}
		})()
	}
}
export function loadDocumentations(
	context: TerminalPlugin,
	readme = false,
): loadDocumentations.Loaded {
	const { version, language: { i18n }, settings } = context,
		ret = new Loaded0(
			context,
			DocumentationMarkdownView.register(context),
		)
	for (const doc of DOCUMENTATION_KEYS) {
		addCommand(context, () => i18n.t(`commands.open-documentation-${doc}`), {
			callback() { ret.open(doc) },
			icon: i18n.t(`asset:commands.open-documentation-${doc}-icon`),
			id: `open-documentation.${doc}`,
		})
	}
	if (readme) { ret.open("readme", false) }
	if (version !== null &&
		settings.copy.openChangelogOnUpdate &&
		semverLt(settings.copy.lastReadChangelogVersion, version)) {
		ret.open("changelog", false)
	}
	return ret
}
export namespace loadDocumentations {
	export type Loaded = Loaded0
}
