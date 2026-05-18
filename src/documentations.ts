import {
  DocumentationMarkdownView,
  StorageSettingsManager,
  activeSelf,
  addCommand,
  anyToError,
  deepFreeze,
  openExternal,
  printError,
  revealPrivate,
  toJSONOrString,
  typedKeys,
} from "@polyipseity/obsidian-plugin-library";
import semverLt from "semver/functions/lt.js";
import { MarkOptional } from "ts-essentials";
import changelogMd from "../CHANGELOG.md";
import readmeMd from "../README.md";
import { DOMClasses2 } from "./magic.js";
import type { TerminalPlugin } from "./main.js";

export const DOCUMENTATIONS = deepFreeze({
  async changelog(
    view: DocumentationMarkdownView.Registered,
    opts: DocumentationOpenOptions,
  ) {
    await view.open(opts.active, {
      data: await changelogMd,
      displayTextI18nKey: "translation:generic.documentations.changelog",
      iconI18nKey: "asset:generic.documentations.changelog-icon",
    });
  },
  donate(
    view: DocumentationMarkdownView.Registered,
    opts: DocumentationOpenOptions,
  ) {
    const {
      context,
      context: { app, manifest },
    } = view;
    revealPrivate(
      context,
      [app],
      (app0) => {
        const {
          setting: { settingTabs },
        } = app0;
        for (const tab of settingTabs) {
          const {
            containerEl: { ownerDocument },
            id,
            installedPlugins,
          } = tab;
          if (id !== "community-plugins") {
            continue;
          }

          // Find the donate button in the already-rendered installed plugins list:
          // locate this plugin's row by matching the name from the manifest, then
          // get the heart icon's parent element (the clickable button) and click it.
          // Note: `textContent` is `string | null` so both `?.` are required;
          // `querySelector` can also return `null` so `?.parentElement` is needed too.
          let div = installedPlugins.listEl ?? installedPlugins.containerEl;
          let element = [
            ...(div?.querySelectorAll(`.${DOMClasses2.SETTING_ITEM}`) ?? []),
          ]
            .find(
              (item) =>
                item
                  .querySelector(`.${DOMClasses2.SETTING_ITEM_NAME}`)
                  ?.textContent?.trim() === manifest.name,
            )
            ?.querySelector(
              `.${DOMClasses2.SVG_ICON}.${DOMClasses2.LUCIDE_HEART}`,
            )?.parentElement;
          if (!element) {
            activeSelf(ownerDocument).console.warn(toJSONOrString(div));

            // Deprecated: older versions of Obsidian (pre-1.12.7) exposed
            // `renderInstalledPlugin`, which rendered each plugin's UI into a
            // caller-supplied detached element; the heart icon was then queried from
            // that subtree and clicked. This API was removed in Obsidian 1.12.7.
            div = ownerDocument.createElement("div");
            tab.renderInstalledPlugin(manifest, div);
            element = div.querySelector(
              `.${DOMClasses2.SVG_ICON}.${DOMClasses2.LUCIDE_HEART}`,
            )?.parentElement;
            if (!element) {
              activeSelf(ownerDocument).console.warn(toJSONOrString(div));
            }
          }
          if (!element) {
            throw new Error(toJSONOrString(tab));
          }
          element.click();
          return;
        }
        throw new Error(toJSONOrString(settingTabs));
      },
      (error) => {
        const { fundingUrl } = manifest;
        const url =
          typeof fundingUrl === "string"
            ? fundingUrl
            : (Object.values(fundingUrl ?? {})[0] ?? null);
        if (url === null) {
          throw error;
        }
        openExternal(activeSelf(opts.event), url);
      },
    );
  },
  async readme(
    view: DocumentationMarkdownView.Registered,
    opts: DocumentationOpenOptions,
  ) {
    await view.open(opts.active, {
      data: await readmeMd,
      displayTextI18nKey: "translation:generic.documentations.readme",
      iconI18nKey: "asset:generic.documentations.readme-icon",
    });
  },
});
export type DocumentationKeys = readonly ["changelog", "donate", "readme"];
export const DOCUMENTATION_KEYS =
  typedKeys<DocumentationKeys>()(DOCUMENTATIONS);
export interface DocumentationOpenOptions {
  readonly active: boolean;
  readonly event: UIEvent | null;
}

class Loaded0 {
  public constructor(
    public readonly context: TerminalPlugin,
    public readonly docMdView: DocumentationMarkdownView.Registered,
  ) {}

  public open(
    key: DocumentationKeys[number],
    opts: MarkOptional<
      DocumentationOpenOptions,
      keyof DocumentationOpenOptions
    > = {},
  ): void {
    const { active = true, event = null } = opts;
    const {
      context,
      context: {
        version,
        language: { value: i18n },
        localSettings,
      },
      docMdView,
    } = this;
    (async (): Promise<void> => {
      try {
        await DOCUMENTATIONS[key](docMdView, { active, event });
        if (key === "changelog" && version !== null) {
          localSettings
            .mutate((lsm) => {
              lsm.lastReadChangelogVersion = version;
            })
            .then(async () => localSettings.write())
            .catch((error: unknown) => {
              self.console.error(error);
            });
        }
      } catch (error) {
        printError(
          anyToError(error),
          () => i18n.t("errors.error-opening-documentation"),
          context,
        );
      }
    })();
  }
}
export function loadDocumentations(
  context: TerminalPlugin,
  readme = false,
): loadDocumentations.Loaded {
  const {
      version,
      language: { value: i18n },
      localSettings,
      settings,
    } = context,
    ret = new Loaded0(context, DocumentationMarkdownView.register(context));
  for (const doc of DOCUMENTATION_KEYS) {
    addCommand(context, () => i18n.t(`commands.open-documentation-${doc}`), {
      callback() {
        ret.open(doc);
      },
      icon: i18n.t(`asset:commands.open-documentation-${doc}-icon`),
      id: `open-documentation.${doc}`,
    });
  }
  if (readme) {
    ret.open("readme", { active: false });
  }
  if (
    version !== null &&
    settings.value.openChangelogOnUpdate &&
    !StorageSettingsManager.hasFailed(localSettings.value) &&
    semverLt(localSettings.value.lastReadChangelogVersion, version)
  ) {
    ret.open("changelog", { active: false });
  }
  return ret;
}
export namespace loadDocumentations {
  export type Loaded = Loaded0;
}
