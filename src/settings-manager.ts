import {
  type Fixer,
  type PluginContext,
  SettingsManager,
} from "@polyipseity/obsidian-plugin-library";
import type { LocalSettings, Settings } from "./settings-data.js";

/**
 * The manager of the plugin's settings.
 *
 * Reading settings in (Reload in the settings tab, the Import commands) merges
 * them into the current settings, so a key that the read settings lack keeps
 * its current value. Keymappings read without a version of the built-in
 * keymappings, as a device on 3.29.0 saves them, would then keep the version
 * of this device, and the built-in keymappings would never be offered to them
 * again. A read leaves such keymappings without a version, so that the next
 * start offers them, as it does for a data.json of 3.29.0.
 */
export class TerminalSettingsManager extends SettingsManager<Settings> {
  // The plugin's own context type. With the library's wider one, tsc rejects
  // the plugin as a context in `main.ts` when it checks this file first.
  public constructor(
    context: PluginContext<Settings, LocalSettings>,
    fixer: Fixer<Settings>,
  ) {
    super(context, fixer);
  }

  public override async read(
    reader: () => unknown = async (): Promise<unknown> => this.read0(),
  ): Promise<void> {
    let read: unknown = null;
    await super.read(async () => {
      read = await reader();
      return read;
    });
    if (this.fixer(read).value.keymappingDefaultsVersion === undefined) {
      await this.mutate((settings) => {
        delete settings.keymappingDefaultsVersion;
      });
    }
  }
}
