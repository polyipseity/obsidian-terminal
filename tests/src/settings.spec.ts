import { afterEach, describe, expect, it } from "vitest";
import en from "../../assets/locales/en/translation.json" with { type: "json" };
import {
  type Win32PythonDiagnosis,
  clearWindowsPythonDiagnoses,
  invalidateConPtyRuntime,
  pluginPythonStatusKey,
  windowsConPtyStatus,
} from "../../src/terminal/win32-doctor.js";

const found: Win32PythonDiagnosis = {
  candidate: "python",
  detail: "",
  executable: "C:\\Python\\python.exe",
  hostExecutable: "C:\\Python\\python.exe",
  status: "ok",
  version: "3.12.0",
};

describe("plugin Python status row", () => {
  afterEach(clearWindowsPythonDiagnoses);

  it("reports an unconfirmed host instead of claiming ConPTY is available", () => {
    const key = pluginPythonStatusKey(
      { ...found, hostExecutable: null },
      false,
      "python",
    );
    expect(key).toBe("ok-unconfirmed");
    expect(en.settings["python-status-ok-unconfirmed"]).toContain(
      "Terminals using the plugin's Python use ConHost",
    );
  });

  it("reports a runtime breaker and preserves the recheck control", () => {
    invalidateConPtyRuntime("python", "python");
    expect(pluginPythonStatusKey(found, false, "python")).toBe(
      "ok-runtime-unavailable",
    );
    expect(en.settings["python-status-ok-runtime-unavailable"]).toContain(
      "successful recheck",
    );
    expect(pluginPythonStatusKey(found, true, "python")).toBe("checking");
  });

  it("keeps resolved and failed interpreter descriptions", () => {
    expect(pluginPythonStatusKey(found, false, "python")).toBe("ok-resolved");
    expect(
      pluginPythonStatusKey({ ...found, status: "too-old" }, false, "python"),
    ).toBe("too-old");
  });

  it("scopes a failed plugin check while a profile override keeps ConPTY", () => {
    const pluginDiagnosis = { ...found, status: "missing" as const };
    expect(pluginPythonStatusKey(pluginDiagnosis, false, "python")).toBe(
      "missing",
    );
    expect(en.settings["python-status-missing"]).toContain(
      "terminals using the plugin's Python use ConHost",
    );
    expect(windowsConPtyStatus(found, found.executable)).toBe("available");
    expect(
      en.components.profile.integrated["win32-backend-status-available"],
    ).toContain("ConPTY is available");
  });
});
