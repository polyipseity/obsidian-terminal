/**
 * Unit tests for `src/documentations.ts` - low-level helpers used by the documentation UI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// We intentionally keep `DOCUMENTATIONS` untyped to avoid tight coupling to
// the library's internal types; tests only exercise behavior, not full typing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let DOCUMENTATIONS: any;
interface ViewMock {
  context: { app: { setting: { settingTabs: unknown[] }; manifest: unknown } };
}
beforeEach(async () => {
  // Import module after global reset so global test setup/mocks are applied
  const mod = await import("../../src/documentations.js");
  DOCUMENTATIONS = mod.DOCUMENTATIONS;
});

describe("src/documentations.ts - DOCUMENTATIONS.donate", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("clicks the rendered plugin heart when community-plugins tab exists", () => {
    const clickSpy = vi.fn();

    const fakeTab = {
      id: "community-plugins",
      containerEl: { ownerDocument: { createElement: () => ({}) } },
      renderInstalledPlugin: (
        _manifest: unknown,
        div: {
          querySelector?: (sel: string) => {
            parentElement?: { click: () => void };
          };
        },
      ) => {
        // emulate renderInstalledPlugin mutating div so querySelector returns element
        div.querySelector = () => ({ parentElement: { click: clickSpy } });
      },
    };

    const view: ViewMock = {
      context: {
        app: {
          setting: { settingTabs: [fakeTab] },
          manifest: { id: "id" },
        },
      },
    };

    DOCUMENTATIONS.donate(view);
    expect(clickSpy).toHaveBeenCalled();
  });

  it("throws when community-plugins tab not present", () => {
    const fakeTab = {
      id: "other-tab",
      containerEl: { ownerDocument: {} },
      renderInstalledPlugin: () => {},
    };
    const view: ViewMock = {
      context: { app: { setting: { settingTabs: [fakeTab] }, manifest: {} } },
    };

    expect(() => DOCUMENTATIONS.donate(view)).toThrow();
  });
});
