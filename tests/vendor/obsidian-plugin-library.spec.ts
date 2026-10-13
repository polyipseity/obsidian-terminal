/**
 * The plugin ships the vendored library, and its row fixture
 * (`tests/fixtures/python-settings-ui.ts`) replaces `UpdatableUI.newSetting`.
 * This file runs the built library's own `newSetting`, so the suite fails when
 * the vendored commit lacks behaviour the settings and editor dialogs rely on.
 */
import { UpdatableUI, linkSetting } from "@polyipseity/obsidian-plugin-library";
import { afterEach, describe, expect, it, vi } from "vitest";

// `newSetting` builds its rows with Obsidian's `Setting`, and the shared mock's
// rows have no elements. Only `Setting` is replaced: its text control is the
// shared mock's `TextComponent` backed by a real input, which `setValue` writes
// without firing events and `onChange` hears through `input`, as in Obsidian.
vi.mock("obsidian", async (importOriginal) => {
  const obsidian = await importOriginal<typeof import("obsidian")>();
  class ElementText extends obsidian.TextComponent {
    public override readonly inputEl = document.createElement("input");

    public override setValue(value: string): this {
      this.inputEl.value = value;
      return this;
    }

    public override getValue(): string {
      return this.inputEl.value;
    }

    public override onChange(callback: (value: string) => unknown): this {
      this.inputEl.oninput = () => {
        callback(this.inputEl.value);
      };
      return this;
    }
  }
  class ElementSetting extends obsidian.Setting {
    public override readonly settingEl = document.createElement("div");

    public constructor(containerEl: HTMLElement) {
      super(containerEl);
      containerEl.append(this.settingEl);
    }

    public override addText(configure: (text: ElementText) => unknown): this {
      const text = new ElementText(this.settingEl);
      this.settingEl.append(text.inputEl);
      configure(text);
      return this;
    }
  }
  return { ...obsidian, Setting: ElementSetting };
});

describe("UpdatableUI.newSetting refresh of a text field", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps the caret of a focused field that linkSetting refreshes", async () => {
    const ui = new UpdatableUI(),
      refresh = vi.fn(() => {
        ui.update();
      });
    let stored = "python3",
      input: HTMLInputElement | undefined;
    ui.newSetting(document.body, (setting) => {
      setting.addText(
        linkSetting(
          () => stored,
          (value) => {
            stored = value;
          },
          refresh,
          {
            post(component) {
              input = component.inputEl;
            },
          },
        ),
      );
    });
    if (!input) throw new Error("addText did not run");

    // One keystroke before the first character: edit, caret, `input` event.
    input.focus();
    input.value = `u${input.value}`;
    input.setSelectionRange(1, 1);
    input.dispatchEvent(new Event("input"));
    // A refresh that throws would leave the field untouched and the caret with it.
    await vi.waitFor(() => {
      expect(refresh).toHaveReturnedTimes(1);
    });

    expect(stored).toBe("upython3");
    expect(input.value).toBe("upython3");
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 1]);
  });

  it("resets a field that is not focused to its first value", () => {
    const ui = new UpdatableUI();
    let input: HTMLInputElement | undefined;
    ui.newSetting(document.body, (setting) => {
      setting.addText((text) => {
        // Only the first render writes a value, so a refresh shows the reset.
        if (!input) text.setValue("initial");
        input = text.inputEl;
      });
    });
    if (!input) throw new Error("addText did not run");
    input.value = "stale";

    ui.update();

    expect(input.value).toBe("initial");
  });
});
