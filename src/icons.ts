import {
  UnnamespacedID,
  registerIcon,
} from "@polyipseity/obsidian-plugin-library";
import { siLinux, siMacos } from "simple-icons";
import type { TerminalPlugin } from "./main.js";
import { composeRibbonIcon, composeTabIcon } from "./terminal/tab-icons.js";

/**
 * The registered id of a terminal tab's icon: `terminal:tab-bezel`. Saved
 * layouts name it, so it keeps the name of the drawing it was chosen by.
 */
export function tabIconId(context: TerminalPlugin): string {
  return new UnnamespacedID("tab-bezel").namespaced(context);
}

/** The registered id of the ribbon button's icon: `terminal:ribbon`. */
export function ribbonIconId(context: TerminalPlugin): string {
  return new UnnamespacedID("ribbon").namespaced(context);
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
  registerIcon(context, tabIconId(context), composeTabIcon());
  registerIcon(context, ribbonIconId(context), composeRibbonIcon());
}
