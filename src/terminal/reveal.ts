import { instanceOf } from "@polyipseity/obsidian-plugin-library";
import type { Workspace, WorkspaceLeaf } from "obsidian";

/**
 * The tab header of `leaf`, or `null` where this Obsidian has none under that
 * name: `tabHeaderEl` is not part of Obsidian's API.
 */
export function tabHeaderOf(leaf: WorkspaceLeaf): HTMLElement | null {
  return "tabHeaderEl" in leaf && instanceOf(leaf.tabHeaderEl, HTMLElement)
    ? leaf.tabHeaderEl
    : null;
}

/**
 * Reveals `leaf` without the highlight Obsidian flashes on the tab header of a
 * leaf it reveals (`is-flashing`, 750 ms), which is drawn notched on main-area
 * tabs. Both callers reveal a terminal view that is already loaded, so the
 * reveal settles and the class comes off before the next frame is painted.
 */
export async function revealLeafWithoutFlash(
  workspace: Workspace,
  leaf: WorkspaceLeaf,
): Promise<void> {
  await workspace.revealLeaf(leaf);
  // Without a tab header the flash stays.
  tabHeaderOf(leaf)?.classList.remove("is-flashing");
}
