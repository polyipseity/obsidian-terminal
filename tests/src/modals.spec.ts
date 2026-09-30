import { ProfileModal } from "../../src/modals.js";
import { Settings } from "../../src/settings-data.js";
import { PROFILE_PRESETS } from "../../src/terminal/profile-presets.js";
import {
  capturePythonRows,
  pythonSettingsContext,
  typePythonValue,
  withPythonSpare,
} from "../fixtures/python-settings-ui.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../assets/locales/en/translation.json" with { type: "json" };
import {
  type Win32PythonDiagnosis,
  type Win32PythonSpawn,
  clearWindowsPythonDiagnoses,
  invalidateConPtyRuntime,
  pythonOverrideStatus,
  windowsConPtyStatus,
  checkWindowsPython,
  checkWindowsResizerPackages,
  win32PythonConfigurationKey,
} from "../../src/terminal/win32-doctor.js";

const found: Win32PythonDiagnosis = {
  candidate: "C:\\Python\\python.exe",
  detail: "",
  executable: "C:\\Python\\python.exe",
  hostExecutable: "C:\\Python\\python.exe",
  status: "ok",
  tried: ["C:\\Python\\python.exe"],
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

const { displayed, execFile } = vi.hoisted(() => ({
  displayed: new Map<string, Win32PythonDiagnosis>(),
  execFile: vi.fn().mockResolvedValue({ stdout: "Python 3.12.0", stderr: "" }),
}));
vi.mock("@polyipseity/obsidian-plugin-library", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@polyipseity/obsidian-plugin-library")
    >();
  return {
    ...actual,
    Platform: { ...actual.Platform, CURRENT: "win32" },
    notice2: vi.fn(),
    dynamicRequire: (...args: Parameters<typeof actual.dynamicRequire>) =>
      args[1] === "node:util"
        ? Promise.resolve({ promisify: vi.fn().mockReturnValue(execFile) })
        : actual.dynamicRequire(...args),
  };
});
vi.mock("../../src/terminal/environment.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/terminal/environment.js")
  >()),
  applyEnv: vi.fn().mockResolvedValue({}),
}));
vi.mock("../../src/terminal/win32-doctor.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/terminal/win32-doctor.js")
  >()),
  checkWindowsPython: vi.fn(),
  checkWindowsResizerPackages: vi.fn().mockResolvedValue(true),
  getWindowsPythonDiagnosis: (value: string, fallback: string) =>
    displayed.get(win32PythonConfigurationKey(value, fallback)) ?? null,
}));

class PythonProfileModal extends ProfileModal {
  public renderPython(): void {
    this.setupTypedUI(this.ui, this.contentEl);
  }
  public update(): void {
    this.ui.update();
  }
  public async setWindowsEnabled(enabled: boolean): Promise<void> {
    if (this.data.type !== "integrated")
      throw new Error("Expected integrated profile");
    // Use the same mutation and update path as the platform toggle.
    this.data.platforms.win32 = enabled;
    await this.postMutate();
  }
  public get profile(): Settings.Profile {
    return this.data;
  }
}

const windowsProfile = {
  ...Settings.Profile.DEFAULTS.integrated,
  platforms: { ...Settings.Profile.DEFAULTS.integrated.platforms, win32: true },
} satisfies Settings.Profile;

describe("profile Python automatic checks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    displayed.clear();
    vi.mocked(checkWindowsPython).mockImplementation(async (context, value) => {
      displayed.set(
        win32PythonConfigurationKey(
          value,
          context.settings.value.pythonExecutable,
        ),
        found,
      );
      return found;
    });
    vi.spyOn(self.console, "log").mockImplementation(vi.fn());
  });
  afterEach(() => {
    clearWindowsPythonDiagnoses();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("reaps existing spares before explicit Windows Check starts", async () => {
    const rows = capturePythonRows(),
      context = await pythonSettingsContext({ pythonExecutable: "python" }),
      modal = new PythonProfileModal(context, windowsProfile, vi.fn());
    try {
      modal.renderPython();
      await withPythonSpare("old-python", async ({ host, control }) => {
        const reapedAtCheck = vi.fn(() => host.killed);
        vi.mocked(checkWindowsPython).mockImplementationOnce(async () => {
          reapedAtCheck();
          return found;
        });
        rows
          .get("components.profile.integrated.Python-executable")
          ?.buttons[0]?.buttonEl.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(reapedAtCheck).toHaveReturnedWith(true);
        await expect(control.ready).rejects.toMatchObject({
          reason: "aborted",
        });
      });
    } finally {
      modal.onClose();
    }
  });

  it.each([
    ["linuxIntegratedDefault", "conpty"],
    ["linuxIntegratedDefault", "legacy"],
    ["darwinIntegratedDefault", "conpty"],
    ["darwinIntegratedDefault", "legacy"],
  ] satisfies readonly (readonly [
    "linuxIntegratedDefault" | "darwinIntegratedDefault",
    "conpty" | "legacy",
  ])[])(
    "keeps %s with %s free of Windows diagnostics but permits generic Check",
    async (preset, win32Backend) => {
      const rows = capturePythonRows(),
        context = await pythonSettingsContext(),
        modal = new PythonProfileModal(
          context,
          {
            ...PROFILE_PRESETS[preset],
            win32Backend,
          },
          vi.fn(),
        );
      modal.renderPython();
      const row = rows.get("components.profile.integrated.Python-executable"),
        backend = rows.get("components.profile.integrated.win32-backend"),
        packages = rows.get("components.profile.integrated.resizer-packages");
      row?.texts[0]?.inputEl.dispatchEvent(new Event("change"));
      row?.texts[0]?.inputEl.dispatchEvent(new Event("blur"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(checkWindowsPython).not.toHaveBeenCalled();
      expect(checkWindowsResizerPackages).not.toHaveBeenCalled();
      expect(row?.descEl.textContent).toBe(
        "components.profile.integrated.Python-executable-description",
      );
      expect(backend?.descEl.textContent).toBe(
        "components.profile.integrated.win32-backend-description",
      );
      expect(packages?.settingEl.style.display).toBe("none");
      row?.buttons[0]?.buttonEl.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(execFile).toHaveBeenCalledExactlyOnceWith(
        "python3",
        ["--version"],
        expect.objectContaining({ windowsHide: true }),
      );
      expect(checkWindowsPython).not.toHaveBeenCalled();
      expect(checkWindowsResizerPackages).not.toHaveBeenCalled();
      expect(row?.descEl.textContent).toBe(
        "components.profile.integrated.Python-executable-description",
      );
      expect(backend?.descEl.textContent).toBe(
        "components.profile.integrated.win32-backend-description",
      );
      expect(packages?.settingEl.style.display).toBe("none");
      modal.onClose();
    },
  );

  it.each(["change", "check"])(
    "allows %s after enabling Windows and hides diagnostics when disabled again",
    async (trigger) => {
      vi.mocked(checkWindowsResizerPackages)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);
      const rows = capturePythonRows(),
        context = await pythonSettingsContext(),
        modal = new PythonProfileModal(
          context,
          {
            ...PROFILE_PRESETS.linuxIntegratedDefault,
            win32Backend: "legacy",
          },
          vi.fn(),
        );
      modal.renderPython();
      const row = rows.get("components.profile.integrated.Python-executable"),
        backend = rows.get("components.profile.integrated.win32-backend"),
        packages = rows.get("components.profile.integrated.resizer-packages");
      // Repeat with an unchanged executable to exercise commit deduplication.
      for (const count of [1, 2]) {
        await modal.setWindowsEnabled(true);
        expect(checkWindowsPython).toHaveBeenCalledTimes(count - 1);
        if (trigger === "change")
          row?.texts[0]?.inputEl.dispatchEvent(new Event("change"));
        else row?.buttons[0]?.buttonEl.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(checkWindowsPython).toHaveBeenCalledTimes(count);
        expect(row?.descEl.textContent).toContain("Python-status-");
        expect(backend?.descEl.textContent).toContain("win32-backend-status-");
        expect(packages?.settingEl.style.display).toBe("");
        await modal.setWindowsEnabled(false);
        expect(row?.descEl.textContent).toBe(
          "components.profile.integrated.Python-executable-description",
        );
        expect(backend?.descEl.textContent).toBe(
          "components.profile.integrated.win32-backend-description",
        );
        expect(packages?.settingEl.style.display).toBe("none");
        expect(rows.get("components.profile.integrated.resizer-packages")).toBe(
          packages,
        );
      }
      modal.onClose();
    },
  );

  it.each([
    ["/opt/python3", "python"],
    ["//server/share/python.exe", "python"],
    ["\\tools\\python.exe", "python"],
    ["\\\\server\\share\\python.exe", "python"],
    ["bin/python", "python"],
    ["C:python.exe", "python"],
    ["C:\\Python\\python.exe", "/opt/python3"],
    ["", "/opt/python3"],
  ])(
    "skips automatic checks for override %j and plugin %j but permits Check",
    async (override, plugin) => {
      const rows = capturePythonRows(),
        context = await pythonSettingsContext({ pythonExecutable: plugin }),
        profile = {
          ...windowsProfile,
          pythonExecutable: override,
          win32Backend: "legacy",
        } satisfies Settings.Profile,
        modal = new PythonProfileModal(context, profile, vi.fn());
      modal.renderPython();
      const pythonRow = rows.get(
        "components.profile.integrated.Python-executable",
      );
      expect(pythonRow?.descEl.textContent).toContain(
        "components.profile.integrated.Python-status-not-automatic",
      );
      if (override.startsWith("/opt/")) {
        expect(pythonRow?.descEl.textContent).toContain(
          "notices.win32-python-posix-path",
        );
      }
      pythonRow?.texts[0]?.inputEl.dispatchEvent(new Event("change"));
      pythonRow?.texts[0]?.inputEl.dispatchEvent(new Event("blur"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(checkWindowsPython).not.toHaveBeenCalled();
      expect(checkWindowsResizerPackages).not.toHaveBeenCalled();
      expect(
        rows.get("components.profile.integrated.resizer-packages")?.settingEl
          .style.display,
      ).toBe("none");
      pythonRow?.buttons
        .find(
          (button) =>
            button.buttonEl.title ===
            "components.profile.integrated.Python-executable-check",
        )
        ?.buttonEl.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(checkWindowsPython).toHaveBeenCalledExactlyOnceWith(
        context,
        override || plugin,
      );
      expect(execFile).toHaveBeenCalled();
      expect(pythonRow?.descEl.textContent).not.toContain(
        "components.profile.integrated.Python-status-not-automatic",
      );
      if (override.startsWith("/opt/")) {
        expect(pythonRow?.descEl.textContent).toContain(
          "notices.win32-python-posix-path",
        );
      }
      if (override.startsWith("//")) {
        expect(pythonRow?.descEl.textContent).not.toContain(
          "notices.win32-python-posix-path",
        );
      }
      expect(modal.profile).toHaveProperty("pythonExecutable", override);
      expect(context.settings.value.pythonExecutable).toBe(plugin);
      modal.onClose();
    },
  );

  it("explains skipped ConPTY availability without a fabricated failure", async () => {
    const rows = capturePythonRows(),
      context = await pythonSettingsContext(),
      modal = new PythonProfileModal(
        context,
        {
          ...windowsProfile,
          pythonExecutable: "/opt/python3",
        },
        vi.fn(),
      );
    modal.renderPython();
    const backend = rows.get("components.profile.integrated.win32-backend");
    expect(backend?.descEl.textContent).toContain(
      "components.profile.integrated.Python-status-not-automatic",
    );
    expect(backend?.descEl.textContent).not.toContain(
      "win32-backend-status-checking",
    );
    modal.onClose();
  });

  it.each(["", "python", "C:\\Python\\python.exe", "C:/Python/python.exe"])(
    "checks committed %j once after silent typing and rerenders",
    async (override) => {
      const rows = capturePythonRows();
      const context = await pythonSettingsContext({
          pythonExecutable: "python",
        }),
        modal = new PythonProfileModal(
          context,
          {
            ...windowsProfile,
            pythonExecutable: override,
            win32Backend: "legacy",
          },
          vi.fn(),
        );
      modal.renderPython();
      modal.update();
      const input = typePythonValue(
        rows.get("components.profile.integrated.Python-executable")?.texts[0],
        override,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(checkWindowsPython).not.toHaveBeenCalled();
      expect(checkWindowsResizerPackages).not.toHaveBeenCalled();
      input.dispatchEvent(new Event("change"));
      input.dispatchEvent(new Event("blur"));
      await vi.advanceTimersByTimeAsync(0);
      expect(checkWindowsPython).toHaveBeenCalledExactlyOnceWith(
        context,
        override || "python",
      );
      expect(checkWindowsResizerPackages).toHaveBeenCalledExactlyOnceWith(
        found.executable,
      );
      modal.onClose();
    },
  );

  it("reads the latest fallback on commit", async () => {
    const rows = capturePythonRows();
    const context = await pythonSettingsContext({ pythonExecutable: "python" }),
      modal = new PythonProfileModal(
        context,
        {
          ...windowsProfile,
          pythonExecutable: "C:\\Python\\python.exe",
          win32Backend: "legacy",
        },
        vi.fn(),
      );
    modal.renderPython();
    await context.settings.mutate((settings) => {
      settings.pythonExecutable = "/opt/python3";
    });
    rows
      .get("components.profile.integrated.Python-executable")
      ?.texts[0]?.inputEl.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(checkWindowsPython).not.toHaveBeenCalled();
    expect(checkWindowsResizerPackages).not.toHaveBeenCalled();
    modal.onClose();
  });
  it.each([
    ["blur", "edit"],
    ["blur", "fallback"],
    ["blur", "backend"],
    ["blur", "close"],
    ["blur", "disable Windows"],
    ["blur", "toggle Windows off/on"],
    ["check", "edit"],
    ["check", "close"],
    ["check", "disable Windows"],
    ["check", "toggle Windows off/on"],
  ])("stops a pending %s identity check after %s", async (trigger, action) => {
    const pending = Promise.withResolvers<Win32PythonDiagnosis>();
    vi.mocked(checkWindowsPython).mockReturnValueOnce(pending.promise);
    const rows = capturePythonRows(),
      context = await pythonSettingsContext({ pythonExecutable: "python" }),
      modal = new PythonProfileModal(
        context,
        { ...windowsProfile, win32Backend: "legacy" },
        vi.fn(),
      );
    modal.renderPython();
    const row = rows.get("components.profile.integrated.Python-executable");
    const input = typePythonValue(row?.texts[0], "python-old");
    if (trigger === "blur") input.dispatchEvent(new Event("blur"));
    else row?.buttons[0]?.buttonEl.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(checkWindowsPython).toHaveBeenCalledTimes(1);
    if (action === "edit") typePythonValue(row?.texts[0], "python-new");
    else if (action === "fallback")
      await context.settings.mutate((settings) => {
        settings.pythonExecutable = "python-new";
      });
    else if (action === "backend") {
      if (modal.profile.type === "integrated")
        Object.assign(modal.profile, { win32Backend: "conpty" });
    } else if (
      action === "disable Windows" ||
      action === "toggle Windows off/on"
    ) {
      await modal.setWindowsEnabled(false);
      expect(row?.descEl.textContent).not.toContain("Python-status-");
      expect(
        rows.get("components.profile.integrated.win32-backend")?.descEl
          .textContent,
      ).not.toContain("win32-backend-status-");
      if (action === "toggle Windows off/on")
        await modal.setWindowsEnabled(true);
    } else modal.onClose();
    if (action !== "close") modal.update();
    const before = row?.descEl.textContent;
    pending.resolve(found);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(checkWindowsResizerPackages).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(row?.descEl.textContent).toBe(before);
    modal.onClose();
    input.dispatchEvent(new Event("change"));
    expect(checkWindowsPython).toHaveBeenCalledTimes(1);
  });

  it.each(["edit", "close", "disable Windows"])(
    "discards a late package result after %s",
    async (action) => {
      const pending = Promise.withResolvers<boolean>();
      vi.mocked(checkWindowsResizerPackages).mockReturnValueOnce(
        pending.promise,
      );
      const rows = capturePythonRows(),
        context = await pythonSettingsContext({ pythonExecutable: "python" }),
        modal = new PythonProfileModal(
          context,
          { ...windowsProfile, win32Backend: "legacy" },
          vi.fn(),
        );
      modal.renderPython();
      const row = rows.get("components.profile.integrated.Python-executable");
      typePythonValue(row?.texts[0], "python-old").dispatchEvent(
        new Event("change"),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(checkWindowsResizerPackages).toHaveBeenCalledTimes(1);
      if (action === "edit") {
        typePythonValue(row?.texts[0], "python-new");
        await vi.advanceTimersByTimeAsync(0);
        expect(row?.descEl.textContent).toContain("Python-status-unverified");
      } else if (action === "disable Windows") {
        await modal.setWindowsEnabled(false);
      } else modal.onClose();
      pending.resolve(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        rows.get("components.profile.integrated.resizer-packages")?.settingEl
          .style.display,
      ).toBe("none");
      expect(checkWindowsPython).toHaveBeenCalledTimes(1);
      modal.onClose();
    },
  );
  it.each(["no commit", "pending blur", "completed change"])(
    "shows missing resizer packages after explicit Check with %s",
    async (commit) => {
      vi.mocked(checkWindowsResizerPackages).mockResolvedValueOnce(false);
      const rows = capturePythonRows(),
        context = await pythonSettingsContext({ pythonExecutable: "python" }),
        modal = new PythonProfileModal(
          context,
          { ...windowsProfile, win32Backend: "legacy" },
          vi.fn(),
        );
      modal.renderPython();
      const row = rows.get("components.profile.integrated.Python-executable"),
        packages = rows.get("components.profile.integrated.resizer-packages");
      expect(packages?.settingEl.style.display).toBe("none");
      expect(checkWindowsResizerPackages).not.toHaveBeenCalled();
      if (commit === "pending blur") {
        row?.texts[0]?.inputEl.dispatchEvent(new Event("blur"));
      } else if (commit === "completed change") {
        row?.texts[0]?.inputEl.dispatchEvent(new Event("change"));
        await vi.advanceTimersByTimeAsync(0);
        expect(packages?.settingEl.style.display).toBe("");
        vi.mocked(checkWindowsResizerPackages).mockResolvedValueOnce(false);
      }
      row?.buttons[0]?.buttonEl.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(packages?.settingEl.style.display).toBe("");
      expect(checkWindowsResizerPackages).toHaveBeenCalledTimes(
        commit === "completed change" ? 2 : 1,
      );
      expect(checkWindowsResizerPackages).toHaveBeenLastCalledWith(
        found.executable,
      );
      modal.onClose();
    },
  );

  it.each(["", "C:\\Profile\\python.exe"])(
    "explicit Check bypasses a cached failure for override %j",
    async (override) => {
      // Route the existing production-handler fixture through the real cache.
      const { checkWindowsPython: checkPython } = await vi.importActual<
          typeof import("../../src/terminal/win32-doctor.js")
        >("../../src/terminal/win32-doctor.js"),
        rows = capturePythonRows(),
        context = await pythonSettingsContext({
          pythonExecutable: "C:\\Plugin\\python.exe",
        }),
        effective = override || context.settings.value.pythonExecutable,
        probe = vi.fn<Win32PythonSpawn>().mockResolvedValue({
          code: null,
          errno: "ENOENT",
          stdout: "",
          stderr: "",
        }),
        locate = vi.fn().mockResolvedValue(null);
      vi.spyOn(console, "warn").mockImplementation(vi.fn());
      expect(
        (await checkPython(context, effective, probe, { locate })).status,
      ).toBe("missing");
      probe.mockClear().mockResolvedValue({
        code: 0,
        stdout: `${effective}\n3.12.0\n`,
        stderr: "",
      });
      vi.mocked(checkWindowsPython).mockImplementation((context0, value) =>
        checkPython(context0, value, probe, { locate }),
      );
      const modal = new PythonProfileModal(
        context,
        { ...windowsProfile, pythonExecutable: override },
        vi.fn(),
      );
      modal.renderPython();
      rows
        .get("components.profile.integrated.Python-executable")
        ?.buttons[0]?.buttonEl.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(execFile).toHaveBeenCalledExactlyOnceWith(
        effective,
        ["--version"],
        expect.objectContaining({ windowsHide: true }),
      );
      modal.onClose();
    },
  );

  it.each(["", found.executable])(
    "shows checking over a retained diagnosis for override %j until Check settles",
    async (override) => {
      const pending = Promise.withResolvers<Win32PythonDiagnosis>(),
        rows = capturePythonRows(),
        context = await pythonSettingsContext({ pythonExecutable: "python" }),
        key = win32PythonConfigurationKey(override || "python", "python"),
        modal = new PythonProfileModal(
          context,
          {
            ...windowsProfile,
            pythonExecutable: override,
            win32Backend: "conpty",
          },
          vi.fn(),
        );
      displayed.set(key, found);
      vi.mocked(checkWindowsPython).mockImplementationOnce(async () => {
        const diagnosis = await pending.promise;
        displayed.set(key, diagnosis);
        return diagnosis;
      });
      try {
        modal.renderPython();
        const row = rows.get("components.profile.integrated.Python-executable"),
          backend = rows.get("components.profile.integrated.win32-backend"),
          pythonDescription =
            "components.profile.integrated.Python-executable-description",
          backendDescription =
            "components.profile.integrated.win32-backend-description";
        expect(row?.descEl.textContent).toContain(
          `Python-status-${override ? "using" : "inherited-ok"}`,
        );
        expect(backend?.descEl.textContent).toContain(
          "win32-backend-status-available",
        );

        row?.buttons[0]?.buttonEl.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(checkWindowsPython).toHaveBeenCalledTimes(1);
        expect(row?.descEl.textContent).toBe(
          `${pythonDescription} components.profile.integrated.Python-status-checking`,
        );
        expect(backend?.descEl.textContent).toBe(
          `${backendDescription} components.profile.integrated.win32-backend-status-checking`,
        );

        pending.resolve({ ...found, status: "missing", hostExecutable: null });
        await vi.advanceTimersByTimeAsync(0);
        expect(row?.descEl.textContent).toBe(
          `${pythonDescription} components.profile.integrated.Python-status-${override ? "missing" : "inherited-missing"}`,
        );
        expect(backend?.descEl.textContent).toBe(
          `${backendDescription} components.profile.integrated.win32-backend-status-missing`,
        );
      } finally {
        modal.onClose();
      }
    },
  );

  it("runs explicit Check even while the field's blur check is pending", async () => {
    const pending = Promise.withResolvers<Win32PythonDiagnosis>();
    vi.mocked(checkWindowsPython).mockReturnValueOnce(pending.promise);
    const rows = capturePythonRows(),
      context = await pythonSettingsContext(),
      modal = new PythonProfileModal(context, windowsProfile, vi.fn());
    modal.renderPython();
    const row = rows.get("components.profile.integrated.Python-executable");
    typePythonValue(row?.texts[0], "python").dispatchEvent(new Event("blur"));
    row?.buttons[0]?.buttonEl.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(checkWindowsPython).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      found.executable,
      ["--version"],
      expect.objectContaining({ windowsHide: true }),
    );
    pending.resolve(found);
    await vi.advanceTimersByTimeAsync(0);
    expect(checkWindowsResizerPackages).not.toHaveBeenCalled();
    modal.onClose();
  });
});
