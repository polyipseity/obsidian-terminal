import {
  KeymappingEditModal,
  ProfileModal,
  TerminalOptionsModal,
} from "../../src/modals.js";
import * as doctor from "../../src/terminal/win32-doctor.js";
import { Keymap, Scope } from "../mocks/obsidian.js";
import { Settings } from "../../src/settings-data.js";
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
