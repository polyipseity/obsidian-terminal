/**
 * Unit tests for `src/utils.ts`: `setSettingDesc` in the main window and in a
 * second window. An iframe's document stands in for the Settings window that
 * Obsidian 1.14.4 shows the plugin settings in.
 */
import { createChildElement } from "@polyipseity/obsidian-plugin-library";
import { Setting } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setSettingDesc } from "../../src/utils.js";

/**
 * A row made in the main window, as Obsidian makes the settings tab's rows
 * wherever the tab is shown later.
 */
class MainWindowRow extends Setting {
  public override readonly descEl = document.createElement("div");
}

/** The main window's document, or an iframe's for the Settings window. */
function windowDocument(where: string): Document {
  if (where === "main") return document;
  const { contentDocument } = document.body.appendChild(
    document.createElement("iframe"),
  );
  if (!contentDocument) throw new Error("iframe has no document");
  return contentDocument;
}

/** A row whose container is shown in the main window or in a second one. */
function rowShownIn(where: string): {
  readonly row: MainWindowRow;
  readonly shownIn: Document;
} {
  const shownIn = windowDocument(where),
    containerEl = document.createElement("div"),
    row = new MainWindowRow(containerEl);
  containerEl.append(row.descEl);
  shownIn.body.append(containerEl);
  return { row, shownIn };
}

describe("setSettingDesc", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it.each(["main", "Settings"])(
    "builds the description in the document of the %s window and shows it as elements",
    (where) => {
      const { row, shownIn } = rowShownIn(where),
        setDesc = vi.spyOn(row, "setDesc"),
        build = vi.fn((fragment: DocumentFragment): void => {
          createChildElement(fragment, "code", (ele) => {
            ele.textContent = "Obsidian";
          });
          fragment.append(" is exposed");
        });
      row.descEl.textContent = "Old description";

      expect(setSettingDesc(row, build)).toBe(row);
      expect(build).toHaveBeenCalledOnce();
      const fragment = build.mock.calls[0]?.[0];
      // Compared as a boolean: printing a Document on failure walks the window.
      expect(
        fragment?.ownerDocument === shownIn,
        "built in the shown document",
      ).toBe(true);
      // A fragment of the second window fails the main window's instanceof
      // test, so Setting.setDesc would show it as "[object DocumentFragment]".
      expect(fragment instanceof DocumentFragment).toBe(where === "main");
      expect(setDesc).not.toHaveBeenCalled();
      expect(row.descEl.textContent).toBe("Obsidian is exposed");
      expect(row.descEl.firstElementChild?.tagName).toBe("CODE");
    },
  );

  it("replaces the description it set before", () => {
    const { row } = rowShownIn("Settings");
    setSettingDesc(row, (fragment) => {
      fragment.append("first");
    });
    setSettingDesc(row, (fragment) => {
      fragment.append("second");
    });
    expect(row.descEl.textContent).toBe("second");
  });
});
