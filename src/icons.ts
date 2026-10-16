import {
  UnnamespacedID,
  registerIcon,
} from "@polyipseity/obsidian-plugin-library";
import { siLinux, siMacos } from "simple-icons";
import type { TerminalPlugin } from "./main.js";
import type { Settings } from "./settings-data.js";
import { isTabStatusShown } from "./terminal/tab-status.js";
import { composeTabIcon, composeTileIcon } from "./terminal/tab-icons.js";

/**
 * The registered id of the tab icon with a raised border and the status
 * marks: `terminal:tab-bezel`. Saved layouts name it.
 */
export function bezelIconId(context: TerminalPlugin): string {
  return new UnnamespacedID("tab-bezel").namespaced(context);
}

/**
 * The registered id of the rounded square without marks, the ribbon's icon
 * and a terminal tab's under Program status None: `terminal:tab-tile`.
 * Layouts saved by earlier builds name it too.
 */
export function tileIconId(context: TerminalPlugin): string {
  return new UnnamespacedID("tab-tile").namespaced(context);
}

/**
 * The registered id of a terminal tab's icon under a Program status: the
 * rounded square under None, the one with a raised border, which carries
 * the marks, under Still and Animated.
 */
export function tabIconId(
  context: TerminalPlugin,
  settings: Pick<Settings, "tabStatus">,
): string {
  return isTabStatusShown(settings)
    ? bezelIconId(context)
    : tileIconId(context);
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
  registerIcon(context, bezelIconId(context), composeTabIcon());
  registerIcon(context, tileIconId(context), composeTileIcon());
}
