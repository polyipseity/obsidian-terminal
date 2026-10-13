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
  return `${tabIconIdPrefix(context)}${set}`;
}

/** What the id of every icon set's tab icon starts with: `terminal:tab-`. */
export function tabIconIdPrefix(context: TerminalPlugin): string {
  return new UnnamespacedID("tab-").namespaced(context);
}

/** The icon of a terminal tab that shows no icon set: the one of 3.28.0. */
export function terminalIconId(context: TerminalPlugin): string {
  return context.language.value.t("asset:components.terminal.icon");
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
