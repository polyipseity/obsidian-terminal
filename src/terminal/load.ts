import {
  Platform,
  addCommand,
  addRibbonIcon,
  deepFreeze,
  isNonNil,
  notice2,
} from "@polyipseity/obsidian-plugin-library";
import { isEmpty } from "lodash-es";
import {
  FileSystemAdapter,
  MarkdownView,
  type MenuItem,
  TFolder,
} from "obsidian";
import type { TerminalPlugin } from "../main.js";
import { Settings } from "../settings-data.js";
import { PROFILE_PROPERTIES } from "./profile-properties.js";
import { SelectProfileModal, spawnTerminal } from "./spawn.js";
import { TerminalView } from "./view.js";

export function loadTerminal(context: TerminalPlugin): void {
  TerminalView.load(context);
  const PROFILE_TYPES = deepFreeze(
      (
        ["default", "external", "integrated", "select"] satisfies readonly (
          | "default"
          | "select"
          | keyof typeof PROFILE_PROPERTIES
        )[]
      ).filter(
        (type) =>
          type === "default" ||
          type === "select" ||
          PROFILE_PROPERTIES[type].available,
      ),
    ),
    CWD_TYPES = deepFreeze(["root", "current"]),
    {
      app: { vault, workspace },
      language: { value: i18n },
      settings,
    } = context,
    getDefaultProfile = (): readonly [string, Settings.Profile] | null => {
      const { defaultProfile, profiles } = settings.value;
      if (defaultProfile) {
        const profile = profiles[defaultProfile];
        if (
          profile &&
          Settings.Profile.isCompatible(profile, Platform.CURRENT)
        ) {
          return [defaultProfile, profile];
        }
      }
      return null;
    },
    getDefaultProfileOfType = (
      type: Settings.Profile.Type,
    ): readonly [string, Settings.Profile] | null => {
      return Settings.Profile.defaultEntryOfType(
        type,
        settings.value.profiles,
        Platform.CURRENT,
      );
    },
    adapter = vault.adapter instanceof FileSystemAdapter ? vault.adapter : null,
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
          if (!cwd) {
            return void 0;
          }
          if (!adapter) {
            return null;
          }
          switch (cwd) {
            case "root":
              return adapter.getBasePath();
            case "current": {
              const active = workspace.getActiveFile();
              if (active?.parent) {
                return adapter.getFullPath(active.parent.path);
              }
              return null;
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
        settings.value.errorNoticeTimeout,
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
        settings.value.errorNoticeTimeout,
        context,
      );
    }
    return true;
  };

  /* Register ribbon icons */

  addRibbonIcon(
    context,
    i18n.t("asset:ribbons.open-terminal-id"),
    i18n.t("asset:ribbons.open-terminal-icon"),
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
      if (evt.ctrlKey || evt.metaKey) {
        openSelectProfile(adapter?.getBasePath());
        return;
      }
      openDefaultOrSelectProfile(adapter?.getBasePath());
    },
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
      if (!isEmpty(items)) {
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
      if (!isEmpty(items)) {
        menu.addSeparator();
        items.forEach((item) => menu.addItem(item));
      }
    }),
  );

  /* Always register command for interop with other plugins */

  addCommand(context, () => i18n.t("commands.open-developer-console"), {
    checkCallback(checking) {
      if (!settings.value.addToCommand) {
        return false;
      }
      return openDefaultProfileOfType("developerConsole", void 0, checking);
    },
    icon: i18n.t("asset:commands.open-developer-console-icon"),
    id: "open-terminal.developerConsole",
  });

  for (const type of PROFILE_TYPES) {
    for (const cwd of CWD_TYPES) {
      addCommand(
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
          icon: i18n.t(`asset:commands.open-terminal-${cwd}-icon`),
          id: `open-terminal.${type}.${cwd}`,
        },
      );
    }
  }
}
