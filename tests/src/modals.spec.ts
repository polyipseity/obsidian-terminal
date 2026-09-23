import { afterEach, describe, expect, it } from "vitest";
import en from "../../assets/locales/en/translation.json" with { type: "json" };
import {
  type Win32PythonDiagnosis,
  clearWindowsPythonDiagnoses,
  invalidateConPtyRuntime,
  pythonOverrideStatus,
  windowsConPtyStatus,
} from "../../src/terminal/win32-doctor.js";

const found: Win32PythonDiagnosis = {
  candidate: "C:\\Python\\python.exe",
  detail: "",
  executable: "C:\\Python\\python.exe",
  hostExecutable: "C:\\Python\\python.exe",
  status: "ok",
  version: "3.12.0",
};

describe("Windows profile editor status", () => {
  afterEach(clearWindowsPythonDiagnoses);

  it("distinguishes a working override from a successful fallback without rewriting it", () => {
    const override = "C:\\Missing\\python.exe";
    expect(pythonOverrideStatus(override, found)).toBe("fallback");
    expect(pythonOverrideStatus("c:\\python\\PYTHON.exe", found)).toBe("using");
    expect(override).toBe("C:\\Missing\\python.exe");
    expect(
      en.components.profile.integrated["Python-status-fallback"],
    ).toContain("does not run on this device — using {{executable}}");
  });

  it("shows a resolved alias as using its interpreter", () => {
    const alias = { ...found, candidate: "python-shim" };
    expect(pythonOverrideStatus("c:\\python\\PYTHON.exe", alias)).toBe("using");
    expect(pythonOverrideStatus("C:\\Missing\\python.exe", alias)).toBe(
      "fallback",
    );
    expect(en.components.profile.integrated["Python-status-using"]).toContain(
      "runs {{executable}}",
    );
  });

  it("renders transient failures as unverified in both profile rows", () => {
    const transient = { ...found, status: "missing" as const, transient: true };
    expect(pythonOverrideStatus("python-shim", transient)).toBe("unverified");
    expect(windowsConPtyStatus(transient, "python-shim")).toBe("unverified");
    expect(en.components.profile.integrated["Python-status-unverified"]).toBe(
      "'{{value}}' could not be verified on this device.",
    );
    expect(
      en.components.profile.integrated["win32-backend-status-unverified"],
    ).toContain("could not be verified on this device");
  });

  it("shows a failed override and no usable Python when discovery fails", () => {
    expect(
      pythonOverrideStatus("python.exe", { ...found, status: "missing" }),
    ).toBe("missing");
    expect(en.components.profile.integrated["Python-status-missing"]).toContain(
      "no usable Python found",
    );
  });

  it("shows backend availability from the opener's host and breaker predicate", () => {
    const effective = "python";
    expect(windowsConPtyStatus(null, effective, effective)).toBe("checking");
    expect(windowsConPtyStatus(found, effective, effective)).toBe("available");
    expect(
      windowsConPtyStatus(
        { ...found, hostExecutable: null },
        effective,
        effective,
      ),
    ).toBe("unconfirmed");
    invalidateConPtyRuntime(effective, effective);
    expect(windowsConPtyStatus(found, effective, effective)).toBe(
      "runtime-unavailable",
    );
    expect(
      en.components.profile.integrated[
        "win32-backend-status-runtime-unavailable"
      ],
    ).toContain("terminals use ConHost");
  });
});
