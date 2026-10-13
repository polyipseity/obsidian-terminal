import { createInstance } from "i18next";
import { describe, it, expect } from "vitest";
import { PluginLocales } from "../../assets/locales.js";

describe("PluginLocales", () => {
  it("exports defaults from library and namespaces", () => {
    expect(PluginLocales.DEFAULT_LANGUAGE).toBe("en");
    expect(PluginLocales.DEFAULT_NAMESPACE).toBe("translation");

    // NAMESPACES should include the three expected namespaces
    const namespaces = Array.from(PluginLocales.NAMESPACES);
    expect(namespaces).toEqual(
      expect.arrayContaining(["translation", "language", "asset"]),
    );
  });

  it("provides en resources (translation, asset, language)", async () => {
    const enRes = PluginLocales.RESOURCES[PluginLocales.DEFAULT_LANGUAGE];

    const translation = await enRes[PluginLocales.DEFAULT_NAMESPACE]();
    expect(translation.name).toBe("$t(generic.terminal, capitalize)");

    const asset = await enRes.asset();
    expect(asset.settings.documentations["readme-icon"]).toBe(
      "$t(asset:generic.documentations.readme-icon)",
    );

    const language = await enRes.language();
    expect(language.en).toBe("English");
  });

  describe("provides the instancing descriptions in every declared locale", () => {
    it.each(Array.from(PluginLocales.LANGUAGES))("%s", async (language) => {
      const { settings } =
        await PluginLocales.RESOURCES[language].translation();

      expect(settings["focus-on-new-instance-description"]).toMatch(/\S/u);
      expect(
        settings["create-instance-near-existing-ones-description"],
      ).toMatch(/\S/u);
    });
  });

  describe("provides the drop notices and the drag label in every declared locale", () => {
    it.each(Array.from(PluginLocales.LANGUAGES))("%s", async (language) => {
      const { components, notices } =
        await PluginLocales.RESOURCES[language].translation();

      expect(notices["drop-no-paths"]).toMatch(/\S/u);
      expect(notices["drop-skipped-paths"]).toMatch(/\S/u);
      expect(components.terminal["drag-insert-path"]).toMatch(/\S/u);
    });
  });

  // The notice also shows for files of this computer: one of another vault's
  // window, or one whose lookup on disk had no answer in time. A translation
  // may word it freely; the English text that every locale starts from must
  // not say that the dropped items are no files of this computer.
  describe("does not deny in any declared locale that a drop without a path held local files", () => {
    it.each(Array.from(PluginLocales.LANGUAGES))("%s", async (language) => {
      const { notices } = await PluginLocales.RESOURCES[language].translation();

      expect(notices["drop-no-paths"]).not.toMatch(
        /not files on this computer/iu,
      );
    });

    it("says in English that no path was found", async () => {
      const { notices } = await PluginLocales.RESOURCES.en.translation();

      expect(notices["drop-no-paths"]).toBe(
        "Nothing to insert: no local file path was found in the dropped items.",
      );
    });
  });

  it("lists languages and includes expected entries", () => {
    const langs = Array.from(PluginLocales.LANGUAGES);
    expect(langs).toEqual(expect.arrayContaining(["en", "pt", "pt-BR"]));
  });

  it("loads translation resources for all declared languages", async () => {
    const languages = Array.from(PluginLocales.LANGUAGES);

    // Prepare loaders: each language should expose a default namespace loader
    const loaders = languages.map((lang) => {
      const res = PluginLocales.RESOURCES[lang];
      expect(res).toBeDefined();
      const loader = res[PluginLocales.DEFAULT_NAMESPACE];
      expect(typeof loader).toBe("function");
      return loader();
    });

    const results = await Promise.all(loaders);
    for (const r of results) {
      const record = r;
      expect(typeof record).toBe("object");
      expect(record).not.toBeNull();
    }

    // Sanity checks for special keys
    const ptBr = PluginLocales.RESOURCES["pt-BR"].translation;
    expect(typeof ptBr).toBe("function");
    const ptBrRes = await ptBr();
    expect(typeof ptBrRes).toBe("object");

    const zhHans = PluginLocales.RESOURCES["zh-Hans"].translation;
    expect(typeof zhHans).toBe("function");
    const zhHansRes = await zhHans();
    expect(typeof zhHansRes).toBe("object");
  });

  it("interpolates the attempted Python candidates in every locale", async () => {
    const tried =
      "C:\\Profile\\python.exe, D:\\Plugin\\python.exe, python, python3, py -3";
    for (const language of PluginLocales.LANGUAGES) {
      const translation = await PluginLocales.RESOURCES[language].translation();
      const i18n = createInstance();
      await i18n.init({
        lng: language,
        fallbackLng: false,
        resources: { [language]: { translation } },
      });
      const message = i18n.t("errors.win32-python-missing", {
        tried,
        interpolation: { escapeValue: false },
      });
      expect(message, language).toContain(tried);
      expect(message, language).not.toContain("{{");
      expect(message, language).not.toContain(`'${tried}'`);
    }
  });

  it("has no words left for the two tab status settings that are always on, in any locale", async () => {
    // Idle and seen always have the grey badge, and a finished program is
    // always unread until the user looks: no row asks, so no key is used.
    const removed = [
      "tab-status-quiet-marks",
      "tab-status-quiet-marks-description",
      "tab-status-quiet-marks-options",
      "tab-status-unread-badge",
      "tab-status-unread-badge-description",
    ];
    expect(PluginLocales.LANGUAGES).toHaveLength(49);
    for (const language of PluginLocales.LANGUAGES) {
      const { settings } =
        await PluginLocales.RESOURCES[language].translation();
      for (const key of removed) {
        expect(settings, `${language} ${key}`).not.toHaveProperty([key]);
      }
      expect(
        Object.keys(settings).filter((key) => /quiet|unread/u.test(key)),
        language,
      ).toEqual([]);
      // The rows that stay have their words.
      expect(settings, language).toHaveProperty(["tab-status-animation"]);
    }
    const asset = await PluginLocales.RESOURCES.en.asset();
    for (const key of [
      "tab-status-quiet-marks-icon",
      "tab-status-unread-badge-icon",
    ]) {
      expect(asset.settings).not.toHaveProperty([key]);
    }
    expect(asset.settings).toHaveProperty(["tab-status-animation-icon"]);
  });

  it("has the words of the program status experiment, and none for a switch or a section of its own, in every locale", async () => {
    for (const language of PluginLocales.LANGUAGES) {
      const { settings } =
          await PluginLocales.RESOURCES[language].translation(),
        { tabStatus } = settings["experimental-features"];
      expect(tabStatus.name, language).toMatch(/\S/u);
      expect(tabStatus.effect, language).toMatch(/\S/u);
      expect(tabStatus.risk, language).toMatch(/\S/u);
      // The experiment's toggle is the switch, and its rows have no heading.
      for (const key of [
        "tab-status",
        "tab-status-reports",
        "tab-status-reports-description",
      ]) {
        expect(settings, `${language} ${key}`).not.toHaveProperty([key]);
      }
    }
    const asset = await PluginLocales.RESOURCES.en.asset();
    expect(asset.settings).not.toHaveProperty(["tab-status-reports-icon"]);
  });

  it("has words for the two tab icons and for no other, in every locale", async () => {
    for (const language of PluginLocales.LANGUAGES) {
      const { settings } =
        await PluginLocales.RESOURCES[language].translation();
      expect(
        Object.keys(settings["tab-icon-set-options"]).sort(),
        language,
      ).toEqual(["bezel", "tile"]);
      expect(
        Object.keys(settings)
          .filter((key) => key.startsWith("tab-icon-"))
          .sort(),
        language,
      ).toEqual([
        "tab-icon-set",
        "tab-icon-set-description",
        "tab-icon-set-options",
        "tab-icon-size",
        "tab-icon-size-description",
        "tab-icon-size-option",
      ]);
    }
  });

  it("still names the plain icons of the terminal view and of the ribbon button", async () => {
    const asset = await PluginLocales.RESOURCES.en.asset(),
      i18n = createInstance();
    await i18n.init({
      lng: "en",
      fallbackLng: false,
      ns: ["asset"],
      resources: { en: { asset } },
    });
    expect(i18n.t("asset:components.terminal.icon")).toBe("terminal");
    expect(i18n.t("asset:ribbons.open-terminal-icon")).toBe("terminal-square");
  });

  it("uses the concise Windows Python notices in all 49 locales", async () => {
    expect(PluginLocales.LANGUAGES).toHaveLength(49);
    for (const language of PluginLocales.LANGUAGES) {
      const translation = await PluginLocales.RESOURCES[language].translation();
      expect(translation.notices, language).toMatchObject({
        "win32-conhost-fallback":
          "This $t(generic.terminal) is using ConHost because ConPTY needs $t(generic.Python) 3.9 or newer. Full-screen apps may not draw or resize correctly.",
        "win32-conpty-runtime-fallback":
          "The ConPTY host failed to start, so terminals using this $t(generic.Python) configuration are using ConHost. Select '$t(settings.python-recheck)' in the plugin settings to try ConPTY again.",
        "win32-resizer-python-missing":
          "No usable $t(generic.Python) 3.9 or newer found (tried '{{executable}}'), so this ConHost $t(generic.terminal) has no automatic resizing.",
      });
      expect(translation.errors, language).toMatchObject({
        "win32-python-missing":
          "No usable $t(generic.Python) found (tried {{tried}}). Install it from https://www.python.org/downloads/, then select '$t(settings.python-recheck)' in the plugin settings.",
        "win32-python-store-stub":
          "'{{executable}}' opens the Microsoft Store instead of $t(generic.Python). Install $t(generic.Python) from https://www.python.org/downloads/, then select '$t(settings.python-recheck)' in the plugin settings.",
        "win32-python-too-old":
          "'{{executable}}' is $t(generic.Python) {{version}}, older than 3.9. Update it, or set another $t(generic.Python) $t(generic.executable) in the plugin settings.",
      });
    }
  });

  it("provides automatic-check and POSIX-path guidance in every locale", async () => {
    for (const language of PluginLocales.LANGUAGES) {
      const translation = await PluginLocales.RESOURCES[language].translation();
      expect(translation.settings["python-status-not-automatic"]).toBeTruthy();
      expect(
        translation.components.profile.integrated[
          "Python-status-not-automatic"
        ],
      ).toBeTruthy();
      expect(translation.notices["win32-python-posix-path"]).toBeTruthy();
    }
  });

  it("provides the Experimental section texts in every declared locale", async () => {
    for (const language of PluginLocales.LANGUAGES) {
      const { settings } =
        await PluginLocales.RESOURCES[language].translation();
      expect(settings.experimental, language).toMatch(/\S/u);
      expect(settings["experimental-description"], language).toMatch(/\S/u);
      expect(settings["experimental-feedback"], language).toMatch(/\S/u);
      expect(settings["experimental-applies"].newTerminals, language).toMatch(
        /\S/u,
      );
      expect(settings["experimental-applies"].restart, language).toMatch(/\S/u);
      expect(settings["experimental-risk"], language).toContain("{{risk}}");
    }
    const asset = await PluginLocales.RESOURCES.en.asset();
    expect(asset.settings["experimental-feature-icon"]).toMatch(/\S/u);
  });

  it("scopes initialization errors and empty Python fields identically in all 49 locales", async () => {
    expect(PluginLocales.LANGUAGES).toHaveLength(49);
    for (const language of PluginLocales.LANGUAGES) {
      const translation = await PluginLocales.RESOURCES[language].translation();
      expect(translation.errors["win32-exit-c0000142"], language).toBe(
        "The ConPTY host failed to initialize before starting '{{executable}}' (exit code 3221225794 / 0xC0000142). Switch the $t(generic.platforms.win32) terminal backend to 'ConHost' for this $t(generic.profile).",
      );
      expect(
        translation.components.profile.integrated[
          "Python-executable-description"
        ],
        language,
      ).toBe(
        "Recommend {{version}} or up. Required on $t(generic.platforms.unix) to $t(generic.spawn) $t(generic.profile-types.integrated) $t(generic.terminal). $t(generic.clear, capitalize) $t(generic.text-field) to $t(generic.disable) $t(generic.Python) on platforms other than $t(generic.platforms.win32). On $t(generic.platforms.win32), an empty $t(generic.text-field) uses the plugin's '$t(settings.python-executable)' setting.",
      );
    }
  });

  it("provides the Windows backend selector and ConPTY failure messages", async () => {
    const translations = await Promise.all(
      Array.from(PluginLocales.LANGUAGES, async (language) => {
        const loader =
          PluginLocales.RESOURCES[language][PluginLocales.DEFAULT_NAMESPACE];
        return loader();
      }),
    );

    const integratedKeys = [
        "win32-backend",
        "win32-backend-description",
        "win32-backend-options-conpty",
        "win32-backend-options-legacy",
        "win32-backend-status-available",
        "win32-backend-status-checking",
        "win32-backend-status-legacy",
        "win32-backend-status-missing",
        "win32-backend-status-runtime-unavailable",
        "win32-backend-status-unconfirmed",
        "win32-backend-status-unverified",
        "Python-status-fallback",
        "Python-status-inherited-unverified",
        "Python-status-missing",
        "Python-status-store-stub",
        "Python-status-too-old",
        "Python-status-unverified",
      ],
      errorKeys = [
        "conpty-control-unauthenticated",
        "conpty-host-exited-before-ready",
        "conpty-readiness-timeout",
        "no-Python-to-spawn-Windows-ConPTY",
        "win32-exit-9009",
        "win32-exit-c0000142",
        "win32-python-missing",
        "win32-python-store-stub",
        "win32-python-too-old",
      ];
    for (const translation of translations) {
      const integrated = translation.components.profile.integrated as Record<
          string,
          unknown
        >,
        errors = translation.errors as Record<string, unknown>;
      for (const key of integratedKeys) expect(integrated[key]).toBeTruthy();
      expect(translation.settings).toHaveProperty(
        "python-status-ok-fallback",
        expect.any(String),
      );
      expect(translation.settings["python-status-ok-unconfirmed"]).toBeTruthy();
      expect(translation.settings["python-status-unverified"]).toBeTruthy();
      expect(translation.settings).toHaveProperty(
        "python-status-missing-configured",
        expect.any(String),
      );
      expect(translation.settings).toHaveProperty(
        "python-status-unverified-errno",
        expect.any(String),
      );
      expect(
        translation.settings["python-status-ok-runtime-unavailable"],
      ).toBeTruthy();
      for (const key of [
        "python-status-missing",
        "python-status-ok",
        "python-status-ok-resolved",
        "python-status-ok-runtime-unavailable",
        "python-status-ok-unconfirmed",
        "python-status-store-stub",
        "python-status-too-old",
      ] as const) {
        expect(translation.settings[key].toLowerCase()).toContain(
          "terminals using the plugin's python",
        );
      }
      // The shell-pipes option and the old conhost boolean are retired, in
      // every locale rather than English alone.
      expect(integrated).not.toHaveProperty(
        "win32-backend-options-shell-pipes",
      );
      expect(integrated).not.toHaveProperty("use-win32-conhost");
      expect(integrated).not.toHaveProperty("use-win32-conhost-description");
      for (const key of errorKeys) expect(errors[key]).toBeTruthy();
    }

    const asset = await PluginLocales.RESOURCES.en.asset();
    expect(
      asset.components.profile.integrated["win32-backend-icon"],
    ).toBeTruthy();
    expect(asset.components.profile.integrated).not.toHaveProperty(
      "use-win32-conhost-icon",
    );
  });
});
