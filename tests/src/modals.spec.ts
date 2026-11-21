import {
  KeymappingEditModal,
  ProfileModal,
  TerminalOptionsModal,
} from "../../src/modals.js";
import * as doctor from "../../src/terminal/win32-doctor.js";
import { Keymap, Scope } from "../mocks/obsidian.js";
import { Settings } from "../../src/settings-data.js";
import { DropdownComponent, Setting } from "obsidian";
import { UpdatableUI } from "@polyipseity/obsidian-plugin-library";
import {
  DEFAULT_TERMINAL_OPTIONS,
  PROFILE_PRESETS,
} from "../../src/terminal/profile-presets.js";
import {
  capturePythonRows,
  pythonSettingsContext,
  typePythonValue,
  withPythonSpare,
} from "../fixtures/python-settings-ui.js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
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

const { displayed, execFile, platform } = vi.hoisted(() => ({
  displayed: new Map<string, Win32PythonDiagnosis>(),
  execFile: vi.fn().mockResolvedValue({ stdout: "Python 3.12.0", stderr: "" }),
  // The device platform. Tests that change it restore "win32" afterwards.
  platform: { current: "win32" },
}));
vi.mock("@polyipseity/obsidian-plugin-library", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@polyipseity/obsidian-plugin-library")
    >();
  return {
    ...actual,
    Platform: {
      ...actual.Platform,
      get CURRENT() {
        return platform.current;
      },
    },
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

describe("profile editor Windows-only rows", () => {
  const pythonRow = "components.profile.integrated.Python-executable",
    backendRow = "components.profile.integrated.win32-backend",
    resizerRow = "components.profile.integrated.resizer-packages",
    // A profile synced from a Windows device: enabled there, ConHost chosen.
    syncedProfile = {
      ...windowsProfile,
      platforms: { darwin: true, linux: true, win32: true },
      win32Backend: "legacy",
    } satisfies Settings.Profile;

  afterEach(() => {
    platform.current = "win32";
    vi.restoreAllMocks();
  });

  it.each(["darwin", "linux"])(
    "omits the Windows terminal backend and resizer rows on %s",
    async (current) => {
      platform.current = current;
      const rows = capturePythonRows(),
        modal = new PythonProfileModal(
          await pythonSettingsContext(),
          syncedProfile,
          vi.fn(),
        );
      modal.renderPython();
      expect(rows.has(pythonRow)).toBe(true);
      expect(rows.has(backendRow)).toBe(false);
      expect(rows.has(resizerRow)).toBe(false);
      // The i18n stub returns keys, so no row may carry a Windows backend key.
      for (const row of rows.values()) {
        expect(row.descEl.textContent).not.toMatch(/win32-backend|resizer/u);
      }
      modal.onClose();
    },
  );

  it("keeps the Windows terminal backend and resizer rows on win32", async () => {
    platform.current = "win32";
    const rows = capturePythonRows(),
      modal = new PythonProfileModal(
        await pythonSettingsContext(),
        syncedProfile,
        vi.fn(),
      );
    modal.renderPython();
    expect(rows.has(pythonRow)).toBe(true);
    expect(rows.get(backendRow)?.descEl.textContent).toBe(
      "components.profile.integrated.win32-backend-description components.profile.integrated.win32-backend-status-legacy",
    );
    expect(rows.get(resizerRow)?.settingEl.style.display).toBe("none");
    modal.onClose();
  });

  it.each(["darwin", "linux"])(
    "keeps a stored ConHost choice through an edit on %s",
    async (current) => {
      platform.current = current;
      const rows = capturePythonRows(),
        saved = vi.fn<(profile: Settings.Profile) => void>(),
        modal = new PythonProfileModal(
          await pythonSettingsContext(),
          syncedProfile,
          saved,
        );
      modal.renderPython();
      typePythonValue(rows.get(pythonRow)?.texts[0], "python3.12");
      await vi.waitFor(() => {
        expect(saved).toHaveBeenCalled();
      });
      const stored = saved.mock.lastCall?.[0];
      expect(stored).toMatchObject({
        pythonExecutable: "python3.12",
        win32Backend: "legacy",
      });
      // The settings fixer must keep the value as well.
      expect(Settings.Profile.fix(stored).value).toMatchObject({
        win32Backend: "legacy",
      });
      expect(modal.profile).toHaveProperty("win32Backend", "legacy");
      modal.onClose();
    },
  );
});

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

  it.each(["", "other-python"])(
    "uses plugin pending state for inherited Python, with override %j",
    async (override) => {
      const rows = capturePythonRows(),
        context = await pythonSettingsContext({ pythonExecutable: "python" }),
        pending = vi
          .spyOn(doctor, "isPluginPythonCheckPending")
          .mockImplementation(
            (context0, configured) =>
              context0 === context && configured === "python",
          ),
        notification = vi.spyOn(doctor, "onPluginPythonDiagnosis"),
        modal = new PythonProfileModal(
          context,
          {
            ...windowsProfile,
            pythonExecutable: override,
            win32Backend: "conpty",
          },
          vi.fn(),
        );
      try {
        modal.renderPython();
        const row = rows.get("components.profile.integrated.Python-executable"),
          backend = rows.get("components.profile.integrated.win32-backend");
        expect(row?.descEl.textContent).toContain(
          `Python-status-${override ? "unverified" : "checking"}`,
        );
        expect(backend?.descEl.textContent).toContain(
          `win32-backend-status-${override ? "unverified" : "checking"}`,
        );
        const notify = notification.mock.calls[0]?.[1];
        if (!notify) throw new Error("Missing plugin diagnosis subscription");
        pending.mockReturnValue(false);
        notify();
        expect(row?.descEl.textContent).toContain(
          `Python-status-${override ? "unverified" : "inherited-unverified"}`,
        );
        expect(backend?.descEl.textContent).toContain(
          "win32-backend-status-unverified",
        );
      } finally {
        modal.onClose();
      }
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

describe("terminal options font family", () => {
  const cssList = "'0xProto Nerd Font Mono', monospace";

  async function openTerminalOptions(): Promise<{
    readonly field: HTMLInputElement;
    readonly json: HTMLTextAreaElement;
    readonly description: string | undefined;
    readonly inNameColumn: string;
  }> {
    const rows = capturePythonRows(),
      modal = new TerminalOptionsModal(
        await pythonSettingsContext(),
        DEFAULT_TERMINAL_OPTIONS,
      );
    modal.open();
    onTestFinished(() => {
      modal.close();
    });
    const font = rows.get("components.terminal-options.font-family"),
      field = font?.texts[0]?.inputEl,
      json = rows.get("components.edit-data.data")?.textAreas[0]?.inputEl;
    if (!field || !json) throw new Error("terminal options rows missing");
    return {
      // The line right under the row, as wide as the dialog.
      description: font.settingEl.nextElementSibling?.textContent,
      field,
      inNameColumn: font.descEl.textContent,
      json,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("describes the value as a CSS font-family list with a quoted example", async () => {
    const { description } = await openTerminalOptions();

    expect(description).toBe(
      "components.terminal-options.font-family-description",
    );
    expect(
      en.components["terminal-options"]["font-family-description"],
    ).toMatch(/CSS font-family list.*'0xProto Nerd Font Mono', monospace/u);
  });

  it("keeps the description out of the row's narrow name column", async () => {
    const { inNameColumn } = await openTerminalOptions();

    expect(inNameColumn).toBe("");
  });

  it("writes a quoted family with a fallback to the raw JSON unchanged", async () => {
    const { field, json } = await openTerminalOptions();

    field.value = cssList;
    field.dispatchEvent(new Event("input"));

    await vi.waitFor(() => {
      expect(JSON.parse(json.value)).toMatchObject({ fontFamily: cssList });
    });
  });

  it("reads a quoted family with a fallback from the raw JSON unchanged", async () => {
    const { field, json } = await openTerminalOptions();

    json.value = `{ "documentOverride": null, "fontFamily": "${cssList}" }`;
    json.dispatchEvent(new Event("input"));

    await vi.waitFor(() => {
      expect(field.value).toBe(cssList);
    });
  });
});

describe("terminal options font size", () => {
  // Chromium's two readings of an unfinished number in a number field: on
  // macOS and Windows `14.` reads as "" with bad input, on Ubuntu as "14".
  const PLATFORMS = ["macOS/Windows", "Ubuntu"] as const;

  async function openFontSize(platform: (typeof PLATFORMS)[number]) {
    const rows = capturePythonRows(),
      modal = new TerminalOptionsModal(await pythonSettingsContext(), {
        ...DEFAULT_TERMINAL_OPTIONS,
        fontSize: 14,
      });
    modal.open();
    onTestFinished(() => {
      modal.close();
    });
    const field = rows.get("components.terminal-options.font-size")?.texts[0]
        ?.inputEl,
      json = rows.get("components.edit-data.data")?.textAreas[0]?.inputEl;
    if (!field || !json) throw new Error("terminal options rows missing");
    const writes: string[] = [];
    let text = field.value;
    const reported = (): { readonly badInput: boolean; value: string } => {
      if (text === "" || /^-?(?:\d+|\d*\.\d+)$/u.test(text)) {
        return { badInput: false, value: text };
      }
      if (platform === "Ubuntu" && /^-?\d+\.$/u.test(text)) {
        return { badInput: false, value: text.slice(0, -1) };
      }
      return { badInput: true, value: "" };
    };
    Object.defineProperty(field, "value", {
      configurable: true,
      get: () => reported().value,
      set: (value: string) => {
        writes.push(value);
        text = value;
      },
    });
    Object.defineProperty(field, "validity", {
      configurable: true,
      get: () => ({ badInput: reported().badInput }),
    });
    // In the document, so that it can take the focus.
    document.body.append(field);
    onTestFinished(() => {
      field.remove();
    });
    return {
      fontSize: (): unknown => Reflect.get(JSON.parse(json.value), "fontSize"),
      shown: (): string => text,
      async type(typed: string): Promise<void> {
        field.focus();
        text = typed;
        field.dispatchEvent(new Event("input"));
        // Each key is a task of its own: what it stores settles before the next.
        await new Promise((resolve) => {
          window.setTimeout(resolve, 0);
        });
      },
      inputType: field.type,
      writes,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(PLATFORMS)(
    "takes 14.5 typed after 14 on %s, and keeps the size while it reads 14.",
    async (platform) => {
      const font = await openFontSize(platform);
      expect(font.inputType).toBe("number");

      await font.type("14.");
      expect(font.fontSize()).toBe(14);
      await font.type("14.5");

      expect({
        fontSize: font.fontSize(),
        shown: font.shown(),
        writes: font.writes,
      }).toEqual({ fontSize: 14.5, shown: "14.5", writes: [] });
    },
  );
});

describe("keymapping editor key recorder", () => {
  // Obsidian's keymap listens on every window in the capture phase, so it sees
  // each key before any document listener and consumes keys its scopes handle.
  const keymap = new Keymap(),
    onKeyEvent = (evt: KeyboardEvent): void => {
      keymap.onKeyEvent(evt);
    },
    previous = {
      ...Settings.Keymapping.DEFAULT,
      ctrl: true,
      key: "k",
    } satisfies Settings.Keymapping;
  let runHotkey = vi.fn(),
    closeModal = vi.fn(),
    modalScope = new Scope();

  beforeEach(() => {
    // An Obsidian hotkey bound to every key, behind the open modal's scope,
    // whose Escape handler closes the modal.
    const appScope = new Scope();
    runHotkey = vi.fn().mockReturnValue(false);
    closeModal = vi.fn().mockReturnValue(false);
    modalScope = new Scope(appScope);
    appScope.register(null, null, runHotkey);
    modalScope.register([], "Escape", closeModal);
    keymap.pushScope(modalScope);
    self.addEventListener("keydown", onKeyEvent, true);
  });
  afterEach(() => {
    self.removeEventListener("keydown", onKeyEvent, true);
    for (const scope of keymap.getScopes()) {
      keymap.popScope(scope);
    }
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  async function openRecorder(): Promise<{
    readonly callback: ReturnType<typeof vi.fn>;
    readonly modal: KeymappingEditModal;
    readonly press: (init: KeyboardEventInit) => KeyboardEvent;
    readonly record: () => void;
    readonly recordDesc: () => string | null | undefined;
  }> {
    const rows = capturePythonRows(),
      context = await pythonSettingsContext(),
      callback = vi.fn(),
      modal = new KeymappingEditModal(context, previous, callback);
    document.body.append(modal.contentEl);
    modal.open();
    const row = (): ReturnType<typeof rows.get> =>
      rows.get("components.keymappings.record");
    return {
      callback,
      modal,
      press: (init) => {
        const evt = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ...init,
        });
        modal.contentEl.dispatchEvent(evt);
        return evt;
      },
      record: () => {
        row()?.buttons[0]?.buttonEl.click();
      },
      recordDesc: () => row()?.descEl.textContent,
    };
  }

  it("records a key bound to an Obsidian hotkey instead of running the hotkey", async () => {
    const { callback, modal, press, record, recordDesc } = await openRecorder();
    record();
    expect(modal.titleEl.textContent).toBe("components.keymappings.recording");
    expect(recordDesc()).toBe("components.keymappings.recording");
    const evt = press({ key: "p", metaKey: true });
    expect(runHotkey).not.toHaveBeenCalled();
    expect(evt.defaultPrevented).toBe(true);
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      ...previous,
      ctrl: false,
      key: "p",
      meta: true,
    });
    expect(modal.titleEl.textContent).toBe("Meta+p");
    expect(recordDesc()).toBe("Meta+p");
    expect(keymap.getScopes()).toEqual([modalScope]);
    modal.close();
  });

  it("keeps recording through modifier-only keydowns", async () => {
    const { callback, modal, press, record } = await openRecorder();
    record();
    press({ ctrlKey: true, key: "Control" });
    expect(callback).not.toHaveBeenCalled();
    expect(modal.titleEl.textContent).toBe("components.keymappings.recording");
    press({ ctrlKey: true, key: "j" });
    expect(runHotkey).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledExactlyOnceWith({ ...previous, key: "j" });
    modal.close();
  });

  it("cancels on a bare Escape, keeping the previous key and the modal open", async () => {
    const { callback, modal, press, record, recordDesc } = await openRecorder();
    record();
    const evt = press({ key: "Escape" });
    expect(closeModal).not.toHaveBeenCalled();
    expect(evt.defaultPrevented).toBe(true);
    expect(callback).not.toHaveBeenCalled();
    expect(modal.titleEl.textContent).toBe("Ctrl+k");
    expect(recordDesc()).toBe("Ctrl+k");
    expect(keymap.getScopes()).toEqual([modalScope]);
    modal.close();
  });

  it("records Escape pressed with a modifier", async () => {
    const { callback, modal, press, record } = await openRecorder();
    record();
    press({ key: "Escape", shiftKey: true });
    expect(closeModal).not.toHaveBeenCalled();
    expect(runHotkey).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      ...previous,
      ctrl: false,
      key: "Escape",
      shift: true,
    });
    expect(keymap.getScopes()).toEqual([modalScope]);
    modal.close();
  });

  it("returns keys to Obsidian when the record button is pressed again", async () => {
    const { callback, modal, press, record, recordDesc } = await openRecorder();
    record();
    expect(keymap.getScopes()).toHaveLength(2);
    record();
    expect(keymap.getScopes()).toEqual([modalScope]);
    expect(recordDesc()).toBe("Ctrl+k");
    press({ ctrlKey: true, key: "p" });
    expect(runHotkey).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
    modal.close();
  });

  it("returns keys to Obsidian when the modal closes while recording", async () => {
    const { callback, modal, press, record } = await openRecorder();
    record();
    expect(keymap.getScopes()).toHaveLength(2);
    modal.close();
    expect(keymap.getScopes()).toEqual([modalScope]);
    press({ ctrlKey: true, key: "p" });
    expect(runHotkey).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("keymapping editor argument", () => {
  const seeded = {
    ...Settings.Keymapping.DEFAULT,
    ctrl: true,
    key: "k",
  } satisfies Settings.Keymapping;
  let rows: ReturnType<typeof capturePythonRows> = new Map(),
    choices = new WeakMap<Setting, (value: string) => unknown>();

  beforeEach(() => {
    rows = capturePythonRows();
    choices = new WeakMap();
    const newSetting = vi.spyOn(UpdatableUI.prototype, "newSetting"),
      render = newSetting.getMockImplementation();
    if (!render) throw new Error("Settings rows not captured");
    // UpdatableUI takes the change handler off every control before it draws
    // a row again. The shared rows keep theirs, so a handler left from an
    // earlier draw would hide a field that no longer saves anything.
    newSetting.mockImplementation(function (
      this: UpdatableUI,
      element,
      configure,
    ) {
      return render.call(this, element, (setting) => {
        for (const row of rows.values()) {
          if (row !== setting) continue;
          for (const { inputEl } of [...row.texts, ...row.textAreas]) {
            inputEl.oninput = null;
          }
        }
        configure(setting);
      });
    });
    // As Obsidian's: setting the value is not a choice of the user's and
    // calls nothing. The shared mock's would, and the editor would loop.
    vi.spyOn(Setting.prototype, "addDropdown").mockImplementation(function (
      this: Setting,
      configure,
    ) {
      const dropdown = new DropdownComponent(this.settingEl);
      vi.spyOn(dropdown, "onChange").mockImplementation((callback) => {
        choices.set(this, callback);
        return dropdown;
      });
      configure(dropdown);
      return this;
    });
  });
  afterEach(() => {
    const keymap = new Keymap();
    for (const scope of keymap.getScopes()) {
      keymap.popScope(scope);
    }
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  function row(name: string): NonNullable<ReturnType<typeof rows.get>> {
    const found = rows.get(name);
    if (!found) throw new Error(`Row missing: ${name}`);
    return found;
  }

  async function openEditor(mapping: Settings.Keymapping): Promise<{
    readonly callback: ReturnType<
      typeof vi.fn<(value: Settings.Keymapping) => void>
    >;
    readonly modal: KeymappingEditModal;
    readonly saved: () => Settings.Keymapping | undefined;
    readonly choose: (name: string, value: string) => Promise<void>;
    readonly chooseAction: (action: Settings.KeymappingAction) => Promise<void>;
    readonly numberField: () => HTMLInputElement;
    readonly textField: () => HTMLTextAreaElement;
    readonly typeNumber: (value: string) => HTMLInputElement;
    readonly typeText: (value: string) => HTMLTextAreaElement;
  }> {
    const context = await pythonSettingsContext(),
      callback = vi.fn<(value: Settings.Keymapping) => void>(),
      modal = new KeymappingEditModal(context, mapping, callback);
    document.body.append(modal.contentEl);
    modal.open();
    // The argument row has no name.
    const numberField = (): HTMLInputElement => {
        const text = row("").texts[0];
        if (!text) throw new Error("Number field missing");
        return text.inputEl;
      },
      textField = (): HTMLTextAreaElement => {
        const area = row("").textAreas[0];
        if (!area) throw new Error("Text field missing");
        return area.inputEl;
      },
      choose = async (name: string, value: string): Promise<void> => {
        const chosen = choices.get(row(name));
        if (!chosen) throw new Error(`Dropdown missing: ${name}`);
        await chosen(value);
      };
    return {
      callback,
      choose,
      chooseAction: async (action) =>
        choose("components.keymappings.action", action),
      modal,
      numberField,
      saved: () => callback.mock.lastCall?.[0],
      textField,
      typeNumber: (value) => typePythonValue(row("").texts[0], value),
      typeText: (value) => {
        const area = textField();
        area.value = value;
        area.dispatchEvent(new Event("input"));
        return area;
      },
    };
  }

  it("saves text typed after a new mapping changes to Send text", async () => {
    const editor = await openEditor(seeded);
    await editor.chooseAction("sendText");
    editor.typeText("hello");
    expect(editor.saved()).toStrictEqual({
      ...seeded,
      action: "sendText",
      actionArg: "hello",
    });
    editor.modal.close();

    const saved = editor.saved();
    if (!saved) throw new Error("Nothing saved");
    const reopened = await openEditor(saved);
    expect(reopened.textField().value).toBe("hello");
    expect(reopened.textField().style.display).toBe("");
    reopened.modal.close();
  });

  it("saves text typed after Scroll lines changes to Send text", async () => {
    const editor = await openEditor({
      ...seeded,
      action: "scrollLines",
      actionArg: 5,
    });
    await editor.chooseAction("sendText");
    expect(editor.saved()).toMatchObject({ action: "sendText", actionArg: "" });
    editor.typeText("hello");
    expect(editor.saved()).toMatchObject({
      action: "sendText",
      actionArg: "hello",
    });
    editor.modal.close();
  });

  it("saves a number typed after Send text changes to Scroll lines", async () => {
    const editor = await openEditor({
      ...seeded,
      action: "sendText",
      actionArg: "abc",
    });
    await editor.chooseAction("scrollLines");
    expect(editor.saved()).toMatchObject({
      action: "scrollLines",
      actionArg: 1,
    });
    expect(editor.numberField().value).toBe("1");
    editor.typeNumber("5");
    expect(editor.saved()).toMatchObject({
      action: "scrollLines",
      actionArg: 5,
    });
    editor.modal.close();
  });

  it("drops the argument and hides its row when the new action takes none", async () => {
    const editor = await openEditor({
      ...seeded,
      action: "scrollLines",
      actionArg: 3,
    });
    await editor.chooseAction("ignore");
    expect(editor.saved()).toStrictEqual({
      ...seeded,
      action: "ignore",
      actionArg: null,
    });
    expect(row("").settingEl.style.display).toBe("none");
    editor.modal.close();
  });

  it("keeps the argument from every action to every other only when its kind stays", async () => {
    const seeds = { number: 3, string: "abc" } as const,
      defaults = { number: 1, string: "" } as const;
    for (const from of Settings.KEY_MAPPING_ACTIONS) {
      const fromType = Settings.ACTION_ARG_TYPES[from],
        start = Settings.Keymapping.fix({
          ...seeded,
          action: from,
          actionArg: fromType === null ? null : seeds[fromType],
        }).value;
      for (const to of Settings.KEY_MAPPING_ACTIONS) {
        // A dropdown reports no change when the same option is chosen.
        if (to === from) continue;
        const toType = Settings.ACTION_ARG_TYPES[to],
          editor = await openEditor(start);
        await editor.chooseAction(to);
        const saved = editor.saved(),
          fixed = Settings.Keymapping.fix(saved);
        expect(saved, `${from} -> ${to}`).toStrictEqual({
          ...start,
          action: to,
          actionArg:
            toType === null
              ? null
              : toType === fromType
                ? seeds[toType]
                : defaults[toType],
        });
        // Loading the settings again would report nothing to repair.
        expect(fixed.valid, `${from} -> ${to}`).toBe(true);
        expect(fixed.value, `${from} -> ${to}`).toStrictEqual(saved);
        editor.modal.close();
      }
    }
  });

  it("leaves only the shown field saving after the action changes back and forth", async () => {
    const editor = await openEditor({
      ...seeded,
      action: "scrollLines",
      actionArg: 3,
    });
    await editor.chooseAction("sendText");
    await editor.chooseAction("scrollLines");
    editor.callback.mockClear();
    editor.typeText("zzz");
    expect(editor.callback).not.toHaveBeenCalled();
    editor.typeNumber("7");
    expect(editor.saved()).toMatchObject({
      action: "scrollLines",
      actionArg: 7,
    });

    await editor.chooseAction("sendText");
    editor.callback.mockClear();
    editor.typeNumber("8");
    expect(editor.callback).not.toHaveBeenCalled();
    editor.typeText("hi");
    expect(editor.saved()).toMatchObject({
      action: "sendText",
      actionArg: "hi",
    });
    editor.modal.close();
  });

  it("keeps both a key recorded and the action chosen while recording", async () => {
    const editor = await openEditor(seeded);
    row("components.keymappings.record").buttons[0]?.buttonEl.click();
    await editor.chooseAction("sendText");
    new Keymap().onKeyEvent(
      new KeyboardEvent("keydown", { altKey: true, key: "j" }),
    );
    editor.typeText("hello");
    expect(editor.saved()).toStrictEqual({
      ...seeded,
      action: "sendText",
      actionArg: "hello",
      alt: true,
      ctrl: false,
      key: "j",
    });
    editor.modal.close();
  });

  it("keeps the new argument when the platform changes after the action", async () => {
    const editor = await openEditor(seeded);
    await editor.chooseAction("sendText");
    editor.typeText("hello");
    await editor.choose("components.keymappings.platform", "darwin");
    expect(editor.saved()).toStrictEqual({
      ...seeded,
      action: "sendText",
      actionArg: "hello",
      platform: "darwin",
    });
    editor.modal.close();
  });

  it("hands each save a copy that later edits do not change", async () => {
    const editor = await openEditor(seeded);
    await editor.chooseAction("scrollLines");
    const first = editor.saved();
    if (!first) throw new Error("Nothing saved");
    Object.assign(first, { actionArg: 99 });
    await editor.choose("components.keymappings.platform", "linux");
    expect(editor.saved()).toStrictEqual({
      ...seeded,
      action: "scrollLines",
      actionArg: 1,
      platform: "linux",
    });
    expect(first.actionArg).toBe(99);
    editor.modal.close();
  });

  it("takes an action it does not know as Ignore without an argument", async () => {
    const editor = await openEditor({
      ...seeded,
      action: "scrollLines",
      actionArg: 3,
    });
    // A value from a newer version, or none at all.
    await editor.choose("components.keymappings.action", "unknownAction");
    expect(editor.saved()).toStrictEqual({
      ...seeded,
      action: "ignore",
      actionArg: null,
    });
    expect(row("").settingEl.style.display).toBe("none");
    editor.modal.close();
  });

  it("edits a mapping 3.29.0 saved with the old argument once loaded", async () => {
    // What the 3.29.0 editor wrote to data.json after an action change.
    const stored = [
        { ...seeded, action: "sendText", actionArg: null },
        { ...seeded, action: "sendText", actionArg: 5 },
        { ...seeded, action: "scrollLines", actionArg: "abc" },
        { ...seeded, action: "ignore", actionArg: 3 },
      ],
      { keymappings } = Settings.fix({ keymappings: stored }).value;
    expect(keymappings).toStrictEqual([
      { ...seeded, action: "sendText", actionArg: "" },
      { ...seeded, action: "sendText", actionArg: "" },
      { ...seeded, action: "scrollLines", actionArg: 1 },
      { ...seeded, action: "ignore", actionArg: null },
    ]);
    for (const mapping of keymappings.slice(0, 2)) {
      const editor = await openEditor(mapping);
      editor.typeText("hello");
      expect(editor.saved()).toStrictEqual({ ...mapping, actionArg: "hello" });
      editor.modal.close();
    }
    const scroll = keymappings[2];
    if (!scroll) throw new Error("Mapping missing");
    const editor = await openEditor(scroll);
    expect(editor.numberField().value).toBe("1");
    editor.typeNumber("5");
    expect(editor.saved()).toStrictEqual({ ...scroll, actionArg: 5 });
    editor.modal.close();
  });

  it("saves typed text even when it opens on a mapping whose argument has the wrong kind", async () => {
    // Every caller in this release loads or fixes the mapping first. This
    // asks whether the editor itself still drops what is typed, as 3.29.0 did.
    const wrong: Settings.Keymapping = {
      ...seeded,
      action: "sendText",
      actionArg: "",
    };
    Reflect.set(wrong, "actionArg", 5);
    const editor = await openEditor(wrong);
    editor.typeText("hello");
    expect(editor.saved()).toMatchObject({
      action: "sendText",
      actionArg: "hello",
    });
    editor.modal.close();
  });

  it("keeps the argument while a held chord with modifiers is recorded", async () => {
    const editor = await openEditor({
      ...seeded,
      action: "scrollLines",
      actionArg: 3,
    });
    editor.typeNumber("7");
    row("components.keymappings.record").buttons[0]?.buttonEl.click();
    const keymap = new Keymap();
    keymap.onKeyEvent(
      new KeyboardEvent("keydown", { ctrlKey: true, key: "Control" }),
    );
    for (const repeat of [false, true, true]) {
      keymap.onKeyEvent(
        new KeyboardEvent("keydown", {
          ctrlKey: true,
          key: "K",
          repeat,
          shiftKey: true,
        }),
      );
    }
    expect(editor.saved()).toStrictEqual({
      ...seeded,
      action: "scrollLines",
      actionArg: 7,
      key: "K",
      shift: true,
    });
    expect(editor.numberField().value).toBe("7");
    editor.typeNumber("-4");
    expect(editor.saved()).toMatchObject({ actionArg: -4, key: "K" });
    editor.modal.close();
  });

  it("keeps the argument for every platform chosen after the action", async () => {
    const editor = await openEditor(seeded);
    await editor.chooseAction("sendHexCode");
    editor.typeText("1b 5b 41");
    for (const platform of Settings.KEY_MAPPING_PLATFORMS) {
      await editor.choose("components.keymappings.platform", platform ?? "");
      expect(editor.saved()).toStrictEqual({
        ...seeded,
        action: "sendHexCode",
        actionArg: "1b 5b 41",
        platform,
      });
    }
    editor.typeText("03");
    expect(editor.saved()).toMatchObject({ actionArg: "03" });
    editor.modal.close();
  });

  it("offers Send to Obsidian, which takes no argument", async () => {
    const offered = vi.spyOn(DropdownComponent.prototype, "addOption"),
      editor = await openEditor({
        ...seeded,
        action: "sendText",
        actionArg: "abc",
      });
    expect(offered).toHaveBeenCalledWith(
      "sendToObsidian",
      "components.keymappings.actions.sendToObsidian",
    );

    await editor.chooseAction("sendToObsidian");

    expect(editor.saved()).toStrictEqual({
      ...seeded,
      action: "sendToObsidian",
      actionArg: null,
    });
    expect(row("").settingEl.style.display).toBe("none");
    editor.modal.close();
  });

  describe("scroll amount while it is typed", () => {
    const scrollLines = {
      ...seeded,
      action: "scrollLines",
      actionArg: 3,
    } satisfies Settings.Keymapping;

    // A field being typed in has focus, which needs it in the document.
    function focus(field: HTMLInputElement): HTMLInputElement {
      row("").settingEl.append(field);
      field.focus();
      expect(document.activeElement).toBe(field);
      return field;
    }

    it("leaves an emptied field empty and shows the saved number once left", async () => {
      const editor = await openEditor(scrollLines),
        field = focus(editor.numberField());
      // Backspace over "3".
      editor.typeNumber("");
      expect(field.value).toBe("");
      expect(editor.callback).not.toHaveBeenCalled();
      field.blur();
      expect(field.value).toBe("3");
      expect(editor.callback).not.toHaveBeenCalled();
      editor.modal.close();
    });

    it("takes -2 typed over a selected -1", async () => {
      const editor = await openEditor({
          ...seeded,
          action: "scrollPages",
          actionArg: -1,
        }),
        field = focus(editor.numberField());
      // The minus typed first is not a number yet: the field reports no text.
      editor.typeNumber("");
      expect(field.value).toBe("");
      expect(editor.callback).not.toHaveBeenCalled();
      editor.typeNumber("-2");
      expect(field.value).toBe("-2");
      expect(editor.saved()).toStrictEqual({
        ...seeded,
        action: "scrollPages",
        actionArg: -2,
      });
      editor.modal.close();
    });

    it("keeps a draft when the window loses the focus and gets it back", async () => {
      const editor = await openEditor({
          ...seeded,
          action: "scrollPages",
          actionArg: -1,
        }),
        field = focus(editor.numberField());
      // The minus typed first.
      editor.typeNumber("");
      // Switching to another window blurs the field. It stays the focused
      // element of its page and has the focus again on return. A number
      // written into it now puts the caret after that number, so the "2"
      // typed next makes "-12".
      field.dispatchEvent(new FocusEvent("blur"));
      expect(document.activeElement).toBe(field);
      expect(field.value).toBe("");
      expect(editor.callback).not.toHaveBeenCalled();
      editor.modal.close();
    });

    it("shows a number typed just before the field is left while it saves", async () => {
      const editor = await openEditor(scrollLines),
        field = focus(editor.numberField());
      editor.typeNumber("7");
      // Leaving at once: the editor is still awaiting the save of the key.
      field.blur();
      expect(field.value).toBe("7");
      expect(editor.saved()).toMatchObject({ actionArg: 7 });
      editor.modal.close();
    });

    it("stores no text that is not a whole number it can hold", async () => {
      const editor = await openEditor(scrollLines),
        field = focus(editor.numberField());
      for (const text of [
        "+5",
        "1e3",
        "1.",
        "-",
        "--1",
        "1-",
        "0x10",
        `1${"0".repeat(400)}`,
      ]) {
        editor.typeNumber(text);
        expect(editor.callback, text).not.toHaveBeenCalled();
      }
      field.blur();
      expect(field.value).toBe("3");
      editor.modal.close();
    });

    it("saves only numbers that load unchanged from data.json", async () => {
      const editor = await openEditor(scrollLines);
      focus(editor.numberField());
      for (const [text, stored] of [
        ["-0", -0],
        ["007", 7],
        ["-007", -7],
        ["12345678901234567890", Number("12345678901234567890")],
      ] as const) {
        editor.typeNumber(text);
        const saved = editor.saved();
        expect(saved?.actionArg, text).toBe(stored);
        // As a device on 3.29.0 or this release reads the synced file.
        const json: unknown = JSON.parse(JSON.stringify(saved)),
          loaded = Settings.Keymapping.fix(json);
        expect(loaded.valid, text).toBe(true);
        expect(loaded.value, text).toStrictEqual(json);
      }
      editor.modal.close();
    });

    it("reads the focus from the field's own window, as in a pop-out", async () => {
      const editor = await openEditor(scrollLines),
        field = editor.numberField();
      // A second window cannot be made here: its globals clash with the
      // test's. The field reports a document of its own whose focus it has,
      // while the main document's focus is elsewhere.
      const popOut = { activeElement: field };
      Object.defineProperty(field, "ownerDocument", { get: () => popOut });
      expect(document.activeElement).not.toBe(field);
      editor.typeNumber("05");
      expect(editor.saved()).toMatchObject({ actionArg: 5 });
      expect(field.value).toBe("05");
      editor.modal.close();
    });

    it("keeps a hidden scroll amount out of a text action", async () => {
      const editor = await openEditor(scrollLines),
        field = focus(editor.numberField());
      editor.typeNumber("");
      // Choosing in the dropdown takes the focus from the field first.
      field.blur();
      await editor.chooseAction("sendText");
      expect(editor.saved()).toMatchObject({
        action: "sendText",
        actionArg: "",
      });
      editor.callback.mockClear();
      field.dispatchEvent(new FocusEvent("blur"));
      expect(field.style.display).toBe("none");
      expect(editor.textField().value).toBe("");
      expect(editor.callback).not.toHaveBeenCalled();
      editor.typeText("x");
      expect(editor.saved()).toMatchObject({
        action: "sendText",
        actionArg: "x",
      });
      editor.modal.close();
    });

    it("keeps a decimal in the field while the whole number stays saved", async () => {
      const editor = await openEditor(scrollLines),
        field = focus(editor.numberField());
      // On Linux the field reports "1." as "1", then "1.5" as it is.
      editor.typeNumber("1");
      editor.typeNumber("1.5");
      expect(field.value).toBe("1.5");
      expect(editor.callback).toHaveBeenCalledOnce();
      expect(editor.saved()).toMatchObject({ actionArg: 1 });
      field.blur();
      expect(field.value).toBe("1");
      editor.modal.close();
    });

    it("does not rewrite a focused field whose text stands for the saved number", async () => {
      const editor = await openEditor(scrollLines),
        field = focus(editor.numberField());
      editor.typeNumber("05");
      expect(editor.saved()).toMatchObject({ actionArg: 5 });
      expect(field.value).toBe("05");
      editor.typeNumber("-0");
      expect(editor.saved()?.actionArg).toBe(-0);
      expect(field.value).toBe("-0");
      editor.typeNumber("-05");
      expect(editor.saved()).toMatchObject({ actionArg: -5 });
      expect(field.value).toBe("-05");
      field.blur();
      expect(field.value).toBe("-5");
      editor.modal.close();
    });
  });
});
