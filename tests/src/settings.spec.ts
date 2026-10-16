import {
  Platform,
  UpdatableUI,
  cloneAsWritable,
  setSanitizedInnerHTML,
} from "@polyipseity/obsidian-plugin-library";
import { createInstance } from "i18next";
import {
  ButtonComponent,
  ExtraButtonComponent,
  Setting,
  ToggleComponent,
} from "obsidian";
import * as doctor from "../../src/terminal/win32-doctor.js";
import { SettingTab } from "../../src/settings.js";
import { loadDocumentations } from "../../src/documentations.js";
import {
  EXPERIMENTS,
  type Experiment,
  fixExperiments,
} from "../../src/experiments.js";
import { LocalSettings, Settings } from "../../src/settings-data.js";
import {
  capturePythonRows,
  pythonSettingsContext,
  typePythonValue,
  withPythonSpare,
} from "../fixtures/python-settings-ui.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../../src/modals.js", () => ({}));

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
    platform.current = null;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("draws nothing when there are no experiments", async () => {
    const { rows, tab } = await drawExperimentalSection([]);
    expect(tab.containerEl.childElementCount).toBe(0);
    expect(rows).toHaveLength(0);
  });

  it("draws the heading, the intro and one row per experiment in order", async () => {
    const { rows, tab } = await drawExperimentalSection([ALPHA, BETA]),
      children = Array.from(tab.containerEl.children),
      [heading, intro, alpha, beta] = children;
    expect(children).toHaveLength(4);
    expect(heading?.tagName).toBe("H2");
    expect(heading?.textContent).toBe(en.settings.experimental);
    expect(intro?.tagName).toBe("DIV");
    expect(intro?.classList.contains("setting-item")).toBe(true);
    expect(intro?.textContent).toBe(en.settings["experimental-description"]);
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
    // The heading, the intro and the two rows, as when the rows are given.
    expect(
      Array.from(
        tab.containerEl.children,
        (child) => child.getAttribute("data-experiment") ?? child.tagName,
      ),
    ).toEqual(["H2", "DIV", "alpha", "beta"]);
  });

  it.each(Platform.ALL)(
    "draws the registered experiments offered on %s when it is given no rows",
    async (current) => {
      platform.current = current;
      const registered: readonly Experiment[] = EXPERIMENTS,
        offered = registered.filter(
          ({ platforms }) => platforms?.includes(current) ?? true,
        ),
        { tab } = await drawExperimentalSection(null),
        drawn = tab.containerEl.querySelectorAll("[data-experiment]");
      // No heading and no description where no experiment is offered.
      expect(tab.containerEl.querySelectorAll("h2")).toHaveLength(
        Math.min(offered.length, 1),
      );
      expect(tab.containerEl.childElementCount === 0).toBe(
        offered.length === 0,
      );
      expect(
        Array.from(drawn, (row) => row.getAttribute("data-experiment")),
      ).toEqual(offered.map(({ id }) => id));
    },
  );

  it("draws the Windows Terminal console host row on Windows", async () => {
    platform.current = "win32";
    const section = await drawExperimentalSection(null),
      row = section.row(0);
    try {
      expect(section.rows).toHaveLength(1);
      expect(row.settingEl.getAttribute("data-experiment")).toBe(
        "windowsTerminalConsoleHost",
      );
      expect(row.nameEl.textContent).toBe("Windows Terminal console host");
      expect(
        Array.from(row.descEl.children, (line) => line.textContent),
      ).toEqual([
        en.settings["experimental-features"].windowsTerminalConsoleHost.effect,
        `Known risk: ${en.settings["experimental-features"].windowsTerminalConsoleHost.risk}`,
        en.settings["experimental-applies"].newTerminals,
        en.settings["experimental-feedback"],
      ]);
      expect(row.descEl.querySelector("a")?.getAttribute("href")).toBe(
        "https://github.com/polyipseity/obsidian-terminal/issues",
      );
      expect(row.toggle.getValue()).toBe(false);
      row.toggle.setValue(true);
      await vi.waitFor(() => {
        expect(section.context.settings.value.experiments).toEqual({
          windowsTerminalConsoleHost: true,
        });
      });
    } finally {
      section.tab.dispose();
    }
  });

  it("draws only the rows offered on this platform", async () => {
    platform.current = "linux";
    const { rows, tab } = await drawExperimentalSection([
      { ...ALPHA, platforms: ["win32"] },
      { ...BETA, platforms: ["darwin", "linux"] },
    ]);
    expect(
      Array.from(
        tab.containerEl.children,
        (child) => child.getAttribute("data-experiment") ?? child.tagName,
      ),
    ).toEqual(["H2", "DIV", "beta"]);
    expect(rows.map((row) => row.nameEl.textContent)).toEqual([BETA.name()]);
  });

  it("draws no heading and no description when no row is offered here", async () => {
    platform.current = "darwin";
    const { rows, tab } = await drawExperimentalSection([
      { ...ALPHA, platforms: ["win32"] },
      { ...BETA, platforms: ["linux"] },
    ]);
    expect(tab.containerEl.childElementCount).toBe(0);
    expect(rows).toHaveLength(0);
  });

  it("a toggle keeps the flag of an experiment that is not offered here", async () => {
    platform.current = "darwin";
    const hidden: Experiment.Row = { ...ALPHA, platforms: ["win32"] },
      section = await drawExperimentalSection([hidden, BETA]),
      { settings } = section.context;
    // The flag was turned on on another device and synced here.
    await settings.mutate((settingsM) => {
      settingsM.experiments = fixExperiments({ alpha: true }, [hidden]);
    });
    section.tab.update();
    expect(section.rows).toHaveLength(1);
    const beta = section.row(0);
    beta.toggle.setValue(true);
    await vi.waitFor(() => {
      expect(settings.value.experiments).toEqual({ alpha: true, beta: true });
    });
    beta.toggle.setValue(false);
    await vi.waitFor(() => {
      expect(settings.value.experiments).toEqual({ alpha: true });
    });
    beta.reset.extraSettingsEl.click();
    await vi.waitFor(() => {
      expect(beta.toggle.getValue()).toBe(false);
    });
    expect(settings.value.experiments).toEqual({ alpha: true });
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
        row.settingEl.append(row.nameEl, row.descEl);
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
  public dispose(): void {
    this.onUnload();
  }
  protected override newPythonWidgets(): void {
    // The Windows-only rows have their own tests above.
  }
}

describe("settings tab descriptions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
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
