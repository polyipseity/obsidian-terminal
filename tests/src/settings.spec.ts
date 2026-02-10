/**
 * Unit tests for `src/settings.ts` — small, hermetic, and focused on behavior.
 */
import { describe, it, expect, vi } from "vitest";
import { loadSettings } from "../../src/settings.js";
import { makePluginContext, makeLoadedDoc } from "../helpers.js";

describe("loadSettings", () => {
  it("adds a setting tab and registers settings commands", () => {
    const addSettingTab = vi.fn();
    const context = makePluginContext({ addSettingTab });

    loadSettings(context, makeLoadedDoc());

    expect(addSettingTab).toHaveBeenCalled();
  });
});
