import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LINK_HANDLER } from "../../../src/terminal/profile-presets.js";

describe("DEFAULT_LINK_HANDLER", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the link in the window that received the click", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    DEFAULT_LINK_HANDLER.activate(
      new MouseEvent("click", { view: window }),
      "https://example.com/",
      { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } },
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      "https://example.com/",
      "_blank",
      "noreferrer",
    );
  });

  it("leaves non-HTTP(S) OSC 8 links disabled", () => {
    // xterm only passes http(s) OSC 8 links to `activate` unless this flag is set.
    // Link labels can hide the target URI, so widening the schemes is a separate policy decision.
    expect(DEFAULT_LINK_HANDLER.allowNonHttpProtocols).toBeFalsy();
  });
});
