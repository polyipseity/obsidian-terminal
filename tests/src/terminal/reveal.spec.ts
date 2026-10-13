/**
 * Unit tests for `src/terminal/reveal.ts` — revealing a leaf without the
 * highlight Obsidian flashes on its tab header.
 */
import { App, WorkspaceLeaf } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  revealLeafWithoutFlash,
  tabHeaderOf,
} from "../../../src/terminal/reveal.js";
import { microtasks } from "../../support/helpers.js";

const FLASH = "is-flashing";

function makeWorkspace() {
  const { workspace } = new App();
  return { workspace, reveal: vi.spyOn(workspace, "revealLeaf") };
}

// Obsidian keeps the leaf's tab header in `tabHeaderEl` and flashes it on reveal.
function makeTabbedLeaf() {
  const leaf = new WorkspaceLeaf();
  const header = document.createElement("div");
  Object.assign(leaf, { tabHeaderEl: header });
  return { leaf, header };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("tabHeaderOf", () => {
  it("returns the tab header of a leaf", () => {
    const { leaf, header } = makeTabbedLeaf();

    expect(tabHeaderOf(leaf)).toBe(header);
  });

  it("returns null for a leaf without a tab header", () => {
    expect(tabHeaderOf(new WorkspaceLeaf())).toBeNull();
  });

  it("returns null for a tab header that is not an element", () => {
    const leaf = new WorkspaceLeaf();
    Object.assign(leaf, { tabHeaderEl: { classList: { remove: vi.fn() } } });

    expect(tabHeaderOf(leaf)).toBeNull();
  });
});

describe("revealLeafWithoutFlash", () => {
  it("removes the flash from the tab of the leaf it reveals", async () => {
    const { workspace, reveal } = makeWorkspace();
    const { leaf, header } = makeTabbedLeaf();
    reveal.mockImplementation(() => {
      header.classList.add(FLASH);
      return Promise.resolve();
    });

    await revealLeafWithoutFlash(workspace, leaf);

    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(header.classList.contains(FLASH)).toBe(false);
  });

  it("removes the flash while the reveal is still pending", async () => {
    const { workspace, reveal } = makeWorkspace();
    const { leaf, header } = makeTabbedLeaf();
    // A view that is still loading: Obsidian flashes the tab, then waits for it.
    const loading = Promise.withResolvers<undefined>();
    reveal.mockImplementation(() => {
      header.classList.add(FLASH);
      return loading.promise;
    });

    const revealed = revealLeafWithoutFlash(workspace, leaf);

    expect(header.classList.contains(FLASH)).toBe(false);
    loading.resolve(undefined);
    await revealed;
  });

  it("removes a flash added after revealLeaf yields before another task runs", async () => {
    const { workspace, reveal } = makeWorkspace();
    const { leaf, header } = makeTabbedLeaf();
    // An Obsidian that flashes the tab only after its first await.
    reveal.mockImplementation(async () => {
      await Promise.resolve();
      header.classList.add(FLASH);
    });

    const revealed = revealLeafWithoutFlash(workspace, leaf);
    await microtasks();

    expect(header.classList.contains(FLASH)).toBe(false);
    await revealed;
  });

  it("removes the flash when revealLeaf returns nothing", async () => {
    const { workspace } = makeWorkspace();
    const { leaf, header } = makeTabbedLeaf();
    // Obsidian before 1.7.2 returned void from revealLeaf.
    const reveal = vi.fn<() => void>(() => {
      header.classList.add(FLASH);
    });
    Object.assign(workspace, { revealLeaf: reveal });

    await revealLeafWithoutFlash(workspace, leaf);

    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(header.classList.contains(FLASH)).toBe(false);
  });

  it("keeps other classes on the tab", async () => {
    const { workspace } = makeWorkspace();
    const { leaf, header } = makeTabbedLeaf();
    header.className = `workspace-tab-header is-active ${FLASH}`;

    await revealLeafWithoutFlash(workspace, leaf);

    expect(header.className).toBe("workspace-tab-header is-active");
  });

  it("leaves the flash on the tab of another leaf", async () => {
    const { workspace } = makeWorkspace();
    const { leaf, header } = makeTabbedLeaf();
    const { header: other } = makeTabbedLeaf();
    // Both tabs are in the document, next to each other as in a tab group.
    document.body.append(header, other);
    header.classList.add(FLASH);
    other.classList.add(FLASH);

    await revealLeafWithoutFlash(workspace, leaf);

    expect(header.classList.contains(FLASH)).toBe(false);
    expect(other.classList.contains(FLASH)).toBe(true);
  });

  it("leaves a tab header alone that is not an element", async () => {
    const { workspace, reveal } = makeWorkspace();
    const leaf = new WorkspaceLeaf();
    const remove = vi.fn();
    Object.assign(leaf, { tabHeaderEl: { classList: { remove } } });

    await revealLeafWithoutFlash(workspace, leaf);

    expect(reveal).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(remove).not.toHaveBeenCalled();
  });

  it("rejects when revealLeaf rejects", async () => {
    const { workspace, reveal } = makeWorkspace();
    const { leaf } = makeTabbedLeaf();
    const failure = new Error("reveal failed");
    reveal.mockRejectedValueOnce(failure);

    await expect(revealLeafWithoutFlash(workspace, leaf)).rejects.toBe(failure);
  });

  it("rejects without throwing when revealLeaf throws", async () => {
    const { workspace, reveal } = makeWorkspace();
    const { leaf } = makeTabbedLeaf();
    const failure = new Error("reveal failed");
    reveal.mockImplementationOnce(() => {
      throw failure;
    });

    const revealed = revealLeafWithoutFlash(workspace, leaf);

    await expect(revealed).rejects.toBe(failure);
  });
});
