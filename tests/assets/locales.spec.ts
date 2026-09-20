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
