import {
  EditDataModal,
  Platform,
  UpdatableUI,
  cloneAsWritable,
  createI18n,
  setSanitizedInnerHTML,
} from "@polyipseity/obsidian-plugin-library";
import { createInstance } from "i18next";
import {
  ButtonComponent,
  DropdownComponent,
  ExtraButtonComponent,
  Setting,
  ToggleComponent,
} from "obsidian";
import * as doctor from "../../src/terminal/win32-doctor.js";
import { SettingTab } from "../../src/settings.js";
import { TerminalSettingsManager } from "../../src/settings-manager.js";
import { loadDocumentations } from "../../src/documentations.js";
import {
  EXPERIMENTS,
  type Experiment,
  fixExperiments,
} from "../../src/experiments.js";
import { LocalSettings, Settings } from "../../src/settings-data.js";
import type { ProfileListModal } from "../../src/modals.js";
import {
  capturePythonRows,
  pythonSettingsContext,
  typePythonValue,
  withPythonSpare,
} from "../fixtures/python-settings-ui.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginLocales } from "../../assets/locales.js";
import asset from "../../assets/locales/en/asset.json" with { type: "json" };
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

// What the settings tab opened each profile list with; a test answers for it.
const profileLists = vi.hoisted(
  (): {
    readonly data: ProfileListModal.Data;
    readonly callback: NonNullable<ProfileListModal.Options["callback"]>;
  }[] => [],
);
// The modals the settings tab opens, one member each.
const modalMocks = vi.hoisted(() => ({
  ProfileListModal: class {
    public constructor(
      _context: unknown,
      data: ProfileListModal.Data,
      options: ProfileListModal.Options,
    ) {
      profileLists.push({ data, callback: options.callback ?? vi.fn() });
    }
    public open(): void {
      // Nothing to show; the test calls the callback.
    }
  },
}));
vi.mock("../../src/modals.js", () => ({ ...modalMocks }));

// The device platform. `null` keeps the real one; tests that set it reset it.
const platform = vi.hoisted((): { current: Platform.All | null } => ({
  current: null,
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
        return platform.current ?? actual.Platform.CURRENT;
      },
    },
  };
});

async function renderPythonWidgets(
  diagnosis: Win32PythonDiagnosis | null,
  configured = "python",
) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const rows = capturePythonRows(),
    context = await pythonSettingsContext({ pythonExecutable: configured });
  Object.assign(context.language, { value: i18n });
  const key = win32PythonConfigurationKey(configured, configured);
  if (diagnosis) displayed.set(key, diagnosis);
  const tab = new PythonSettingTab(context, loadDocumentations(context));
  tab.renderPython();
  const row = rows.get(i18n.t("settings.python-status")),
    [download, recheck] = row?.buttons ?? [];
  if (!row || !download || !recheck)
    throw new Error("Missing Python status controls");
  const downloadCta = vi.spyOn(download, "setCta"),
    recheckCta = vi.spyOn(recheck, "setCta");
  return {
    i18n,
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

  it.each([
    null,
    { ...found, status: "missing" },
  ] satisfies readonly (Win32PythonDiagnosis | null)[])(
    "shows checking and hides Download during a plugin-level check (%j)",
    async (diagnosis) => {
      const pending = vi
        .spyOn(doctor, "isPluginPythonCheckPending")
        .mockReturnValue(true);
      const fixture = await renderPythonWidgets(diagnosis);
      try {
        const { description, download, recheck } = fixture.render();
        expect(pending).toHaveBeenCalledWith(expect.anything(), "python");
        expect(description).toBe(
          fixture.i18n.t("settings.python-status-checking"),
        );
        expect(download.buttonEl.style.display).toBe("none");
        expect(recheck.setCta).toHaveBeenCalledOnce();
      } finally {
        fixture.cleanup();
      }
    },
  );

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

/** A Windows settings row that keeps its toggle and reset button. */
class ConsoleHostRow extends Setting {
  public override readonly settingEl = document.createElement("div");
  public override readonly nameEl = document.createElement("div");
  public override readonly descEl = document.createElement("div");
  public toggle: ToggleComponent | null = null;
  public reset: ExtraButtonComponent | null = null;

  public constructor(containerEl: HTMLElement) {
    super(containerEl);
    this.settingEl.append(this.nameEl, this.descEl);
    containerEl.append(this.settingEl);
  }

  public override setName(name: DocumentFragment | string): this {
    this.nameEl.replaceChildren(name);
    return this;
  }

  public override setDesc(description: DocumentFragment | string): this {
    this.descEl.replaceChildren(description);
    return this;
  }

  // The Python status buttons have their own tests above.
  public override addButton(): this {
    return this;
  }

  public override addToggle(
    configure: (toggle: ToggleComponent) => unknown,
  ): this {
    this.toggle ??= new ToggleComponent(this.settingEl);
    // The mock's setValue calls the change handler; a redraw must not write.
    this.toggle.onChange(() => {});
    configure(this.toggle);
    return this;
  }

  public override addExtraButton(
    configure: (button: ExtraButtonComponent) => unknown,
  ): this {
    this.reset ??= new ExtraButtonComponent(this.settingEl);
    configure(this.reset);
    return this;
  }
}

/** Loads the whole tab, the Windows-only rows included where they show. */
class WholeSettingTab extends PythonSettingTab {
  public load(): void {
    this.onLoad();
  }
}

describe("Windows Terminal console host setting", () => {
  afterEach(() => {
    platform.current = null;
    clearWindowsPythonDiagnoses();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  /** Draws the Windows-only rows, or the whole tab, in English. */
  async function drawRows(initial: unknown = {}, whole = false) {
    const i18n = createInstance();
    await i18n.init({
      lng: "en",
      resources: { en: { asset, translation: en } },
    });
    const rows: ConsoleHostRow[] = [];
    vi.spyOn(UpdatableUI.prototype, "newSetting").mockImplementation(function (
      this: UpdatableUI,
      element,
      configure,
    ) {
      return this.new(
        () => {
          const row = new ConsoleHostRow(element);
          rows.push(row);
          return row;
        },
        (row) => {
          configure(row);
        },
        (row) => {
          row.settingEl.remove();
        },
      );
    });
    const context = await pythonSettingsContext(initial);
    Object.assign(context, {
      localSettings: {
        value: LocalSettings.fix({ lastReadChangelogVersion: "0.0.0" }).value,
      },
      version: null,
    });
    Object.assign(context.language, {
      onChangeLanguage: { listen: vi.fn().mockReturnValue(vi.fn()) },
      value: i18n,
    });
    const tab = new WholeSettingTab(context, loadDocumentations(context));
    if (whole) {
      tab.load();
    } else {
      tab.renderPython();
    }
    const names = (): readonly string[] =>
      rows.map((row) => row.nameEl.textContent);
    return {
      context,
      host: (): ConsoleHostRow => {
        const found = rows.find(
          (row) =>
            row.nameEl.textContent ===
            en.settings["windows-terminal-console-host"],
        );
        if (!found?.toggle || !found.reset)
          throw new Error("Missing console host controls");
        return found;
      },
      names,
      tab,
    };
  }

  it("follows the prewarm toggle as the last Windows row", async () => {
    const { host, names, tab } = await drawRows();
    try {
      expect(names().slice(-2)).toEqual([
        en.settings["prewarm-conpty"],
        "Windows Terminal console host",
      ]);
      expect(host().descEl.textContent).toBe(
        en.settings["windows-terminal-console-host-description"],
      );
      expect(host().toggle?.getValue()).toBe(true);
    } finally {
      tab.dispose();
    }
  });

  it("stores the toggle and resets it to on", async () => {
    const { context, host, tab } = await drawRows(),
      { reset, toggle } = host();
    try {
      toggle?.setValue(false);
      await vi.waitFor(() => {
        expect(context.settings.value.windowsTerminalConsoleHost).toBe(false);
      });
      expect(toggle?.getValue()).toBe(false);
      reset?.extraSettingsEl.click();
      await vi.waitFor(() => {
        expect(context.settings.value.windowsTerminalConsoleHost).toBe(true);
      });
      expect(toggle?.getValue()).toBe(true);
    } finally {
      tab.dispose();
    }
  });

  it("shows a stored off", async () => {
    const { host, tab } = await drawRows({ windowsTerminalConsoleHost: false });
    try {
      expect(host().toggle?.getValue()).toBe(false);
    } finally {
      tab.dispose();
    }
  });

  it.each(Platform.ALL)("is drawn only on Windows (%s)", async (current) => {
    platform.current = current;
    const { names, tab } = await drawRows({}, true),
      drawn = names(),
      prewarm = drawn.indexOf(en.settings["prewarm-conpty"]);
    try {
      expect(drawn.includes("Windows Terminal console host")).toBe(
        current === "win32",
      );
      // Directly under the prewarm toggle where it is drawn.
      expect(drawn.indexOf("Windows Terminal console host")).toBe(
        current === "win32" ? prewarm + 1 : -1,
      );
    } finally {
      tab.dispose();
    }
  });
});

/** A settings row that keeps its toggle and reset button, as the real row does. */
class ExperimentRow extends Setting {
  public override readonly settingEl = document.createElement("div");
  public override readonly nameEl = document.createElement("div");
  public override readonly descEl = document.createElement("div");
  public toggle: ToggleComponent | null = null;
  public reset: ExtraButtonComponent | null = null;

  public constructor(containerEl: HTMLElement) {
    super(containerEl);
    this.settingEl.append(this.nameEl, this.descEl);
    containerEl.append(this.settingEl);
  }

  public override setName(name: string): this {
    this.nameEl.textContent = name;
    return this;
  }

  public override setDesc(description: DocumentFragment | string): this {
    this.descEl.replaceChildren(description);
    return this;
  }

  public override addToggle(
    configure: (toggle: ToggleComponent) => unknown,
  ): this {
    this.toggle ??= new ToggleComponent(this.settingEl);
    // The mock's setValue calls the change handler; a redraw must not write.
    this.toggle.onChange(() => {});
    configure(this.toggle);
    return this;
  }

  public override addExtraButton(
    configure: (button: ExtraButtonComponent) => unknown,
  ): this {
    this.reset ??= new ExtraButtonComponent(this.settingEl);
    configure(this.reset);
    return this;
  }
}

class ExperimentalSettingTab extends SettingTab {
  public draw(rows: readonly Experiment.Row[]): void {
    this.newExperimentalWidgets(rows);
  }
  /** Draws what `experimentRows()` returns, as `onLoad()` does. */
  public drawRegistered(): void {
    this.newExperimentalWidgets();
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

/** A tab whose registry holds the two fixture experiments. */
class TwoExperimentsSettingTab extends ExperimentalSettingTab {
  protected override experimentRows(): readonly Experiment.Row[] {
    return [ALPHA, BETA];
  }
}

/** Draws `rows`, or for `null` what the tab's own `experimentRows()` returns. */
async function drawExperimentalSection(
  rows: readonly Experiment.Row[] | null,
  Tab: typeof ExperimentalSettingTab = ExperimentalSettingTab,
) {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { asset, translation: en } },
  });
  const captured: ExperimentRow[] = [];
  vi.spyOn(UpdatableUI.prototype, "newSetting").mockImplementation(function (
    this: UpdatableUI,
    element,
    configure,
  ) {
    return this.new(
      () => {
        const row = new ExperimentRow(element);
        captured.push(row);
        return row;
      },
      (row) => {
        configure(row);
      },
      (row) => {
        row.settingEl.remove();
      },
    );
  });
  const context = await pythonSettingsContext();
  Object.assign(context.language, { value: i18n });
  // The fixture's mutate runs Settings.fix, which drops the fixture ids.
  vi.spyOn(context.settings, "mutate").mockImplementation(async (mutate) => {
    const value = cloneAsWritable(context.settings.value);
    await mutate(value);
    Object.assign(context.settings, { value });
  });
  const tab = new Tab(context, loadDocumentations(context));
  if (rows) {
    tab.draw(rows);
  } else {
    tab.drawRegistered();
  }
  return {
    context,
    holder: (id: string): HTMLElement | null =>
      tab.containerEl.querySelector<HTMLElement>(
        `[data-experiment-options="${id}"]`,
      ),
    row: (index: number) => {
      const row = captured[index],
        toggle = row?.toggle,
        reset = row?.reset;
      if (!row || !toggle || !reset)
        throw new Error("Missing experiment row controls");
      return {
        descEl: row.descEl,
        nameEl: row.nameEl,
        reset,
        settingEl: row.settingEl,
        toggle,
      };
    },
    rows: captured,
    tab,
  };
}

const experimentRow = (
    experiment: Experiment,
    name: string,
  ): Experiment.Row => ({
    ...experiment,
    effect: () => `${name} effect.`,
    name: () => name,
    risk: () => `${name} risk.`,
  }),
  ALPHA = experimentRow(
    { applies: "live", feedback: "https://example.invalid/alpha", id: "alpha" },
    "Alpha",
  ),
  BETA = experimentRow(
    {
      applies: "restart",
      feedback: "https://example.invalid/beta",
      id: "beta",
    },
    // Markup in a text must be shown as it is, neither escaped nor parsed.
    "Beta & <b>more</b>",
  );

describe("experimental section", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("draws nothing when there are no experiments", async () => {
    const { rows, tab } = await drawExperimentalSection([]);
    expect(tab.containerEl.childElementCount).toBe(0);
    expect(rows).toHaveLength(0);
  });

  it("draws the heading and one row per experiment in order, with no intro", async () => {
    const { rows, tab } = await drawExperimentalSection([ALPHA, BETA]),
      children = Array.from(tab.containerEl.children),
      [heading, alpha, beta] = children;
    expect(children).toHaveLength(3);
    expect(heading?.tagName).toBe("H2");
    expect(heading?.textContent).toBe(en.settings.experimental);
    expect(alpha?.getAttribute("data-experiment")).toBe("alpha");
    expect(beta?.getAttribute("data-experiment")).toBe("beta");
    expect(rows.map((row) => row.nameEl.textContent)).toEqual([
      ALPHA.name(),
      BETA.name(),
    ]);
    tab.dispose();
    expect(tab.containerEl.childElementCount).toBe(0);
  });

  it("draws what experimentRows() returns when it is given no rows", async () => {
    const { tab } = await drawExperimentalSection(
      null,
      TwoExperimentsSettingTab,
    );
    // The heading and the two rows, as when the rows are given.
    expect(
      Array.from(
        tab.containerEl.children,
        (child) => child.getAttribute("data-experiment") ?? child.tagName,
      ),
    ).toEqual(["H2", "alpha", "beta"]);
  });

  it("draws the registered experiments when it is given no rows", async () => {
    const registered: readonly Experiment[] = EXPERIMENTS,
      { tab } = await drawExperimentalSection(null),
      drawn = tab.containerEl.querySelectorAll("[data-experiment]");
    // One heading for the section, however many are registered.
    expect(tab.containerEl.querySelectorAll("h2")).toHaveLength(
      Math.min(registered.length, 1),
    );
    expect(
      Array.from(drawn, (row) => row.getAttribute("data-experiment")),
    ).toEqual(registered.map(({ id }) => id));
  });

  it("a row shows the name, the effect, the known risk and a feedback link", async () => {
    const section = await drawExperimentalSection([ALPHA, BETA]),
      alpha = section.row(0),
      beta = section.row(1),
      lines = (description: HTMLElement): readonly string[] =>
        Array.from(description.children, (line) => line.textContent);
    expect(alpha.nameEl.textContent).toBe("Alpha");
    // Alpha applies live, so its row has no note on how a change applies.
    expect(lines(alpha.descEl)).toEqual([
      "Alpha effect.",
      "Known risk: Alpha risk.",
      en.settings["experimental-feedback"],
    ]);
    expect(lines(beta.descEl)).toEqual([
      "Beta & <b>more</b> effect.",
      "Known risk: Beta & <b>more</b> risk.",
      en.settings["experimental-applies"].restart,
      en.settings["experimental-feedback"],
    ]);
    expect(beta.settingEl.querySelector("b")).toBeNull();
    expect(section.tab.containerEl.textContent).not.toContain("{{");

    const links = alpha.descEl.querySelectorAll("a"),
      link = links[0];
    expect(links).toHaveLength(1);
    expect(link?.getAttribute("href")).toBe(ALPHA.feedback);
    expect(link?.textContent).toBe(en.settings["experimental-feedback"]);
    expect(link?.target).toBe("_blank");

    // The click opens the browser itself; the anchor is not followed.
    const open = vi.spyOn(window, "open").mockReturnValue(null),
      click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link?.dispatchEvent(click);
    expect(open).toHaveBeenCalledExactlyOnceWith(
      ALPHA.feedback,
      "_blank",
      "noreferrer",
    );
    expect(click.defaultPrevented).toBe(true);
  });

  it("the toggle is off at first, stores true when turned on and removes the key when turned off", async () => {
    const section = await drawExperimentalSection([ALPHA, BETA]),
      { settings } = section.context,
      alpha = section.row(0),
      beta = section.row(1);
    expect(alpha.toggle.getValue()).toBe(false);
    expect(beta.toggle.getValue()).toBe(false);
    expect(settings.value.experiments).toEqual({});

    beta.toggle.setValue(true);
    await vi.waitFor(() => {
      expect(settings.value.experiments).toEqual({ beta: true });
    });
    alpha.toggle.setValue(true);
    await vi.waitFor(() => {
      expect(settings.value.experiments).toEqual({ alpha: true, beta: true });
    });
    alpha.toggle.setValue(false);
    await vi.waitFor(() => {
      expect(settings.value.experiments).toEqual({ beta: true });
    });
    // Off is the absence of the key, never a stored false.
    expect(Object.keys(settings.value.experiments)).toEqual(["beta"]);
    expect(beta.toggle.getValue()).toBe(true);
  });

  it("reset turns the experiment off", async () => {
    const section = await drawExperimentalSection([ALPHA, BETA]),
      { settings } = section.context,
      alpha = section.row(0);
    alpha.toggle.setValue(true);
    await vi.waitFor(() => {
      expect(settings.value.experiments).toEqual({ alpha: true });
    });
    alpha.reset.extraSettingsEl.click();
    await vi.waitFor(() => {
      expect(settings.value.experiments).toEqual({});
      expect(alpha.toggle.getValue()).toBe(false);
    });
  });

  it("options are drawn the first time the experiment is on and hidden while it is off", async () => {
    const options = vi.fn(),
      section = await drawExperimentalSection([{ ...ALPHA, options }, BETA]),
      alpha = section.row(0),
      beta = section.row(1),
      holder = section.holder("alpha");
    if (!holder) throw new Error("Missing options holder");
    expect(options).not.toHaveBeenCalled();
    expect(holder.style.display).toBe("none");
    expect(holder.previousElementSibling).toBe(alpha.settingEl);
    expect(holder.nextElementSibling).toBe(beta.settingEl);
    expect(section.holder("beta")).toBeNull();

    alpha.toggle.setValue(true);
    await vi.waitFor(() => {
      expect(options).toHaveBeenCalledExactlyOnceWith(holder);
    });
    expect(holder.style.display).toBe("");

    alpha.toggle.setValue(false);
    await vi.waitFor(() => {
      expect(holder.style.display).toBe("none");
    });

    alpha.toggle.setValue(true);
    await vi.waitFor(() => {
      expect(holder.style.display).toBe("");
    });
    expect(options).toHaveBeenCalledOnce();

    section.tab.dispose();
    expect(section.tab.containerEl.childElementCount).toBe(0);
  });

  it("an options drawer that throws does not break the section", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {}),
      failure = new Error("drawer failed"),
      options = vi.fn(() => {
        throw failure;
      }),
      section = await drawExperimentalSection([{ ...ALPHA, options }]),
      { settings } = section.context,
      alpha = section.row(0);
    alpha.toggle.setValue(true);
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledExactlyOnceWith(failure);
    });
    expect(() => {
      section.tab.update();
    }).not.toThrow();
    expect(options).toHaveBeenCalledOnce();
    expect(alpha.toggle.getValue()).toBe(true);

    alpha.toggle.setValue(false);
    await vi.waitFor(() => {
      expect(settings.value.experiments).toEqual({});
    });
  });

  it("a change made elsewhere is shown", async () => {
    const section = await drawExperimentalSection([
        { ...ALPHA, options: vi.fn() },
      ]),
      { settings } = section.context,
      alpha = section.row(0);
    expect(alpha.toggle.getValue()).toBe(false);
    await settings.mutate((settingsM) => {
      settingsM.experiments = fixExperiments({ alpha: true }, [ALPHA]);
    });
    section.tab.update();
    expect(alpha.toggle.getValue()).toBe(true);
    expect(section.holder("alpha")?.style.display).toBe("");
  });

  it("registers no experiment: program status on tabs is no longer one", async () => {
    const { rows, tab } = await drawExperimentalSection(null);
    expect(EXPERIMENTS).toHaveLength(0);
    expect(tab.containerEl.childElementCount).toBe(0);
    expect(rows).toHaveLength(0);
  });
});

describe("plugin Python status notifications", () => {
  afterEach(() => {
    clearWindowsPythonDiagnoses();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("coalesces both notification sources into one update per tick", async () => {
    capturePythonRows();
    const plugin = vi.spyOn(doctor, "onPluginPythonDiagnosis"),
      state = vi.spyOn(doctor, "onWindowsPythonStateChange"),
      context = await pythonSettingsContext(),
      tab = new PythonSettingTab(context, loadDocumentations(context));
    tab.renderPython();
    tab.display();
    const update = vi.spyOn(UpdatableUI.prototype, "update"),
      pluginNotification = plugin.mock.calls[0]?.[1],
      stateNotification = state.mock.calls[0]?.[0];
    if (!pluginNotification || !stateNotification)
      throw new Error("Missing Python subscriptions");
    try {
      stateNotification();
      stateNotification();
      pluginNotification();
      await Promise.resolve();
      expect(update).toHaveBeenCalledOnce();

      pluginNotification();
      stateNotification();
      await Promise.resolve();
      expect(update).toHaveBeenCalledTimes(2);
    } finally {
      tab.dispose();
    }
  });

  it.each(["undisplayed", "hidden", "disposed"])(
    "skips notification repaints when %s",
    async (state) => {
      capturePythonRows();
      const context = await pythonSettingsContext(),
        tab = new PythonSettingTab(context, loadDocumentations(context));
      tab.renderPython();
      if (state !== "undisplayed") tab.display();
      const update = vi.spyOn(UpdatableUI.prototype, "update");
      try {
        invalidateConPtyRuntime("python");
        if (state === "hidden") tab.hide();
        if (state === "disposed") tab.dispose();
        await Promise.resolve();
        expect(update).not.toHaveBeenCalled();
        invalidateConPtyRuntime("python");
        await Promise.resolve();
        expect(update).not.toHaveBeenCalled();
        if (state === "hidden") {
          tab.display();
          update.mockClear();
          invalidateConPtyRuntime("python");
          await Promise.resolve();
          expect(update).toHaveBeenCalledOnce();
        }
      } finally {
        tab.dispose();
      }
    },
  );
});

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

/**
 * A setting row as Obsidian builds it in the plugin's settings tab. Its elements
 * come from the main window, which also made the tab's container, wherever the
 * tab is shown. In Obsidian 1.14.4 the tab is shown in a Settings window.
 *
 * `setName` and `setDesc` call the `Element.prototype.setText` of the window
 * that made the element. It inserts a value that passes `instanceof
 * DocumentFragment || instanceof Node` and shows anything else as
 * `String(value)`. In Chromium a fragment of another window fails both tests.
 * happy-dom gives each window its own `DocumentFragment` but one shared `Node`,
 * so this row keeps only the first test, the one that tells windows apart here.
 */
class MainWindowRow extends Setting {
  public override readonly settingEl = document.createElement("div");
  public override readonly nameEl = document.createElement("div");
  public override readonly descEl = document.createElement("div");
  public override readonly controlEl = document.createElement("div");
  /** The extra button, kept across redraws as the real row keeps it. */
  public reset: ExtraButtonComponent | null = null;
  /** The dropdown, kept across redraws in the same way. */
  public dropdown: DropdownComponent | null = null;
  /** The options handed to the dropdown, in order. */
  public readonly dropdownOptions = new Map<string, string>();
  /** What the dropdown calls when the user chooses. */
  protected changed: ((value: string) => unknown) | null = null;

  public override setName(name: string | DocumentFragment): this {
    MainWindowRow.setText(this.nameEl, name);
    return this;
  }

  public override setDesc(desc: string | DocumentFragment): this {
    MainWindowRow.setText(this.descEl, desc);
    return this;
  }

  public override addButton(
    configure: (button: ButtonComponent) => unknown,
  ): this {
    configure(new ButtonComponent(this.settingEl));
    return this;
  }

  public override addExtraButton(
    configure: (button: ExtraButtonComponent) => unknown,
  ): this {
    this.reset ??= new ExtraButtonComponent(this.controlEl);
    configure(this.reset);
    return this;
  }

  public override addDropdown(
    configure: (dropdown: DropdownComponent) => unknown,
  ): this {
    if (!this.dropdown) {
      const dropdown = new DropdownComponent(this.controlEl),
        { dropdownOptions } = this,
        addOptions = dropdown.addOptions.bind(dropdown);
      // The mock keeps its options to itself; the row notes them too.
      vi.spyOn(dropdown, "addOptions").mockImplementation((options) => {
        for (const [value, display] of Object.entries(options)) {
          dropdownOptions.set(value, display);
        }
        return addOptions(options);
      });
      // As Obsidian's: setting the value is not a choice of the user's, and
      // calls nothing. The mock's would, and a redraw would choose again.
      vi.spyOn(dropdown, "onChange").mockImplementation((callback) => {
        this.changed = callback;
        return dropdown;
      });
      this.dropdown = dropdown;
    }
    configure(this.dropdown);
    return this;
  }

  /** The user chooses an option, as from the dropdown's list. */
  public choose(value: string): void {
    this.dropdown?.setValue(value);
    void this.changed?.(value);
  }

  protected static setText(element: HTMLElement, value: unknown): void {
    if (value instanceof DocumentFragment) {
      element.replaceChildren(value);
      return;
    }
    element.textContent = String(value);
  }
}

/** Runs the production row callbacks on {@link MainWindowRow}s. */
function captureMainWindowRows(): ReadonlyMap<string, MainWindowRow> {
  const rows = new Map<string, MainWindowRow>();
  vi.spyOn(UpdatableUI.prototype, "newSetting").mockImplementation(function (
    this: UpdatableUI,
    element,
    configure,
  ) {
    return this.new(
      () => {
        const row = new MainWindowRow(element);
        row.settingEl.append(row.nameEl, row.descEl, row.controlEl);
        element.append(row.settingEl);
        return row;
      },
      (row) => {
        configure(row);
        rows.set(row.nameEl.textContent, row);
      },
      (row) => {
        row.settingEl.remove();
      },
    );
  });
  return rows;
}

/** An iframe's document stands in for Obsidian's Settings window. */
function settingsWindowDocument(): Document {
  const { contentDocument } = document.body.appendChild(
    document.createElement("iframe"),
  );
  if (!contentDocument) throw new Error("iframe has no document");
  return contentDocument;
}

class LoadedSettingTab extends SettingTab {
  public load(): void {
    this.onLoad();
  }
  public update(): void {
    this.ui.update();
  }
  public dispose(): void {
    this.onUnload();
  }
  protected override newPythonWidgets(): void {
    // The Windows-only rows have their own tests above.
  }
}

describe("Undo under All settings after an import of older settings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  // The mock's button, which Obsidian's typings do not describe.
  interface MockButton {
    readonly click?: () => void;
    readonly getCta?: () => boolean;
    readonly getTooltip?: () => string;
  }

  const { keymappingDefaultsVersion: _version, ...unversioned } =
      Settings.DEFAULT,
    // Settings as a device on 3.29.0 saves them: no version of the built-in
    // keymappings, and Send to Obsidian turned to Ignore.
    saved329: unknown = JSON.parse(
      JSON.stringify({
        ...unversioned,
        keymappings: unversioned.keymappings.map((mapping) =>
          mapping.action === "sendToObsidian"
            ? { ...mapping, action: "ignore" }
            : mapping,
        ),
      }),
    ),
    json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

  it.each(["Reset", "an import of settings with a version"] as const)(
    "gives back settings without a version after %s, so the next start offers the built-in keymappings",
    async (change) => {
      const i18n = createInstance();
      await i18n.init({ lng: "en", resources: { en: { translation: en } } });
      captureMainWindowRows();
      const context = await pythonSettingsContext(),
        // The plugin's own manager, over data.json as this version saves it.
        settings = new TerminalSettingsManager(context, Settings.fix);
      Object.assign(context, {
        loadData: vi.fn().mockResolvedValue(json(Settings.DEFAULT)),
        localSettings: {
          value: LocalSettings.fix({ lastReadChangelogVersion: "0.0.0" }).value,
        },
        settings,
        version: null,
      });
      Object.assign(context.language, {
        onChangeLanguage: { listen: vi.fn().mockReturnValue(vi.fn()) },
        value: i18n,
      });
      vi.spyOn(settings, "write").mockResolvedValue();
      settings.load();
      await vi.waitFor(() => settings.value);
      // The buttons the tab draws, newest last; each redraw draws new ones.
      const buttons: MockButton[] = [];
      vi.spyOn(MainWindowRow.prototype, "addButton").mockImplementation(
        function (this: MainWindowRow, configure) {
          const button = new ButtonComponent(this.settingEl);
          configure(button);
          buttons.push(button as MockButton);
          return this;
        },
      );
      const button = (tooltip: string): MockButton | undefined =>
        buttons.findLast((drawn) => drawn.getTooltip?.() === tooltip);
      // Import settings from clipboard, as the command reads them.
      await settings.read(() => saved329);
      const before = settings.value;
      expect(before.keymappingDefaultsVersion).toBeUndefined();
      const tab = new LoadedSettingTab(context, loadDocumentations(context));
      document.body.append(tab.containerEl);
      try {
        tab.load();
        tab.display();
        if (change === "Reset") {
          button(i18n.t("settings.all-settings-actions.reset"))?.click?.();
        } else {
          // Settings that this version exported.
          await settings.read(() => json(Settings.DEFAULT));
        }
        await vi.waitFor(() => {
          expect(settings.value.keymappingDefaultsVersion).toBe(
            Settings.KEYMAPPING_DEFAULTS_VERSION,
          );
          expect(
            button(i18n.t("settings.all-settings-actions.undo"))?.getCta?.(),
          ).toBe(true);
        });
        button(i18n.t("settings.all-settings-actions.undo"))?.click?.();
        await vi.waitFor(() => {
          expect(settings.value.keymappings).toStrictEqual(before.keymappings);
        });
        // data.json as Undo leaves it. Without a version, the next start
        // offers the built-in keymappings again.
        expect(json(settings.value)).toStrictEqual(json(before));
      } finally {
        tab.dispose();
      }
    },
  );

  it("does not call onInvalidData or create a recovery entry when the editor resets settings restored by Undo", async () => {
    class ObservedSettingsManager extends TerminalSettingsManager {
      public override readonly onInvalidData = vi
        .fn(super.onInvalidData.bind(this))
        .mockName("onInvalidData");
    }

    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: en } } });
    const rows = captureMainWindowRows(),
      context = await pythonSettingsContext(),
      settings = new ObservedSettingsManager(context, Settings.fix),
      localSettings = {
        value: LocalSettings.fix({ lastReadChangelogVersion: "0.0.0" }).value,
        mutate: vi.fn(
          async (
            mutate: (
              value: ReturnType<typeof LocalSettings.fix>["value"],
            ) => unknown,
          ): Promise<void> => {
            await mutate(localSettings.value);
          },
        ),
        write: vi.fn().mockResolvedValue(undefined),
      };
    Object.assign(context, {
      loadData: vi.fn().mockResolvedValue(json(Settings.DEFAULT)),
      localSettings,
      settings,
      version: null,
    });
    Object.assign(context.language, {
      onChangeLanguage: { listen: vi.fn().mockReturnValue(vi.fn()) },
      value: i18n,
    });
    vi.spyOn(settings, "write").mockResolvedValue();
    vi.spyOn(console, "error").mockImplementation(() => {});
    settings.load();
    await settings.onLoaded;
    const buttons: MockButton[] = [];
    vi.spyOn(MainWindowRow.prototype, "addButton").mockImplementation(function (
      this: MainWindowRow,
      configure,
    ) {
      const button = new ButtonComponent(this.settingEl);
      configure(button);
      buttons.push(button as MockButton);
      return this;
    });
    const button = (tooltip: string): MockButton | undefined =>
        buttons.findLast((drawn) => drawn.getTooltip?.() === tooltip),
      open = vi.spyOn(EditDataModal.prototype, "open");
    await settings.read(() => saved329);
    const before = settings.value,
      tab = new LoadedSettingTab(context, loadDocumentations(context));
    expect(before).not.toHaveProperty("keymappingDefaultsVersion");
    expect(settings.onInvalidData).not.toHaveBeenCalled();
    expect(Object.keys(localSettings.value.recovery)).toHaveLength(0);
    document.body.append(tab.containerEl);
    try {
      tab.load();
      tab.display();
      button(i18n.t("settings.all-settings-actions.reset"))?.click?.();
      await vi.waitFor(() => {
        expect(settings.value.keymappingDefaultsVersion).toBe(
          Settings.KEYMAPPING_DEFAULTS_VERSION,
        );
        expect(
          button(i18n.t("settings.all-settings-actions.undo"))?.getCta?.(),
        ).toBe(true);
      });
      button(i18n.t("settings.all-settings-actions.undo"))?.click?.();
      await vi.waitFor(() => {
        expect(settings.value.keymappings).toStrictEqual(before.keymappings);
      });
      expect(settings.value.keymappingDefaultsVersion).toBeUndefined();
      button(i18n.t("settings.all-settings-actions.edit"))?.click?.();
      expect(open).toHaveBeenCalledOnce();
      const reset = rows.get(i18n.t("components.edit-data.data"))?.reset;
      expect(reset).not.toBeNull();
      expect(reset).toBeDefined();
      const mutate = vi.spyOn(settings, "mutate");
      reset?.extraSettingsEl.click();
      await vi.waitFor(() => {
        expect(mutate).toHaveBeenCalled();
      });
      await Promise.all(mutate.mock.results.map(({ value }): unknown => value));
      // Settle again to include any later-arriving mutation.
      await Promise.all(mutate.mock.results.map(({ value }): unknown => value));
      // The text-area mock is inert. Exercise the supplied fixer and the manager's
      // invalid-data path directly, preserving the own undefined property that a
      // JSON round trip would drop.
      expect(Settings.fix(settings.value).value).toStrictEqual(before);
      await settings.read(() => settings.value);
      expect.soft(settings.onInvalidData).toHaveBeenCalledTimes(0);
      expect.soft(Object.keys(localSettings.value.recovery)).toHaveLength(0);
    } finally {
      const modal = open.mock.contexts[0];
      if (modal instanceof EditDataModal) modal.close();
      tab.dispose();
      settings.unload();
    }
  });
});

describe("settings tab descriptions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("says which keys reach Obsidian while a terminal is focused", async () => {
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: en } } });
    const rows = captureMainWindowRows(),
      context = await pythonSettingsContext();
    Object.assign(context, {
      localSettings: {
        value: LocalSettings.fix({ lastReadChangelogVersion: "0.0.0" }).value,
      },
      version: null,
    });
    Object.assign(context.language, {
      onChangeLanguage: { listen: vi.fn().mockReturnValue(vi.fn()) },
      value: i18n,
    });
    const tab = new LoadedSettingTab(context, loadDocumentations(context)),
      description = (name: string): string | undefined =>
        rows.get(name)?.descEl.textContent;
    document.body.append(tab.containerEl);
    try {
      tab.load();
      expect(description(i18n.t("settings.intercept-keys-when-focused"))).toBe(
        `${i18n.t("settings.intercept-keys-when-focused-description")} Keys whose keymapping is 'Send to Obsidian' are the exception: Obsidian runs their hotkeys.`,
      );
      expect(description(i18n.t("settings.keymappings"))).toMatch(
        / The action 'Send to Obsidian' leaves the key to Obsidian, which runs its hotkey for it\. The built-in Ctrl\+P on Windows and Command\+P on macOS use it to open the command palette\.$/u,
      );
    } finally {
      tab.dispose();
    }
  });

  it.each(["main", "Settings"])(
    "renders the internal modules description in the %s window",
    async (where) => {
      const i18n = createInstance();
      await i18n.init({ lng: "en", resources: { en: { translation: en } } });
      const rows = captureMainWindowRows(),
        context = await pythonSettingsContext();
      Object.assign(context, {
        localSettings: {
          value: LocalSettings.fix({ lastReadChangelogVersion: "0.0.0" }).value,
        },
        version: null,
      });
      Object.assign(context.language, {
        onChangeLanguage: { listen: vi.fn().mockReturnValue(vi.fn()) },
        value: i18n,
      });
      const tab = new LoadedSettingTab(context, loadDocumentations(context)),
        shownIn = where === "main" ? document : settingsWindowDocument(),
        // The markup as the sanitizer leaves it: under happy-dom, DOMPurify
        // unwraps the first <code> of this text.
        expected = setSanitizedInnerHTML(
          document.createElement("span"),
          en.settings["expose-internal-modules-description-HTML"],
        ),
        codes = (root: ParentNode): readonly string[] =>
          Array.from(root.querySelectorAll("code"), (code) => code.textContent);
      expect(codes(expected)).not.toHaveLength(0);
      shownIn.body.append(tab.containerEl);
      try {
        tab.load();
        const { descEl } =
          rows.get(en.settings["expose-internal-modules"]) ?? {};
        expect(descEl?.textContent).toBe(expected.textContent);
        // The markup is shown as elements, not as its text alone. Checking the
        // elements' document would prove nothing: insertion adopts every node
        // into the description's document, wherever it was made.
        expect(descEl ? codes(descEl) : null).toEqual(codes(expected));
      } finally {
        tab.dispose();
      }
    },
  );

  it.each(["main", "Settings"])(
    "renders each experiment's description as elements in the %s window",
    async (where) => {
      const i18n = createInstance();
      await i18n.init({
        lng: "en",
        resources: { en: { asset, translation: en } },
      });
      const rows = captureMainWindowRows(),
        context = await pythonSettingsContext();
      Object.assign(context.language, { value: i18n });
      const tab = new ExperimentalSettingTab(
          context,
          loadDocumentations(context),
        ),
        shownIn = where === "main" ? document : settingsWindowDocument(),
        lines = (descEl?: HTMLElement): readonly string[] =>
          Array.from(
            descEl?.children ?? [],
            (line) => `${line.tagName} ${line.textContent}`,
          );
      shownIn.body.append(tab.containerEl);
      try {
        tab.draw([ALPHA, BETA]);
        const alpha = rows.get(ALPHA.name())?.descEl,
          beta = rows.get(BETA.name())?.descEl,
          feedback = en.settings["experimental-feedback"];
        expect(tab.containerEl.textContent).not.toContain(
          "[object DocumentFragment]",
        );
        // Alpha applies live, so it has no line on how a change applies.
        expect(lines(alpha)).toEqual([
          "DIV Alpha effect.",
          "DIV Known risk: Alpha risk.",
          `A ${feedback}`,
        ]);
        expect(lines(beta)).toEqual([
          "DIV Beta & <b>more</b> effect.",
          "DIV Known risk: Beta & <b>more</b> risk.",
          `DIV ${en.settings["experimental-applies"].restart}`,
          `A ${feedback}`,
        ]);
        expect(alpha?.querySelector("a")?.getAttribute("href")).toBe(
          ALPHA.feedback,
        );
        expect(beta?.querySelector("a")?.getAttribute("href")).toBe(
          BETA.feedback,
        );
      } finally {
        tab.dispose();
      }
    },
  );
});

/**
 * The whole settings tab, with this device's store `local` (`null`: a fresh
 * one). `edit` presses the Edit button of Profiles and returns what the
 * profile list was opened with.
 */
async function drawProfiles(initial: unknown, local: unknown = null) {
  const i18n = await createI18n(
    PluginLocales.RESOURCES,
    PluginLocales.FORMATTERS,
    { lng: "en", fallbackLng: "en" },
  );
  const rows = captureMainWindowRows(),
    context = await pythonSettingsContext(initial);
  Object.assign(context, { version: null });
  Object.assign(context.localSettings, {
    value: LocalSettings.fix(local).value,
  });
  Object.assign(context.language, {
    onChangeLanguage: { listen: vi.fn().mockReturnValue(vi.fn()) },
    value: i18n,
  });
  // The value is stored as given; the next start's fixer is the test's.
  vi.spyOn(context.settings, "mutate").mockImplementation(async (mutate) => {
    const value = cloneAsWritable(context.settings.value);
    await mutate(value);
    Object.assign(context.settings, { value });
  });
  // The button of each row, kept as the row keeps it.
  const buttons = new Map<MainWindowRow, ButtonComponent>();
  vi.spyOn(MainWindowRow.prototype, "addButton").mockImplementation(function (
    this: MainWindowRow,
    configure,
  ) {
    const button = buttons.get(this) ?? new ButtonComponent(this.settingEl);
    buttons.set(this, button);
    configure(button);
    return this;
  });
  const addOption = vi.spyOn(DropdownComponent.prototype, "addOption"),
    write = vi.spyOn(context.settings, "write"),
    writeLocal = vi.spyOn(context.localSettings, "write"),
    tab = new LoadedSettingTab(context, loadDocumentations(context));
  document.body.append(tab.containerEl);
  tab.load();
  const named = (name: string): MainWindowRow => {
      const row = rows.get(name);
      if (!row) throw new Error(`Missing row ${name}`);
      return row;
    },
    profilesRow = named(i18n.t("settings.profiles")),
    defaultRow = named(i18n.t("settings.default-profile")),
    { reset } = profilesRow;
  if (!reset) throw new Error("Missing profiles reset button");
  return {
    context,
    defaultRow,
    reset,
    tab,
    write,
    writeLocal,
    /** The options of the Default profile row as last drawn, in order. */
    defaultOptions: (): [string, string][] => {
      const drawn = addOption.mock.calls.filter(
        (_call, index) =>
          addOption.mock.contexts[index] === defaultRow.dropdown,
      );
      return drawn
        .slice(drawn.findLastIndex(([value]) => value === ""))
        .map(([value, display]) => [value, display]);
    },
    edit: () => {
      // The mock's click; Obsidian's button has none.
      (
        buttons.get(profilesRow) as { click?: () => void } | undefined
      )?.click?.();
      const opened = profileLists.at(-1);
      if (!opened) throw new Error("Profile list did not open");
      return {
        data: opened.data,
        // As the list modal: each edit sends copies of its profiles.
        send: async (data: ProfileListModal.Data) =>
          opened.callback(cloneAsWritable(data)),
      };
    },
    /** data.json as the next start reads it. */
    nextStart: () =>
      Settings.fix(JSON.parse(JSON.stringify(context.settings.value))),
  };
}

describe("default profile after profile list edits", () => {
  afterEach(() => {
    profileLists.length = 0;
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  // data.json with one of the user's own profiles as the default.
  const custom = {
    defaultProfile: "mine",
    profiles: {
      mine: { ...Settings.Profile.DEFAULTS.integrated, name: "Mine" },
      other: { ...Settings.Profile.DEFAULTS.integrated, name: "Other" },
    },
  };

  it("clears the default profile when the profile list deletes it", async () => {
    const { context, edit, nextStart, tab } = await drawProfiles(custom);
    try {
      const { data, send } = edit();
      await send({
        defaultProfile: data.defaultProfile,
        entries: data.entries.filter(([id]) => id !== "mine"),
      });
      expect(context.settings.value.defaultProfile).toBeNull();
      expect(nextStart().valid).toBe(true);
    } finally {
      tab.dispose();
    }
  });

  it("keeps it cleared when the same list sends its next edit", async () => {
    const { context, edit, nextStart, tab } = await drawProfiles(custom);
    try {
      const { data, send } = edit();
      // The list modal keeps sending the default it was opened with.
      const [, other] = data.entries.find(([id]) => id === "other") ?? [];
      if (!other) throw new Error("Missing profile other");
      await send({
        defaultProfile: data.defaultProfile,
        entries: [["other", other]],
      });
      await send({
        defaultProfile: data.defaultProfile,
        entries: [["other", { ...other, name: "Renamed" }]],
      });
      expect(context.settings.value.profiles["other"]?.name).toBe("Renamed");
      expect(context.settings.value.defaultProfile).toBeNull();
      expect(nextStart().valid).toBe(true);
    } finally {
      tab.dispose();
    }
  });

  it("keeps the default profile when the list deletes another one", async () => {
    const { context, edit, nextStart, tab } = await drawProfiles(custom);
    try {
      const { data, send } = edit();
      await send({
        defaultProfile: data.defaultProfile,
        entries: data.entries.filter(([id]) => id !== "other"),
      });
      expect(context.settings.value.defaultProfile).toBe("mine");
      expect(nextStart().valid).toBe(true);
    } finally {
      tab.dispose();
    }
  });

  it("clears the default profile when Reset removes it", async () => {
    const { context, nextStart, reset, tab } = await drawProfiles(custom);
    try {
      reset.extraSettingsEl.click();
      await vi.waitFor(() => {
        expect(context.settings.value.profiles).not.toHaveProperty("mine");
      });
      expect(context.settings.value.defaultProfile).toBeNull();
      expect(nextStart().valid).toBe(true);
    } finally {
      tab.dispose();
    }
  });

  it("keeps a preset default that Reset brings back", async () => {
    const { context, nextStart, reset, tab } = await drawProfiles({
      defaultProfile: "linuxIntegratedDefault",
      profiles: {
        ...custom.profiles,
        linuxIntegratedDefault:
          Settings.DEFAULT.profiles["linuxIntegratedDefault"],
      },
    });
    try {
      reset.extraSettingsEl.click();
      await vi.waitFor(() => {
        expect(context.settings.value.profiles).not.toHaveProperty("mine");
      });
      expect(context.settings.value.defaultProfile).toBe(
        "linuxIntegratedDefault",
      );
      expect(nextStart().valid).toBe(true);
    } finally {
      tab.dispose();
    }
  });
});

describe("default profile and profile order of this device", () => {
  beforeEach(() => {
    platform.current = "darwin";
  });
  afterEach(() => {
    platform.current = null;
    profileLists.length = 0;
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  const integrated = Settings.Profile.DEFAULTS.integrated,
    // data.json as a Windows device that chose pwsh last wrote it; this
    // device is a Mac.
    synced = {
      defaultProfile: "pwsh",
      profiles: {
        pwsh: { ...integrated, name: "pwsh", platforms: { win32: true } },
        zsh: { ...integrated, name: "zsh", platforms: { darwin: true } },
        bash: { ...integrated, name: "bash", platforms: { darwin: true } },
      },
    };

  it("does not show a default that another device chose", async () => {
    const { defaultRow, tab } = await drawProfiles(synced);
    try {
      expect(defaultRow.dropdown?.getValue()).toBe("");
    } finally {
      tab.dispose();
    }
  });

  it("keeps the default in data.json when this device chooses its own", async () => {
    const { context, defaultRow, tab, write } = await drawProfiles(synced);
    try {
      defaultRow.choose("zsh");
      await vi.waitFor(() => {
        expect([
          context.settings.value.defaultProfile,
          context.localSettings.value.defaultProfile,
        ]).toContain("zsh");
      });
      // The Windows device still finds its pwsh in data.json.
      expect(context.settings.value.defaultProfile).toBe("pwsh");
      expect(context.localSettings.value.defaultProfile).toBe("zsh");
      expect(write).not.toHaveBeenCalled();
    } finally {
      tab.dispose();
    }
  });

  it("keeps the key order of data.json when this device reorders", async () => {
    const { context, edit, tab } = await drawProfiles(synced);
    try {
      const { data, send } = edit();
      await send({
        defaultProfile: data.defaultProfile,
        entries: [...data.entries].reverse(),
      });
      expect(Object.keys(context.settings.value.profiles)).toEqual([
        "pwsh",
        "zsh",
        "bash",
      ]);
      expect(context.localSettings.value.profileOrder).toEqual([
        "bash",
        "zsh",
        "pwsh",
      ]);
    } finally {
      tab.dispose();
    }
  });

  it("does not save data.json after a move, and redraws the default profile options in the new order", async () => {
    const { defaultOptions, edit, tab, write, writeLocal } =
      await drawProfiles(synced);
    try {
      expect(defaultOptions().map(([id]) => id)).toEqual([
        "",
        "pwsh",
        "zsh",
        "bash",
      ]);
      const { data, send } = edit();
      await send({
        defaultProfile: data.defaultProfile,
        entries: [...data.entries].reverse(),
      });
      expect(write).not.toHaveBeenCalled();
      expect(writeLocal).toHaveBeenCalledTimes(1);
      expect(defaultOptions()).toEqual([
        ["", "(Unselected)"],
        ["bash", "Integrated: bash"],
        ["zsh", "Integrated: zsh"],
        ["pwsh", "(Incompatible) Integrated: pwsh"],
      ]);
    } finally {
      tab.dispose();
    }
  });

  it("adds a new profile at the end of data.json, which keeps the keys it had", async () => {
    const { context, edit, tab, write } = await drawProfiles(synced),
      keys = Object.keys(context.settings.value);
    try {
      const { data, send } = edit();
      await send({
        defaultProfile: data.defaultProfile,
        entries: [["new", { ...integrated, name: "new" }], ...data.entries],
      });
      expect(write).toHaveBeenCalledTimes(1);
      expect(Object.keys(context.settings.value)).toEqual(keys);
      expect(Object.keys(context.settings.value.profiles)).toEqual([
        "pwsh",
        "zsh",
        "bash",
        "new",
      ]);
      expect(context.settings.value.defaultProfile).toBe("pwsh");
      expect(context.localSettings.value.profileOrder).toEqual([
        "new",
        "pwsh",
        "zsh",
        "bash",
      ]);
    } finally {
      tab.dispose();
    }
  });

  it("drops a deleted profile from data.json and from this device's order", async () => {
    const { context, edit, nextStart, tab } = await drawProfiles(synced, {
      lastReadChangelogVersion: "0.0.0",
      profileOrder: ["bash", "zsh", "pwsh"],
    });
    try {
      const { data, send } = edit();
      await send({
        defaultProfile: data.defaultProfile,
        entries: data.entries.filter(([id]) => id !== "zsh"),
      });
      expect(Object.keys(context.settings.value.profiles)).toEqual([
        "pwsh",
        "bash",
      ]);
      expect(context.localSettings.value.profileOrder).toEqual([
        "bash",
        "pwsh",
      ]);
      expect(nextStart().valid).toBe(true);
    } finally {
      tab.dispose();
    }
  });

  it("stores a default marked in the profile list on this device only", async () => {
    const { context, edit, tab, write } = await drawProfiles(synced);
    try {
      const { data, send } = edit();
      await send({
        defaultProfile: "bash" as Settings.DefaultProfile,
        entries: data.entries,
      });
      expect(context.localSettings.value.defaultProfile).toBe("bash");
      expect(context.settings.value.defaultProfile).toBe("pwsh");
      expect(write).not.toHaveBeenCalled();
    } finally {
      tab.dispose();
    }
  });

  it("clears this device's default when the list deletes it, and on the list's next edit", async () => {
    const { context, edit, tab } = await drawProfiles(synced, {
      lastReadChangelogVersion: "0.0.0",
      defaultProfile: "zsh",
    });
    try {
      const { data, send } = edit();
      expect(data.defaultProfile).toBe("zsh");
      const without = data.entries.filter(([id]) => id !== "zsh");
      await send({ defaultProfile: data.defaultProfile, entries: without });
      expect(context.localSettings.value.defaultProfile).toBeNull();
      // The list modal keeps sending the default it was opened with.
      await send({
        defaultProfile: data.defaultProfile,
        entries: [...without].reverse(),
      });
      expect(context.localSettings.value.defaultProfile).toBeNull();
    } finally {
      tab.dispose();
    }
  });

  it("brings back data.json with Undo after the list deletes a profile, but not this device's choice", async () => {
    const { context, defaultOptions, defaultRow, edit, tab } =
      await drawProfiles(synced, {
        lastReadChangelogVersion: "0.0.0",
        defaultProfile: "zsh",
        profileOrder: ["bash", "zsh", "pwsh"],
      });
    try {
      // Undo under All settings goes back to data.json as the tab showed it;
      // it learns of changes from the settings store, as in the library.
      type Listener = readonly [
        (value: Settings) => unknown,
        (cur: unknown, prev: unknown, value: Settings) => unknown,
      ];
      const listeners: Listener[] = [];
      vi.spyOn(context.settings, "onMutate").mockImplementation(
        (accessor, callback) => {
          const listener: Listener = [accessor, callback];
          listeners.push(listener);
          return () => {
            listeners.splice(listeners.indexOf(listener), 1);
          };
        },
      );
      vi.spyOn(context.settings, "mutate").mockImplementation(
        async (mutate) => {
          const prev = context.settings.value,
            value = cloneAsWritable(prev);
          await mutate(value);
          Object.assign(context.settings, { value });
          for (const [accessor, callback] of [...listeners]) {
            const before = accessor(prev),
              after = accessor(value);
            if (JSON.stringify(before) !== JSON.stringify(after)) {
              await callback(after, before, value);
            }
          }
        },
      );
      // The mock's button, which Obsidian's typings do not describe.
      interface MockButton {
        readonly click?: () => void;
        readonly getCta?: () => boolean;
        readonly getTooltip?: () => string;
      }
      const undoTooltip = context.language.value.t(
          "settings.all-settings-actions.undo",
        ),
        undoButtons: MockButton[] = [];
      vi.spyOn(MainWindowRow.prototype, "addButton").mockImplementation(
        function (this: MainWindowRow, configure) {
          const button = new ButtonComponent(this.settingEl),
            mock = button as MockButton;
          configure(button);
          if (mock.getTooltip?.() === undoTooltip) undoButtons.push(mock);
          return this;
        },
      );
      tab.display();
      const { data, send } = edit();
      await send({
        defaultProfile: data.defaultProfile,
        entries: data.entries.filter(([id]) => id !== "zsh"),
      });
      expect(defaultRow.dropdown?.getValue()).toBe("");
      const undo = undoButtons.at(-1);
      await vi.waitFor(() => {
        expect(undo?.getCta?.()).toBe(true);
      });
      undo?.click?.();
      await vi.waitFor(() => {
        expect(Object.keys(context.settings.value.profiles)).toEqual([
          "pwsh",
          "zsh",
          "bash",
        ]);
      });
      expect(context.settings.value.defaultProfile).toBe("pwsh");
      // Undo covers data.json only. This device's default and order stay as
      // the deletion left them, so the profile comes back after the ones
      // this device ordered, and is not its default.
      expect(context.localSettings.value).toMatchObject({
        defaultProfile: null,
        profileOrder: ["bash", "pwsh"],
      });
      expect(defaultRow.dropdown?.getValue()).toBe("");
      expect(defaultOptions().map(([id]) => id)).toEqual([
        "",
        "bash",
        "pwsh",
        "zsh",
      ]);
    } finally {
      tab.dispose();
    }
  });

  it("keeps data.json in its order through a series of edits in one list", async () => {
    const { context, edit, tab } = await drawProfiles(synced);
    try {
      const { data, send } = edit(),
        [pwsh, zsh, bash] = data.entries;
      if (!pwsh || !zsh || !bash) throw new Error("Missing profiles");
      const added = ["new", { ...integrated, name: "new" }] as const;
      for (const entries of [
        [zsh, pwsh, bash],
        [bash, zsh, pwsh],
        [bash, pwsh],
        [added, bash, pwsh],
      ]) {
        await send({ defaultProfile: data.defaultProfile, entries });
      }
      expect(Object.keys(context.settings.value.profiles)).toEqual([
        "pwsh",
        "bash",
        "new",
      ]);
      expect(context.localSettings.value.profileOrder).toEqual([
        "new",
        "bash",
        "pwsh",
      ]);
    } finally {
      tab.dispose();
    }
  });

  it("opens the profile list in this device's order, with this device's default", async () => {
    const { edit, tab } = await drawProfiles(synced, {
      lastReadChangelogVersion: "0.0.0",
      defaultProfile: "bash",
      profileOrder: ["bash", "constructor", "__proto__", "pwsh"],
    });
    try {
      const { data } = edit();
      expect(data.defaultProfile).toBe("bash");
      expect(data.entries.map(([id]) => id)).toEqual(["bash", "pwsh", "zsh"]);
    } finally {
      tab.dispose();
    }
  });

  it("reads a store that 3.29.0 wrote as no choice, in the order of data.json", async () => {
    const { defaultOptions, defaultRow, edit, tab } = await drawProfiles(
      synced,
      { lastReadChangelogVersion: "0.0.0" },
    );
    try {
      expect(defaultRow.dropdown?.getValue()).toBe("");
      expect(defaultOptions().map(([id]) => id)).toEqual([
        "",
        "pwsh",
        "zsh",
        "bash",
      ]);
      const { data } = edit();
      expect(data.defaultProfile).toBeNull();
      expect(data.entries.map(([id]) => id)).toEqual(["pwsh", "zsh", "bash"]);
    } finally {
      tab.dispose();
    }
  });

  it("shows the placeholder when this device's default was deleted on another device", async () => {
    const { defaultRow, tab } = await drawProfiles(synced, {
      lastReadChangelogVersion: "0.0.0",
      defaultProfile: "gone",
    });
    try {
      expect(defaultRow.dropdown?.getValue()).toBe("");
    } finally {
      tab.dispose();
    }
  });

  it("shows this device's default when it does not run here", async () => {
    const { defaultRow, tab } = await drawProfiles(synced, {
      lastReadChangelogVersion: "0.0.0",
      defaultProfile: "pwsh",
    });
    try {
      // Edited on another device to run only on Windows.
      expect(defaultRow.dropdown?.getValue()).toBe("pwsh");
    } finally {
      tab.dispose();
    }
  });

  it("keeps this device's order of ids such as 2 and 10", async () => {
    const { defaultOptions, tab } = await drawProfiles(
      {
        profiles: {
          10: { ...integrated, name: "ten" },
          2: { ...integrated, name: "two" },
        },
      },
      { lastReadChangelogVersion: "0.0.0", profileOrder: ["10", "2"] },
    );
    try {
      expect(defaultOptions().map(([id]) => id)).toEqual(["", "10", "2"]);
    } finally {
      tab.dispose();
    }
  });

  it("stores nothing for a value it does not offer", async () => {
    const { context, defaultRow, tab } = await drawProfiles(synced);
    try {
      defaultRow.choose("constructor");
      await vi.waitFor(() => {
        expect(defaultRow.dropdown?.getValue()).toBe("");
      });
      expect(context.localSettings.value.defaultProfile).toBeNull();
    } finally {
      tab.dispose();
    }
  });

  it("resets this device's default only", async () => {
    const { context, defaultRow, tab, write, writeLocal } = await drawProfiles(
      synced,
      { lastReadChangelogVersion: "0.0.0", defaultProfile: "zsh" },
    );
    try {
      defaultRow.reset?.extraSettingsEl.click();
      await vi.waitFor(() => {
        expect(context.localSettings.value.defaultProfile).toBeNull();
      });
      expect(defaultRow.dropdown?.getValue()).toBe("");
      expect(context.settings.value.defaultProfile).toBe("pwsh");
      expect(write).not.toHaveBeenCalled();
      expect(writeLocal).toHaveBeenCalledTimes(1);
    } finally {
      tab.dispose();
    }
  });

  it("keeps data.json as a device on 3.29.0 reads it through every edit, and saves it only when it changed", async () => {
    const { context, defaultRow, edit, nextStart, reset, tab, write } =
      await drawProfiles(synced, {
        lastReadChangelogVersion: "0.0.0",
        defaultProfile: "zsh",
      });
    try {
      const keys = Object.keys(context.settings.value).sort();
      let saved = JSON.stringify(context.settings.value),
        writes = 0;
      const check = (step: string, changes: boolean): void => {
          const now = JSON.stringify(context.settings.value);
          expect([step, now !== saved]).toEqual([step, changes]);
          // The fixer of 3.29.0 finds nothing to change.
          expect([step, nextStart().valid]).toEqual([step, true]);
          expect([step, Object.keys(context.settings.value).sort()]).toEqual([
            step,
            keys,
          ]);
          if (now !== saved) writes += 1;
          saved = now;
          expect([step, write.mock.calls.length]).toEqual([step, writes]);
        },
        sendList = async (
          change: (
            data: ProfileListModal.Data,
          ) => Partial<ProfileListModal.Data>,
        ): Promise<void> => {
          const { data, send } = edit();
          await send({ ...data, ...change(data) });
        };
      defaultRow.choose("bash");
      await vi.waitFor(() => {
        expect(context.localSettings.value.defaultProfile).toBe("bash");
      });
      check("choose a default", false);
      defaultRow.reset?.extraSettingsEl.click();
      await vi.waitFor(() => {
        expect(context.localSettings.value.defaultProfile).toBeNull();
      });
      check("reset the default", false);
      await sendList(({ entries }) => ({ entries: [...entries].reverse() }));
      check("move", false);
      await sendList(() => ({
        defaultProfile: "zsh" as Settings.DefaultProfile,
      }));
      check("mark as default", false);
      await sendList(({ entries }) => ({
        entries: entries.map(([id, profile]) => [
          id,
          id === "bash" ? { ...profile, name: "Bash" } : profile,
        ]),
      }));
      check("rename", true);
      await sendList(({ entries }) => ({
        entries: [["fish", { ...integrated, name: "fish" }], ...entries],
      }));
      check("add", true);
      await sendList(({ entries }) => ({
        entries: entries.filter(([id]) => id !== "pwsh"),
      }));
      check("delete the default of data.json", true);
      expect(context.settings.value.defaultProfile).toBeNull();
      reset.extraSettingsEl.click();
      await vi.waitFor(() => {
        expect(context.settings.value.profiles).toEqual(
          Settings.DEFAULT.profiles,
        );
      });
      check("reset the profiles", true);
      expect(writes).toBe(4);
    } finally {
      tab.dispose();
    }
  });

  it.each([
    ["zsh", null],
    ["darwinIntegratedDefault", "darwinIntegratedDefault"],
  ])(
    "resets the profiles, this device's order and its default %s (kept: %s)",
    async (defaultProfile, kept) => {
      const { context, reset, tab, write } = await drawProfiles(
        {
          ...synced,
          profiles: {
            ...synced.profiles,
            darwinIntegratedDefault:
              Settings.DEFAULT.profiles["darwinIntegratedDefault"],
          },
        },
        {
          lastReadChangelogVersion: "0.0.0",
          defaultProfile,
          profileOrder: ["bash", "darwinIntegratedDefault"],
        },
      );
      try {
        reset.extraSettingsEl.click();
        await vi.waitFor(() => {
          expect(context.localSettings.value.profileOrder).toEqual([]);
        });
        expect(context.localSettings.value.defaultProfile).toBe(kept);
        expect(Object.keys(context.settings.value.profiles)).toEqual(
          Object.keys(Settings.DEFAULT.profiles),
        );
        // pwsh is gone, so data.json's default is too.
        expect(context.settings.value.defaultProfile).toBeNull();
        expect(write).toHaveBeenCalledTimes(1);
      } finally {
        tab.dispose();
      }
    },
  );
});

describe("program status row", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  /** The whole settings tab, drawn as Obsidian draws it. */
  async function drawSettingsTab(initial: Settings.TabStatus = "none") {
    const i18n = createInstance();
    await i18n.init({
      lng: "en",
      resources: { en: { asset, translation: en } },
    });
    const rows = captureMainWindowRows(),
      context = await pythonSettingsContext();
    Object.assign(context, {
      localSettings: {
        value: LocalSettings.fix({ lastReadChangelogVersion: "0.0.0" }).value,
      },
      version: null,
    });
    Object.assign(context.language, {
      onChangeLanguage: { listen: vi.fn().mockReturnValue(vi.fn()) },
      value: i18n,
    });
    // The fixer's round trip of the value is the settings data's to test.
    vi.spyOn(context.settings, "mutate").mockImplementation(async (mutate) => {
      const value = cloneAsWritable(context.settings.value);
      await mutate(value);
      Object.assign(context.settings, { value });
    });
    await context.settings.mutate((settingsM) => {
      settingsM.tabStatus = initial;
    });
    const write = vi.spyOn(context.settings, "write");
    const tab = new LoadedSettingTab(context, loadDocumentations(context));
    document.body.append(tab.containerEl);
    tab.load();
    const named = (name: string): MainWindowRow => {
        const row = rows.get(name);
        if (!row) throw new Error(`Missing row ${name}`);
        return row;
      },
      row = named(i18n.t("settings.tab-status")),
      { dropdown, reset } = row;
    if (!reset) throw new Error("Missing reset button");
    if (!dropdown) throw new Error("Missing dropdown");
    return { context, dropdown, i18n, named, reset, row, rows, tab, write };
  }

  it("is in the Interface section, right after Show terminal tab prefix", async () => {
    const { i18n, named, row, tab } = await drawSettingsTab();
    try {
      expect(row.settingEl.previousElementSibling).toBe(
        named(i18n.t("settings.show-terminal-tab-prefix")).settingEl,
      );
      let heading = row.settingEl.previousElementSibling;
      while (heading && heading.tagName !== "H2") {
        heading = heading.previousElementSibling;
      }
      expect(heading?.textContent).toBe(en.settings.interface);
    } finally {
      tab.dispose();
    }
  });

  it("has its name and a one-sentence description that names OSC 7501", async () => {
    const { row, tab } = await drawSettingsTab();
    try {
      expect(row.nameEl.textContent).toBe("Program status");
      expect(row.descEl.textContent).toBe(
        "Marks on terminal tab icons for programs that report OSC 7501: working, needs input, finished, error.",
      );
    } finally {
      tab.dispose();
    }
  });

  it("offers None, Still and Animated in a dropdown, in that order, with the reset button", async () => {
    const { dropdown, row, tab } = await drawSettingsTab();
    try {
      expect([...row.dropdownOptions]).toEqual([
        ["none", "None"],
        ["still", "Still"],
        ["animated", "Animated"],
      ]);
      expect(dropdown.getValue()).toBe("none");
      expect(row.reset?.extraSettingsEl.parentElement).toBe(row.controlEl);
    } finally {
      tab.dispose();
    }
  });

  it("shows the stored value", async () => {
    const { dropdown, tab } = await drawSettingsTab("animated");
    try {
      expect(dropdown.getValue()).toBe("animated");
    } finally {
      tab.dispose();
    }
  });

  it.each(["still", "animated", "none"] as const)(
    "stores %s when it is chosen, and saves",
    async (value) => {
      const initial = value === "none" ? "still" : "none",
        { context, row, tab, write } = await drawSettingsTab(initial);
      try {
        row.choose(value);
        await vi.waitFor(() => {
          expect(context.settings.value.tabStatus).toBe(value);
          expect(write).toHaveBeenCalled();
        });
      } finally {
        tab.dispose();
      }
    },
  );

  it("stores nothing for a value it does not offer", async () => {
    const { context, dropdown, row, tab } = await drawSettingsTab("still");
    try {
      row.choose("loop");
      await vi.waitFor(() => {
        expect(dropdown.getValue()).toBe("still");
      });
      expect(context.settings.value.tabStatus).toBe("still");
    } finally {
      tab.dispose();
    }
  });

  it("resets to Animated, the default", async () => {
    const { context, dropdown, reset, tab } = await drawSettingsTab("none");
    try {
      expect(Settings.DEFAULT.tabStatus).toBe("animated");
      reset.extraSettingsEl.click();
      await vi.waitFor(() => {
        expect(context.settings.value.tabStatus).toBe("animated");
        expect(dropdown.getValue()).toBe("animated");
      });
    } finally {
      tab.dispose();
    }
  });

  it("follows a change made elsewhere on the next redraw", async () => {
    const { context, dropdown, tab } = await drawSettingsTab();
    try {
      await context.settings.mutate((settingsM) => {
        settingsM.tabStatus = "still";
      });
      tab.update();
      expect(dropdown.getValue()).toBe("still");
    } finally {
      tab.dispose();
    }
  });

  it("draws no icon, no tile, no preview strip, no icon set, size or motion picker and no experimental intro", async () => {
    const { row, rows, tab } = await drawSettingsTab(),
      { containerEl } = tab;
    try {
      for (const selector of [
        ".tts-strip",
        ".tts-pick",
        ".tts-host",
        '[role="radiogroup"]',
      ]) {
        expect(containerEl.querySelectorAll(selector), selector).toHaveLength(
          0,
        );
      }
      expect(row.settingEl.querySelectorAll("svg")).toHaveLength(0);
      for (const name of ["Terminal icon", "Icon size", "Motion"]) {
        expect(rows.has(name), name).toBe(false);
      }
      expect(containerEl.textContent).not.toContain("These features");
      // An empty registry draws no Experimental section at all.
      expect(
        Array.from(containerEl.querySelectorAll("h2"), (h2) => h2.textContent),
      ).not.toContain(en.settings.experimental);
    } finally {
      tab.dispose();
    }
  });
});
