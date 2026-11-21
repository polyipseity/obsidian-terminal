import {
  Platform,
  SI_PREFIX_SCALE,
  addCommand,
  addRibbonIcon,
  deepFreeze,
  deopaque,
  inSet,
  isNonNil,
  notice2,
} from "@polyipseity/obsidian-plugin-library";
import {
  FileSystemAdapter,
  MarkdownView,
  Menu,
  type MenuItem,
  TFile,
  TFolder,
} from "obsidian";
import { tileIconId } from "../icons.js";
import type { TerminalPlugin } from "../main.js";
import {
  deviceDefaultProfile,
  deviceProfileEntries,
  runnableProfile,
} from "../profile-choice.js";
import { TERMINAL_CONPTY_PREWARM_DELAY } from "../magic.js";
import { warmSystemPath } from "./environment.js";
import { Settings } from "../settings-data.js";
import {
  PROFILE_PROPERTIES,
  prewarmConPtyProfile,
} from "./profile-properties.js";
import { CONPTY_HOST_POOL } from "./pseudoterminal.js";
import { SelectProfileModal, spawnTerminal } from "./spawn.js";
import { TerminalView } from "./view.js";
import {
  invalidateWindowsPythonNegativeDiagnoses,
  isAutomaticWindowsPythonExecutable,
  runPluginPythonCheck,
} from "./win32-doctor.js";

/**
 * Adds the built-in keymappings that a list from an earlier version lacks,
 * once, and saves. It runs outside the fixer, so that loading such a list
 * does not count as a change.
 *
 * @param context the plugin
 */
function offerKeymappingDefaults(context: TerminalPlugin): void {
  const { settings } = context;
  if (
    (settings.value.keymappingDefaultsVersion ?? 0) >=
    Settings.KEYMAPPING_DEFAULTS_VERSION
  ) {
    return;
  }
  settings
    .mutate((settingsM) => {
      Settings.addKeymappingDefaults(settingsM);
    })
    .then(async () => settings.write())
    .catch((error: unknown) => {
      self.console.error(error);
    });
}

export function loadTerminal(context: TerminalPlugin): void {
  TerminalView.load(context);
  offerKeymappingDefaults(context);
  // Files that were active, newest first; a few spare ones skip deleted files.
  const recentFiles: TFile[] = [];
  const PROFILE_TYPES = deepFreeze(
      (
        ["default", "external", "integrated", "select"] satisfies readonly (
          "default" | "select" | keyof typeof PROFILE_PROPERTIES
        )[]
      ).filter(
        (type) =>
          inSet(["default", "select"], type) ||
          PROFILE_PROPERTIES[type].available,
      ),
    ),
    CWD_TYPES = deepFreeze(["root", "current"]),
    {
      app: { vault, workspace },
      language: { value: i18n },
      settings,
    } = context,
    getDefaultProfile = (): readonly [string, Settings.Profile] | null =>
      deviceDefaultProfile(context),
    getPrewarmProfile = (): Settings.Profile | null => {
      const isCandidate = (profile: Settings.Profile): boolean =>
        profile.type === "integrated" &&
        profile.win32Backend === "conpty" &&
        !profile.pythonExecutable &&
        Settings.Profile.isCompatible(profile, Platform.CURRENT);
      const fromDefault = getDefaultProfile()?.[1];
      if (fromDefault && isCandidate(fromDefault)) {
        return fromDefault;
      }
      return (
        deviceProfileEntries(context).find(([, profile]) =>
          isCandidate(profile),
        )?.[1] ?? null
      );
    },
    // The default profile when it has this type, else the first one that has.
    getDefaultProfileOfType = (
      type: Settings.Profile.Type,
    ): readonly [string, Settings.Profile] | null => {
      const preferred = getDefaultProfile();
      if (preferred && Settings.Profile.isType(type, preferred[1])) {
        return preferred;
      }
      return Settings.Profile.defaultEntryOfType(
        type,
        settings.value.profiles,
        Platform.CURRENT,
        context.localSettings.value.profileOrder ?? [],
      );
    },
    adapter = vault.adapter instanceof FileSystemAdapter ? vault.adapter : null,
    /*
     * The folder of the file the user last looked at. A focused terminal, an
     * empty tab or the graph view has no active file, so take the newest file
     * that was active and still exists. Not the open tabs: a tab can move on
     * to another view, as the graph view does. Before any file was active in
     * this session, Obsidian's recent-file list stands in. It comes last
     * because it also records files created in the vault, by a shell for
     * example, and keeps the paths of deleted files. Without any file the
     * caller opens the vault root.
     */
    getCurrentFolder = (): TFolder | null => {
      const active = workspace.getActiveFile();
      if (active) return active.parent;
      // By path: a file deleted and created again is a new object.
      const parentAt = (path: string): TFolder | null => {
        const file = vault.getAbstractFileByPath(path);
        return file instanceof TFile ? file.parent : null;
      };
      for (const file of recentFiles) {
        const parent = parentAt(file.path);
        if (parent) return parent;
      }
      for (const path of workspace.getLastOpenFiles()) {
        const parent = parentAt(path);
        if (parent) return parent;
      }
      return null;
    },
    contextMenu = (
      type: (typeof PROFILE_TYPES)[number],
      cwd?: TFolder,
    ): ((item: MenuItem) => void) | null => {
      const cwd0 = cwd ? (adapter ? adapter.getFullPath(cwd.path) : null) : cwd;
      if (cwd0 === null) {
        return null;
      }
      return (item: MenuItem) => {
        item
          .setTitle(
            i18n.t("menus.open-terminal", {
              interpolation: { escapeValue: false },
              type,
            }),
          )
          .setIcon(
            i18n.t("asset:menus.open-terminal-icon", {
              interpolation: { escapeValue: false },
              type,
            }),
          )
          .onClick(() => {
            if (type === "default") {
              openDefaultOrSelectProfile(cwd0);
              return;
            }
            if (type === "select") {
              openSelectProfile(cwd0);
              return;
            }
            openDefaultProfileOfType(type, cwd0);
          });
      };
    },
    command =
      (type: (typeof PROFILE_TYPES)[number], cwd: (typeof CWD_TYPES)[number]) =>
      (checking: boolean): boolean => {
        const cwd0 = ((): string | null | undefined => {
          if (!adapter) {
            return null;
          }
          switch (cwd) {
            case "root":
              return adapter.getBasePath();
            case "current": {
              const folder = getCurrentFolder();
              return folder
                ? adapter.getFullPath(folder.path)
                : adapter.getBasePath();
            }
            // No default
          }
        })();
        if (cwd0 === null) return false;
        if (type === "default")
          return openDefaultOrSelectProfile(cwd0, checking);
        if (type === "select") return openSelectProfile(cwd0, checking);
        return openDefaultProfileOfType(type, cwd0, checking);
      };

  context.registerEvent(
    workspace.on("file-open", (file) => {
      if (!file) return;
      const index = recentFiles.indexOf(file);
      if (index !== -1) recentFiles.splice(index, 1);
      recentFiles.unshift(file);
      recentFiles.splice(10);
    }),
  );

  const openSelectProfile = (cwd?: string, checking?: boolean): boolean => {
    if (!checking) {
      new SelectProfileModal(context, cwd).open();
    }
    return true;
  };

  const openDefaultOrSelectProfile = (
    cwd?: string,
    checking?: boolean,
  ): boolean => {
    const entry = getDefaultProfile();
    if (entry) {
      if (!checking) {
        const [defaultProfileId, profile] = entry;
        spawnTerminal(context, profile, {
          cwd,
          profileSourceId: defaultProfileId,
        });
      }
      return true;
    }
    if (!checking) {
      notice2(
        () =>
          i18n.t("notices.no-default-profile", {
            interpolation: { escapeValue: false },
            type: "default",
          }),
        settings.value.noticeTimeout,
        context,
      );
    }
    return openSelectProfile(cwd, checking);
  };

  const openDefaultProfileOfType = (
    type: Settings.Profile.Type,
    cwd?: string,
    checking?: boolean,
  ): boolean => {
    const entry = getDefaultProfileOfType(type);
    if (entry) {
      if (!checking) {
        const [id, profile] = entry;
        spawnTerminal(context, profile, { cwd, profileSourceId: id });
      }
      return true;
    }
    if (!checking) {
      notice2(
        () =>
          i18n.t("notices.no-default-profile", {
            interpolation: { escapeValue: false },
            type,
          }),
        settings.value.noticeTimeout,
        context,
      );
    }
    return true;
  };

  /* Register ribbon icons */

  const openTerminal = addRibbonIcon(
    context,
    i18n.t("asset:ribbons.open-terminal-id"),
    // The tile icon, as on a terminal tab under Program status None.
    // Registered by `loadIcons`, which the plugin runs before this.
    tileIconId(context),
    () => {
      const entry = getDefaultProfile();
      if (entry) {
        // TODO: Modify `addRibbonIcon` to support dynamic titles not based on language changes.
        return i18n.t("ribbons.open-terminal-default", {
          interpolation: { escapeValue: false },
          info: Settings.Profile.info(entry),
        });
      }
      return i18n.t("ribbons.open-terminal");
    },
    (evt) => {
      // The ribbon callback also receives right-button auxclick events.
      if (evt.button === 2) return;
      if (evt.ctrlKey || evt.metaKey) {
        openSelectProfile(adapter?.getBasePath());
        return;
      }
      openDefaultOrSelectProfile(adapter?.getBasePath());
    },
  );
  // Reloads replace the ribbon element; resolve the current element per event.
  context.registerDomEvent(
    openTerminal.elementRef.ownerDocument,
    "contextmenu",
    (evt) => {
      if (
        evt.button !== 2 ||
        !(evt.target instanceof Node) ||
        !openTerminal.elementRef.contains(evt.target)
      ) {
        return;
      }
      evt.preventDefault();
      const menu = new Menu(),
        cwd = adapter?.getBasePath();
      let hasProfileItems = false;
      for (const [id, profile] of deviceProfileEntries(context)) {
        if (!Settings.Profile.isCompatible(profile, Platform.CURRENT)) {
          continue;
        }
        menu.addItem((item) =>
          item
            .setTitle(
              i18n.t("components.select-profile.item-text-", {
                info: Settings.Profile.info([id, profile]),
                interpolation: { escapeValue: false },
              }),
            )
            .onClick(() => {
              spawnTerminal(context, profile, { cwd, profileSourceId: id });
            }),
        );
        hasProfileItems = true;
      }
      if (hasProfileItems) menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle(
            i18n.t("menus.open-terminal", {
              interpolation: { escapeValue: false },
              type: "select",
            }),
          )
          .onClick(() => {
            openSelectProfile(cwd);
          }),
      );
      menu.showAtMouseEvent(evt);
    },
  );
  context.register(
    settings.onMutate(
      (settings0) => [
        settings0.pythonExecutable,
        Object.fromEntries(
          Object.entries(settings0.profiles).map(([id, profile]) => [
            id,
            [
              profile.type,
              Settings.Profile.isCompatible(profile, "win32"),
              profile.type === "integrated" ? profile.pythonExecutable : null,
              profile.type === "integrated" ? profile.win32Backend : null,
            ],
          ]),
        ),
      ],
      () => {
        // Retire obsolete hosts and pending refills; edits never start a probe.
        CONPTY_HOST_POOL.clear();
      },
    ),
  );
  context.register(
    settings.onMutate(
      (settings0) => [
        settings0.pythonExecutable,
        Object.fromEntries(
          Object.entries(settings0.profiles).flatMap(([id, profile]) =>
            profile.type === "integrated"
              ? [[id, profile.pythonExecutable]]
              : [],
          ),
        ),
      ],
      () => {
        invalidateWindowsPythonNegativeDiagnoses();
      },
    ),
  );

  // The ribbon names this device's default. Redraw when that name changes in
  // either store, as when data.json loses or renames the profile. Each
  // listener watches a part of its own store only: a manager compares with
  // what the listener saw last, which goes stale for the other store.
  const ribbonName = (
    profiles: Settings.Profiles,
    id: Settings.DefaultProfile | undefined,
  ): string | null => {
    const entry = runnableProfile(profiles, id ?? null);
    return entry ? Settings.Profile.info(entry).nameOrID : null;
  };
  let shownName = ribbonName(
    settings.value.profiles,
    context.localSettings.value.defaultProfile,
  );
  const redrawRibbon = (name: string | null): void => {
    if (name !== shownName) {
      shownName = name;
      openTerminal.reload();
    }
  };
  context.register(
    settings.onMutate(
      (settings0) => settings0.profiles,
      (profiles) => {
        redrawRibbon(
          ribbonName(profiles, context.localSettings.value.defaultProfile),
        );
      },
    ),
  );
  context.register(
    context.localSettings.onMutate(
      (local) => local.defaultProfile ?? null,
      (id) => {
        redrawRibbon(ribbonName(settings.value.profiles, id));
      },
    ),
  );

  /* Register context menu items */

  context.registerEvent(
    workspace.on("file-menu", (menu, file) => {
      if (!settings.value.addToContextMenu) {
        return;
      }
      const folder = file instanceof TFolder ? file : file.parent;
      if (!folder) {
        return;
      }
      const items = PROFILE_TYPES.map((type) =>
        contextMenu(type, folder),
      ).filter(isNonNil);
      if (items.length > 0) {
        menu.addSeparator();
        items.forEach((item) => menu.addItem(item));
      }
    }),
  );
  context.registerEvent(
    workspace.on("editor-menu", (menu, _0, info) => {
      const { file } = info;
      if (
        !settings.value.addToContextMenu ||
        info instanceof MarkdownView ||
        !file?.parent
      ) {
        return;
      }
      const { parent } = file;
      const items = PROFILE_TYPES.map((type) =>
        contextMenu(type, parent),
      ).filter(isNonNil);
      if (items.length > 0) {
        menu.addSeparator();
        items.forEach((item) => menu.addItem(item));
      }
    }),
  );

  /* Always register command for interop with other plugins */

  /*
   * Their hotkeys pass a focused terminal only while Add to command is on.
   * With it off their checks decline, but Obsidian still reports the key as
   * handled, so on the list the key would reach neither a command nor the
   * shell. Off the list it goes to the shell.
   */
  // Filled while the commands are registered below, and only read after.
  const openers: ReturnType<typeof addCommand>[] = [],
    allowWhileCommand = (opener: ReturnType<typeof addCommand>): void => {
      openers.push(opener);
      TerminalView.allowWhileFocused(opener, settings.value.addToCommand);
    };
  allowWhileCommand(
    addCommand(context, () => i18n.t("commands.open-developer-console"), {
      checkCallback(checking) {
        if (!settings.value.addToCommand) {
          return false;
        }
        return openDefaultProfileOfType("developerConsole", void 0, checking);
      },
      icon: i18n.t("asset:commands.open-developer-console-icon"),
      id: "open-terminal.developerConsole",
    }),
  );

  for (const type of PROFILE_TYPES) {
    for (const cwd of CWD_TYPES) {
      const opening = addCommand(
        context,
        () =>
          i18n.t(`commands.open-terminal-${cwd}`, {
            interpolation: { escapeValue: false },
            type,
          }),
        {
          checkCallback(checking) {
            if (!settings.value.addToCommand) {
              return false;
            }
            return command(type, cwd)(checking);
          },
          /*
           * A default hotkey on purpose, against Obsidian's advice to avoid
           * them: one key then opens a terminal from anywhere, also from a
           * focused terminal, in the folder of the file last looked at or
           * else the vault root. A letter stays on its printed key on every
           * layout, unlike a backtick. "H", not "h": only the uppercase key
           * code name matches on non-Latin layouts.
           */
          ...(type === "integrated" && cwd === "current"
            ? { hotkeys: [{ key: "H", modifiers: ["Mod", "Shift"] }] }
            : {}),
          icon: i18n.t(`asset:commands.open-terminal-${cwd}-icon`),
          id: `open-terminal.${type}.${cwd}`,
        },
      );
      /*
       * A focused terminal has no active file, so "current" opens in the
       * folder of the file last looked at, or the vault root. Allowing it also
       * lets the focused listener consume its hotkey, the default one or one
       * the user assigned, instead of the shell: ConPTY turns
       * Ctrl+Shift+<letter> into that letter's control character, e.g.
       * Ctrl+Shift+H into 0x08, which cmd.exe treats as backspace. This holds
       * while Add to command is on; with it off the key goes to the shell.
       */
      allowWhileCommand(opening);
    }
  }
  context.register(
    settings.onMutate(
      (settings0) => settings0.addToCommand,
      (addToCommand) => {
        for (const opener of openers) {
          TerminalView.allowWhileFocused(opener, addToCommand);
        }
        TerminalView.reloadFocusedHotkeys(context);
      },
    ),
  );

  /*
   * `onLayoutReady` has no unsubscribe and still fires after the plugin
   * unloads; the flag stops the callback from starting work (and registering
   * cleanup) on an unloaded plugin, which would leak the timer and the spare.
   */
  const prewarm = (): void => {
    if (unloaded || !settings.value.prewarmConPty) return;
    const profile = getPrewarmProfile();
    if (!profile) return;
    prewarmConPtyProfile(context, profile).catch((error: unknown) => {
      /* @__PURE__ */ self.console.debug(error);
    });
  };
  let unloaded = false;
  context.register(() => {
    unloaded = true;
  });
  workspace.onLayoutReady(() => {
    if (unloaded) {
      return;
    }
    warmSystemPath();
    if (
      deopaque(Platform.CURRENT) === "win32" &&
      isAutomaticWindowsPythonExecutable(settings.value.pythonExecutable)
    ) {
      // Silent; overrides are checked when visited or explicitly rechecked.
      runPluginPythonCheck(context, void 0, void 0, {
        includeProfileOverrides: false,
        refresh: false,
      }).catch((error: unknown) => {
        /* @__PURE__ */ self.console.debug(error);
      });
    }
    if (
      !context.localSettings.value.hasUsedIntegratedTerminal ||
      !settings.value.prewarmConPty ||
      !getPrewarmProfile()
    ) {
      return;
    }
    const timer = self.setTimeout(() => {
      if (!unloaded && context.localSettings.value.hasUsedIntegratedTerminal) {
        prewarm();
      }
    }, TERMINAL_CONPTY_PREWARM_DELAY * SI_PREFIX_SCALE);
    context.register(() => {
      self.clearTimeout(timer);
    });
  });

  context.register(
    settings.onMutate(
      (settings0) => settings0.prewarmConPty,
      (prewarm0) => {
        if (prewarm0) prewarm();
        else CONPTY_HOST_POOL.clear();
      },
    ),
  );
  context.register(
    settings.onMutate(
      (settings0) => settings0.windowsTerminalConsoleHost,
      () => {
        // A spare plans its console host at boot; replace it with one that
        // plans for the new setting. The clear retires in-flight refills too.
        CONPTY_HOST_POOL.clear();
        // Like layout-ready: no spare before the first integrated terminal.
        if (context.localSettings.value.hasUsedIntegratedTerminal) prewarm();
      },
    ),
  );
}
