import { type App, Plugin, type PluginManifest } from "obsidian";
import { EarlyPatchManager, loadPatch } from "./patch.js";
import {
  LanguageManager,
  type PluginContext,
  SI_PREFIX_SCALE,
  type SemVerString,
  SettingsManager,
  StatusBarHider,
  StorageSettingsManager,
  createI18n,
  semVerString,
} from "@polyipseity/obsidian-plugin-library";
import { LocalSettings, Settings } from "./settings-data.js";
import { MAX_HISTORY, PLUGIN_UNLOAD_DELAY } from "./magic.js";
import { DeveloperConsolePseudoterminal } from "./terminal/pseudoterminal.js";
import { PluginLocales } from "../assets/locales.js";
import { isNil } from "lodash-es";
import { loadDocumentations } from "./documentations.js";
import { loadIcons } from "./icons.js";
import { loadSettings } from "./settings.js";
import { loadTerminal } from "./terminal/load.js";

export class TerminalPlugin
  extends Plugin
  implements PluginContext<Settings, LocalSettings>
{
  public readonly version: SemVerString | null;
  public readonly language: LanguageManager;
  public readonly localSettings: StorageSettingsManager<LocalSettings>;
  public readonly settings: SettingsManager<Settings>;
  public readonly developerConsolePTY =
    new DeveloperConsolePseudoterminal.Manager(this);

  public readonly earlyPatch;
  public readonly statusBarHider = new StatusBarHider(this);

  public constructor(app: App, manifest: PluginManifest) {
    const earlyPatch = new EarlyPatchManager(app, { maxHistory: MAX_HISTORY });
    earlyPatch.load();
    super(app, manifest);
    this.earlyPatch = earlyPatch;
    try {
      this.version = semVerString(manifest.version);
    } catch (error) {
      self.console.warn(error);
      this.version = null;
    }
    this.language = new LanguageManager(this, async () =>
      createI18n(PluginLocales.RESOURCES, PluginLocales.FORMATTERS, {
        defaultNS: PluginLocales.DEFAULT_NAMESPACE,
        fallbackLng: PluginLocales.FALLBACK_LANGUAGES,
        returnNull: PluginLocales.RETURN_NULL,
      }),
    );
    this.localSettings = new StorageSettingsManager(this, LocalSettings.fix);
    this.settings = new SettingsManager(this, Settings.fix);
  }

  public displayName(unlocalized = false): string {
    return unlocalized
      ? this.language.value.t("name", {
          interpolation: { escapeValue: false },
          lng: PluginLocales.DEFAULT_LANGUAGE,
        })
      : this.language.value.t("name");
  }

  public override onload(): void {
    (async (): Promise<void> => {
      try {
        const loaded: unknown = await this.loadData(),
          {
            developerConsolePTY,
            earlyPatch,
            language,
            localSettings,
            statusBarHider,
            settings,
          } = this,
          earlyChildren = [earlyPatch, language, localSettings, settings],
          // Placeholder to resolve merge conflicts more easily
          children = [developerConsolePTY, statusBarHider];
        for (const child of earlyChildren) {
          child.unload();
        }
        for (const child of earlyChildren) {
          // Delay unloading since there are unload tasks that cannot be awaited
          this.register(() => {
            const id = self.setTimeout(() => {
              child.unload();
            }, PLUGIN_UNLOAD_DELAY * SI_PREFIX_SCALE);
            child.register(() => {
              self.clearTimeout(id);
            });
          });
          child.load();
        }
        await Promise.all(earlyChildren.map(async (child) => child.onLoaded));
        for (const child of children) {
          this.addChild(child);
        }
        await Promise.all([
          Promise.resolve().then(() => {
            settings.onMutate(
              (settings0) => settings0.interceptLogging,
              (cur) => {
                this.earlyPatch.value.enableLoggingPatch(cur);
              },
            );
            this.earlyPatch.value.enableLoggingPatch(
              settings.value.interceptLogging,
            );
          }),
          Promise.resolve().then(() => {
            loadPatch(this);
          }),
          Promise.resolve().then(() => {
            loadIcons(this);
          }),
          Promise.resolve().then(() => {
            loadSettings(this, loadDocumentations(this, isNil(loaded)));
          }),
          Promise.resolve().then(() => {
            loadTerminal(this);
          }),
          Promise.resolve().then(() => {
            this.register(
              settings.onMutate(
                (settings0) => settings0.hideStatusBar,
                () => {
                  statusBarHider.update();
                },
              ),
            );
            statusBarHider.hide(
              () => settings.value.hideStatusBar === "always",
            );
          }),
        ]);
      } catch (error) {
        self.console.error(error);
      }
    })();
  }
}
// Needed for loading
export default TerminalPlugin;
