import { createInstance } from "i18next";
import * as doctor from "../../src/terminal/win32-doctor.js";
import { SettingTab } from "../../src/settings.js";
import { loadDocumentations } from "../../src/documentations.js";
import { Settings } from "../../src/settings-data.js";
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
  clearWindowsPythonDiagnoses,
  invalidateConPtyRuntime,
  pluginPythonStatusKey,
  windowsConPtyStatus,
  runPluginPythonCheck,
  invalidateWindowsPythonDiagnosis,
  win32PythonConfigurationKey,
} from "../../src/terminal/win32-doctor.js";

vi.mock("../../src/modals.js", () => ({}));

async function renderPythonWidgets(
  diagnosis: Win32PythonDiagnosis,
  configured = "python",
) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const rows = capturePythonRows(),
    context = await pythonSettingsContext({ pythonExecutable: configured });
  Object.assign(context.language, { value: i18n });
  const key = win32PythonConfigurationKey(configured, configured);
  displayed.set(key, diagnosis);
  const tab = new PythonSettingTab(context, loadDocumentations(context));
  tab.renderPython();
  const row = rows.get(i18n.t("settings.python-status")),
    [download, recheck] = row?.buttons ?? [];
  if (!row || !download || !recheck)
    throw new Error("Missing Python status controls");
  const downloadCta = vi.spyOn(download, "setCta"),
    recheckCta = vi.spyOn(recheck, "setCta");
  return {
    publish: (value: Win32PythonDiagnosis) => {
      displayed.set(key, value);
    },
    render: () => {
      downloadCta.mockClear();
      recheckCta.mockClear();
      tab.update();
      return {
        description: row.descEl.textContent,
        download: { buttonEl: download.buttonEl, setCta: downloadCta },
        recheck: { buttonEl: recheck.buttonEl, setCta: recheckCta },
      };
    },
    cleanup: () => {
      tab.dispose();
      displayed.delete(key);
    },
  };
}

const found: Win32PythonDiagnosis = {
  candidate: "python",
  detail: "",
  executable: "C:\\Python\\python.exe",
  hostExecutable: "C:\\Python\\python.exe",
  status: "ok",
  tried: ["python"],
  version: "3.12.0",
};

describe("plugin Python status row", () => {
  afterEach(() => {
    clearWindowsPythonDiagnoses();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it.each(["EACCES", "UNKNOWN"])(
    "renders a %s refusal without installation guidance",
    async (errno) => {
      const fixture = await renderPythonWidgets(
        {
          ...found,
          status: "missing",
          transient: true,
          errno,
        },
        found.executable,
      );
      try {
        const { description, download, recheck } = fixture.render();
        expect(description).toContain(found.executable);
        expect(description).toContain(errno);
        expect(description).toContain(
          "security software or policy may be blocking it",
        );
        expect(description).not.toContain("{{");
        expect(download.buttonEl.style.display).toBe("none");
        expect(recheck.buttonEl.style.display).toBe("");
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("keeps a transient failure without errno generic and hides Download", async () => {
    const fixture = await renderPythonWidgets(
      {
        ...found,
        status: "missing",
        transient: true,
      },
      found.executable,
    );
    try {
      const { description, download, recheck } = fixture.render();
      expect(description).toBe(en.settings["python-status-unverified"]);
      expect(download.buttonEl.style.display).toBe("none");
      expect(recheck.buttonEl.style.display).toBe("");
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    "missing",
    "store-stub",
    "too-old",
  ] satisfies readonly Win32PythonDiagnosis["status"][])(
    "retains installation guidance for definitive %s",
    async (status) => {
      const fixture = await renderPythonWidgets({ ...found, status });
      try {
        const { description, download, recheck } = fixture.render();
        expect(description).toContain("download button");
        expect(download.buttonEl.style.display).toBe("");
        expect(download.setCta).toHaveBeenCalledOnce();
        expect(recheck.buttonEl.style.display).toBe("");
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.each([
    {
      state: "refusal",
      diagnosis: {
        ...found,
        status: "missing",
        transient: true,
        errno: "EACCES",
      },
      initialText: "EACCES",
    },
    {
      state: "transient fallback",
      diagnosis: {
        ...found,
        candidate: "python3",
        executable: "D:\\Python\\python.exe",
        transient: true,
      },
      initialText: "could not be used for this check",
    },
  ] satisfies readonly {
    readonly state: string;
    readonly diagnosis: Win32PythonDiagnosis;
    readonly initialText: string;
  }[])(
    "shows checking over $state and clears it after a successful recheck",
    async ({ diagnosis, initialText }) => {
      const fixture = await renderPythonWidgets(diagnosis, found.executable);
      // The test resolves the in-flight recheck after asserting its pending state.
      let finish: (diagnosis: Win32PythonDiagnosis) => void = () => {
        throw new Error("Check not started");
      };
      const check = new Promise<Win32PythonDiagnosis>((resolve) => {
        finish = resolve;
      });
      const runCheck = vi
        .spyOn(doctor, "runPluginPythonCheck")
        .mockReturnValue(check);
      try {
        const initial = fixture.render();
        expect(initial.description).toContain(initialText);
        initial.recheck.buttonEl.click();
        // Explicit Recheck waits for the current field mutation to settle.
        await Promise.resolve();
        expect(runCheck).toHaveBeenCalledOnce();
        const checking = fixture.render();
        expect(checking.description).toContain("Checking");
        expect(checking.description).not.toContain(initialText);
        expect(checking.download.buttonEl.style.display).toBe("none");
        expect(checking.recheck.buttonEl.style.display).toBe("");
        fixture.publish(found);
        finish(found);
        await check;
        // Flush the production catch/finally chain before rendering again.
        await Promise.resolve();
        const recovered = fixture.render();
        expect(recovered.description).toContain(found.executable);
        expect(recovered.description).toContain(found.version);
        expect(recovered.description).not.toContain(initialText);
        expect(recovered.recheck.setCta).not.toHaveBeenCalled();
        expect(recovered.download.buttonEl.style.display).toBe("none");
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.each(["confirmed", "unconfirmed", "breaker", "transient"])(
    "warns about a configured interpreter fallback with a %s result",
    async (state) => {
      const configured = "C:\\Python314\\pythn.exe";
      const diagnosis: Win32PythonDiagnosis = {
        ...found,
        hostExecutable: state === "unconfirmed" ? null : found.hostExecutable,
        transient: state === "transient",
      };
      if (state === "breaker") {
        invalidateConPtyRuntime(configured, configured);
      }
      expect(pluginPythonStatusKey(diagnosis, false, configured)).toBe(
        "ok-fallback",
      );
      expect(pluginPythonStatusKey(diagnosis, true, configured)).toBe(
        "checking",
      );
      const fixture = await renderPythonWidgets(diagnosis, configured);
      try {
        const { description, download, recheck } = fixture.render();
        expect(description).toContain(configured);
        expect(description).toContain(found.executable);
        expect(description).toContain(found.version);
        expect(description).toContain("could not be used for this check");
        expect(description).not.toContain("{{");
        expect(description).not.toContain("ConPTY");
        expect(download.buttonEl.style.display).toBe("none");
        expect(recheck.buttonEl.style.display).toBe("");
        expect(recheck.setCta).toHaveBeenCalledOnce();
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.each([
    ["python", "ok-resolved"],
    [found.executable.toUpperCase(), "ok-resolved"],
    ["", "ok-resolved"],
  ])("keeps ordinary success for configuration %j", (configured, expected) => {
    expect(pluginPythonStatusKey(found, false, configured)).toBe(expected);
  });

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

  it.each([
    [found.executable, "missing-configured"],
    [found.executable.toUpperCase(), "missing-configured"],
    ["", "missing"],
    ["another-python", "missing"],
  ])(
    "renders definitive missing guidance for configuration %j",
    async (configured, expected) => {
      const missing: Win32PythonDiagnosis = { ...found, status: "missing" };
      expect(pluginPythonStatusKey(missing, false, configured)).toBe(expected);
      expect(pluginPythonStatusKey(missing, true, configured)).toBe("checking");
      const fixture = await renderPythonWidgets(missing, configured);
      try {
        const { description, download, recheck } = fixture.render();
        if (expected === "missing-configured") {
          expect(description).toContain(found.executable);
          expect(description).toContain("could not be run");
          expect(description).not.toContain("enter its full path");
        } else {
          expect(description).toContain("was not found on PATH");
          expect(description).toContain("enter its full path");
        }
        expect(description).not.toContain("{{");
        expect(download.buttonEl.style.display).toBe("");
        expect(recheck.buttonEl.style.display).toBe("");
      } finally {
        fixture.cleanup();
      }
    },
  );

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

vi.mock("../../src/documentations.js", () => ({
  loadDocumentations: vi.fn().mockReturnValue({}),
}));
const displayed = vi.hoisted(() => new Map<string, Win32PythonDiagnosis>());
vi.mock("../../src/terminal/win32-doctor.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/terminal/win32-doctor.js")
  >()),
  runPluginPythonCheck: vi.fn(),
  invalidateWindowsPythonDiagnosis: vi.fn(),
  getPluginPythonDiagnosis: vi.fn(() => found),
  getWindowsPythonDiagnosis: vi.fn(
    (value: string, fallback: string) =>
      displayed.get(win32PythonConfigurationKey(value, fallback)) ?? null,
  ),
}));

class PythonSettingTab extends SettingTab {
  public renderPython(): void {
    this.newPythonWidgets();
  }
  public update(): void {
    this.ui.update();
  }
  public dispose(): void {
    this.onUnload();
  }
  protected override postMutate(): void {
    this.ui.update();
  }
}

describe("plugin Python automatic checks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    displayed.clear();
    vi.mocked(runPluginPythonCheck).mockImplementation(async (context) => {
      const value = context.settings.value.pythonExecutable;
      displayed.set(win32PythonConfigurationKey(value, value), found);
      return found;
    });
  });
  afterEach(() => {
    clearWindowsPythonDiagnoses();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("reaps existing spares before explicit Recheck starts", async () => {
    const rows = capturePythonRows(),
      context = await pythonSettingsContext({ pythonExecutable: "python" }),
      tab = new PythonSettingTab(context, loadDocumentations(context));
    try {
      tab.renderPython();
      await withPythonSpare("old-python", async ({ host, control }) => {
        // Capture the state at the check boundary, before any diagnosis resolves.
        const reapedAtCheck = vi.fn(() => host.killed);
        vi.mocked(runPluginPythonCheck).mockImplementationOnce(async () => {
          reapedAtCheck();
          return found;
        });
        rows
          .get("settings.python-status")
          ?.buttons.find(
            (button) => button.buttonEl.title === "settings.python-recheck",
          )
          ?.buttonEl.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(reapedAtCheck).toHaveReturnedWith(true);
        await expect(control.ready).rejects.toMatchObject({
          reason: "aborted",
        });
      });
    } finally {
      tab.dispose();
    }
  });

  it.each([
    "/opt/python3",
    "\\tools\\python.exe",
    "\\\\server\\share\\python.exe",
    "bin/python",
    "C:python.exe",
  ])(
    "explains the excluded value %s and still offers explicit Recheck",
    async (value) => {
      const rows = capturePythonRows(),
        context = await pythonSettingsContext({ pythonExecutable: value }),
        tab = new PythonSettingTab(context, loadDocumentations(context));
      tab.renderPython();
      const status = rows.get("settings.python-status");
      expect(status?.descEl.textContent).toBe(
        "settings.python-status-not-automatic",
      );
      expect(status?.buttons[0]?.buttonEl.style.display).toBe("none");
      // Typing and committing an excluded value never launches it automatically.
      const changed = `${value}2`;
      const input = typePythonValue(
        rows.get("settings.python-executable")?.texts[0],
        changed,
      );
      input.dispatchEvent(new Event("change"));
      input.dispatchEvent(new Event("blur"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runPluginPythonCheck).not.toHaveBeenCalled();
      expect(status?.descEl.textContent).toBe(
        "settings.python-status-not-automatic",
      );
      status?.buttons
        .find((button) => button.buttonEl.title === "settings.python-recheck")
        ?.buttonEl.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(runPluginPythonCheck).toHaveBeenCalledExactlyOnceWith(
        context,
        void 0,
        void 0,
        { includeProfileOverrides: true, refresh: true },
      );
      expect(context.settings.value.pythonExecutable).toBe(changed);
      tab.dispose();
    },
  );

  it.each(["", "python", "C:\\Python\\python.exe", "C:/Python/python.exe"])(
    "checks committed eligible edits %j once without refreshing PATH or overrides",
    async (value) => {
      const rows = capturePythonRows(),
        context = await pythonSettingsContext({
          pythonExecutable: "previous-python",
          profiles: {
            custom: {
              ...Settings.Profile.DEFAULTS.integrated,
              pythonExecutable: "/opt/python3",
              platforms: { win32: true },
            },
          },
        }),
        tab = new PythonSettingTab(context, loadDocumentations(context));
      tab.renderPython();
      tab.update();
      const input = typePythonValue(
        rows.get("settings.python-executable")?.texts[0],
        value,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runPluginPythonCheck).not.toHaveBeenCalled();
      input.dispatchEvent(new Event("change"));
      input.dispatchEvent(new Event("blur"));
      await vi.advanceTimersByTimeAsync(0);
      expect(runPluginPythonCheck).toHaveBeenCalledExactlyOnceWith(
        context,
        void 0,
        void 0,
        { includeProfileOverrides: false, refresh: false },
      );
      expect(invalidateWindowsPythonDiagnosis).toHaveBeenCalledExactlyOnceWith(
        value,
        value,
      );
      expect(context.settings.value.pythonExecutable).toBe(value);
      tab.dispose();
    },
  );
  it.each([
    {
      state: "refused",
      diagnosis: {
        ...found,
        status: "missing",
        transient: true,
        errno: "EACCES",
      },
      statusKey: "unverified-errno",
    },
    {
      state: "transient",
      diagnosis: { ...found, status: "missing", transient: true },
      statusKey: "unverified",
    },
    {
      state: "fallback",
      diagnosis: found,
      statusKey: "ok-fallback",
    },
  ] satisfies readonly {
    readonly state: string;
    readonly diagnosis: Win32PythonDiagnosis;
    readonly statusKey: string;
  }[])(
    "preserves $state guidance after a committed edit",
    async ({ diagnosis, statusKey }) => {
      vi.mocked(runPluginPythonCheck).mockImplementationOnce(
        async (context) => {
          const value = context.settings.value.pythonExecutable;
          displayed.set(win32PythonConfigurationKey(value, value), diagnosis);
          return diagnosis;
        },
      );
      const rows = capturePythonRows(),
        context = await pythonSettingsContext(),
        tab = new PythonSettingTab(context, loadDocumentations(context));
      tab.renderPython();
      const text = rows.get("settings.python-executable")?.texts[0],
        input = typePythonValue(text, "python-custom");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runPluginPythonCheck).not.toHaveBeenCalled();
      input.dispatchEvent(new Event("change"));
      input.dispatchEvent(new Event("blur"));
      await vi.advanceTimersByTimeAsync(0);
      const status = rows.get("settings.python-status");
      expect(runPluginPythonCheck).toHaveBeenCalledExactlyOnceWith(
        context,
        void 0,
        void 0,
        { includeProfileOverrides: false, refresh: false },
      );
      expect(status?.descEl.textContent).toBe(
        `settings.python-status-${statusKey}`,
      );
      expect(status?.buttons[0]?.buttonEl.style.display).toBe("none");
      expect(status?.buttons[1]?.buttonEl.style.display).toBe("");
      typePythonValue(text, "/opt/python3").dispatchEvent(new Event("blur"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runPluginPythonCheck).toHaveBeenCalledTimes(1);
      expect(status?.descEl.textContent).toBe(
        "settings.python-status-not-automatic",
      );
      tab.dispose();
    },
  );

  it("awaits persistence on blur and removes listeners when disposed", async () => {
    const rows = capturePythonRows(),
      context = await pythonSettingsContext(),
      tab = new PythonSettingTab(context, loadDocumentations(context));
    tab.renderPython();
    const input = typePythonValue(
      rows.get("settings.python-executable")?.texts[0],
      "python-latest",
    );
    // Commit in the same turn as input, before the async settings mutation settles.
    input.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(0);
    expect(runPluginPythonCheck).toHaveBeenCalledTimes(1);
    expect(context.settings.value.pythonExecutable).toBe("python-latest");
    tab.dispose();
    input.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(0);
    expect(runPluginPythonCheck).toHaveBeenCalledTimes(1);
  });

  it.each(["change", "recheck"])(
    "drops a queued %s when typing resumes before persistence settles",
    async (trigger) => {
      const rows = capturePythonRows(),
        context = await pythonSettingsContext(),
        tab = new PythonSettingTab(context, loadDocumentations(context)),
        pending = Promise.withResolvers<undefined>(),
        mutate = vi.spyOn(context.settings, "mutate"),
        originalMutate = mutate.getMockImplementation();
      if (!originalMutate) throw new Error("Settings mutation mock missing");
      mutate
        .mockImplementationOnce(originalMutate)
        .mockImplementationOnce(async (callback) => {
          await pending.promise;
          await originalMutate(callback);
        });
      tab.renderPython();
      const text = rows.get("settings.python-executable")?.texts[0];
      const input = typePythonValue(text, "python-old");
      if (trigger === "change") input.dispatchEvent(new Event("change"));
      else
        rows
          .get("settings.python-status")
          ?.buttons.find(
            (button) => button.buttonEl.title === "settings.python-recheck",
          )
          ?.buttonEl.click();
      typePythonValue(text, "python-latest");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runPluginPythonCheck).not.toHaveBeenCalled();
      pending.resolve(void 0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runPluginPythonCheck).not.toHaveBeenCalled();
      text?.inputEl.dispatchEvent(new Event("blur"));
      await vi.advanceTimersByTimeAsync(0);
      expect(runPluginPythonCheck).toHaveBeenCalledTimes(1);
      expect(context.settings.value.pythonExecutable).toBe("python-latest");
      tab.dispose();
    },
  );

  it("suspends checks and late UI updates while hidden, then rebinds on display", async () => {
    const pending = Promise.withResolvers<Win32PythonDiagnosis>();
    vi.mocked(runPluginPythonCheck).mockReturnValueOnce(pending.promise);
    const rows = capturePythonRows(),
      context = await pythonSettingsContext(),
      tab = new PythonSettingTab(context, loadDocumentations(context));
    tab.renderPython();
    tab.display();
    const input = typePythonValue(
      rows.get("settings.python-executable")?.texts[0],
      "python-old",
    );
    input.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(0);
    expect(runPluginPythonCheck).toHaveBeenCalledTimes(1);
    tab.hide();
    const before = rows.get("settings.python-status")?.descEl.textContent;
    pending.resolve(found);
    await vi.advanceTimersByTimeAsync(0);
    expect(rows.get("settings.python-status")?.descEl.textContent).toBe(before);
    await context.settings.mutate((settings) => {
      settings.pythonExecutable = "python-new";
    });
    input.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(0);
    expect(runPluginPythonCheck).toHaveBeenCalledTimes(1);
    tab.display();
    tab.display();
    input.dispatchEvent(new Event("change"));
    input.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(0);
    expect(runPluginPythonCheck).toHaveBeenCalledTimes(2);
    expect(context.settings.value.pythonExecutable).toBe("python-new");
    tab.dispose();
  });

  it.each(["edit", "close"])(
    "does not repaint a late result after %s",
    async (action) => {
      const pending = Promise.withResolvers<Win32PythonDiagnosis>();
      vi.mocked(runPluginPythonCheck).mockReturnValueOnce(pending.promise);
      const rows = capturePythonRows(),
        context = await pythonSettingsContext(),
        tab = new PythonSettingTab(context, loadDocumentations(context));
      tab.renderPython();
      const input = typePythonValue(
        rows.get("settings.python-executable")?.texts[0],
        "python-old",
      );
      input.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(0);
      expect(runPluginPythonCheck).toHaveBeenCalledTimes(1);
      if (action === "edit") {
        typePythonValue(
          rows.get("settings.python-executable")?.texts[0],
          "python-new",
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(rows.get("settings.python-status")?.descEl.textContent).toBe(
          "settings.python-status-unverified",
        );
      } else tab.dispose();
      const before = rows.get("settings.python-status")?.descEl.textContent;
      pending.resolve(found);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(rows.get("settings.python-status")?.descEl.textContent).toBe(
        before,
      );
      expect(runPluginPythonCheck).toHaveBeenCalledTimes(1);
      tab.dispose();
    },
  );
  it("keeps explicit Recheck's full refresh after a blur starts an automatic check", async () => {
    const pending = Promise.withResolvers<Win32PythonDiagnosis>();
    vi.mocked(runPluginPythonCheck).mockReturnValueOnce(pending.promise);
    const rows = capturePythonRows(),
      context = await pythonSettingsContext(),
      tab = new PythonSettingTab(context, loadDocumentations(context));
    tab.renderPython();
    typePythonValue(
      rows.get("settings.python-executable")?.texts[0],
      "python",
    ).dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(0);
    rows
      .get("settings.python-status")
      ?.buttons.find(
        (button) => button.buttonEl.title === "settings.python-recheck",
      )
      ?.buttonEl.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(runPluginPythonCheck).toHaveBeenNthCalledWith(
      1,
      context,
      void 0,
      void 0,
      { includeProfileOverrides: false, refresh: false },
    );
    expect(runPluginPythonCheck).toHaveBeenNthCalledWith(
      2,
      context,
      void 0,
      void 0,
      { includeProfileOverrides: true, refresh: true },
    );
    pending.resolve(found);
    await vi.advanceTimersByTimeAsync(0);
    expect(runPluginPythonCheck).toHaveBeenCalledTimes(2);
    tab.dispose();
  });
});
