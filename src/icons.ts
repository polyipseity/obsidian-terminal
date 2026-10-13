import {
  UnnamespacedID,
  registerIcon,
} from "@polyipseity/obsidian-plugin-library";
import { siLinux, siMacos } from "simple-icons";
import { Settings } from "./settings-data.js";
import type { TerminalPlugin } from "./main.js";
import { composeTabIcon } from "./terminal/tab-icons.js";

/** The registered id of an icon set's tab icon: `terminal:tab-<set>`. */
export function tabIconId(
  context: TerminalPlugin,
  set: Settings.TabIconSet,
): string {
  return new UnnamespacedID(`tab-${set}`).namespaced(context);
}

export function loadIcons(context: TerminalPlugin): void {
  for (const [key, value] of Object.entries({
    linux: siLinux,
    macos: siMacos,
  })) {
    registerIcon(
      context,
      new UnnamespacedID(key).namespaced(context),
      value.svg,
    );
  }
  for (const set of Settings.TAB_ICON_SETS) {
    registerIcon(context, tabIconId(context, set), composeTabIcon(set));
  }
}
