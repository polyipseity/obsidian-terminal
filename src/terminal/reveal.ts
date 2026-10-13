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

function removeFlash(leaf: WorkspaceLeaf): void {
  // Without a tab header the flash stays.
  tabHeaderOf(leaf)?.classList.remove("is-flashing");
}

/**
 * Reveals `leaf` without the highlight Obsidian flashes on the tab header of a
 * leaf it reveals (`is-flashing`, 750 ms), which is drawn notched on main-area
 * tabs. Obsidian adds the class before `revealLeaf` first yields, so it comes
 * off as soon as the call returns: the reveal of a view that is still loading
 * stays pending while frames are painted. It comes off once more after the
 * reveal, for an Obsidian that adds the class later.
 */
export async function revealLeafWithoutFlash(
  workspace: Workspace,
  leaf: WorkspaceLeaf,
): Promise<void> {
  const revealed = workspace.revealLeaf(leaf);
  removeFlash(leaf);
  await revealed;
  removeFlash(leaf);
}
