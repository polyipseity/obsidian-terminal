import {
  DEFAULT_ENCODING,
  DEFAULT_SUCCESS_EXIT_CODES,
  DOMClasses2,
} from "../magic.js";
import {
  DialogModal,
  FindComponent,
  type FindComponent$,
  type Fixed,
  JSON_STRINGIFY_SPACE,
  Platform,
  UnnamespacedID,
  activeSelf,
  addCommand,
  anyToError,
  assignExact,
  awaitCSS,
  basename,
  cloneAsWritable,
  createChildElement,
  deepFreeze,
  dynamicRequire,
  extname,
  fixTyped,
  instanceOf,
  launderUnchecked,
  linkSetting,
  markFixed,
  newCollaborativeState,
  newHotkeyListener,
  notice2,
  onResize,
  openExternal,
  printError,
  printMalformedData,
  randomNotIn,
  readStateCollaboratively,
  recordViewStateHistory,
  resetButton,
  saveFileAs,
  updateView,
  useSettings,
  writeStateCollaboratively,
} from "@polyipseity/obsidian-plugin-library";
import {
  DisposerAddon,
  DragAndDropAddon,
  FollowThemeAddon,
  RendererAddon,
  RightClickActionAddon,
} from "./emulator-addons.js";
import {
  FileSystemAdapter,
  ItemView,
  type Menu,
  Scope,
  type ViewStateResult,
  type WorkspaceLeaf,
} from "obsidian";
import { PROFILE_PROPERTIES, openProfile } from "./profile-properties.js";
import { cloneDeep, noop } from "lodash-es";
import { mount, unmount } from "svelte";
import { BUNDLE } from "../import.js";
import type { DeepWritable } from "ts-essentials";
import type { LigaturesAddon } from "@xterm/addon-ligatures";
import { ProfileModal } from "../modals.js";
import type { SearchAddon } from "@xterm/addon-search";
import { Settings } from "../settings-data.js";
import type { TerminalPlugin } from "../main.js";
import { TextPseudoterminal } from "./pseudoterminal.js";
import type { Unicode11Addon } from "@xterm/addon-unicode11";
import type { WebLinksAddon } from "@xterm/addon-web-links";
import { XtermTerminalEmulator } from "./emulator.js";
import { writePromise } from "./utils.js";

const xtermAddonCanvas = dynamicRequire<typeof import("@xterm/addon-canvas")>(
    BUNDLE,
    "@xterm/addon-canvas",
  ),
  xtermAddonLigatures = dynamicRequire<typeof import("@xterm/addon-ligatures")>(
    BUNDLE,
    "@xterm/addon-ligatures",
  ),
  xtermAddonSearch = dynamicRequire<typeof import("@xterm/addon-search")>(
    BUNDLE,
    "@xterm/addon-search",
  ),
  xtermAddonUnicode11 = dynamicRequire<typeof import("@xterm/addon-unicode11")>(
    BUNDLE,
    "@xterm/addon-unicode11",
  ),
  xtermAddonWebLinks = dynamicRequire<typeof import("@xterm/addon-web-links")>(
    BUNDLE,
    "@xterm/addon-web-links",
  ),
  xtermAddonWebgl = dynamicRequire<typeof import("@xterm/addon-webgl")>(
    BUNDLE,
    "@xterm/addon-webgl",
  );

export class EditTerminalModal extends DialogModal {
  protected readonly state;
  #profile: string | null = null;
  readonly #confirm;

  public constructor(
    protected override readonly context: TerminalPlugin,
    protected readonly protostate: TerminalView.State,
    confirm: (state_: DeepWritable<typeof protostate>) => unknown,
  ) {
    const {
      language: { value: i18n },
    } = context;
    super(context, {
      title: () => i18n.t("components.terminal.edit-modal.title"),
    });
    this.state = cloneAsWritable(protostate);
    this.#confirm = confirm;
  }

  public override onOpen(): void {
    super.onOpen();
    const {
        context,
        context: {
          settings,
          language: { value: i18n },
          app: {
            vault: { adapter },
          },
        },
        ui,
        protostate,
        state,
      } = this,
      { element: listEl, remover: listElRemover } = useSettings(this.contentEl);
    ui.finally(listElRemover)
      .newSetting(listEl, (setting) => {
        setting
          .setName(i18n.t("components.terminal.edit-modal.working-directory"))
          .addText(
            linkSetting(
              () => state.cwd ?? "",
              (value) => {
                state.cwd = value || null;
              },
              () => {
                this.postMutate();
              },
              {
                post: (component) => {
                  component.setPlaceholder(
                    i18n.t(
                      "components.terminal.edit-modal.working-directory-placeholder",
                    ),
                  );
                },
              },
            ),
          )
          .addButton((button) =>
            button
              .setIcon(
                i18n.t(
                  "asset:components.terminal.edit-modal.root-directory-icon",
                ),
              )
              .setTooltip(
                i18n.t("components.terminal.edit-modal.root-directory"),
              )
              .onClick(() => {
                state.cwd =
                  adapter instanceof FileSystemAdapter
                    ? adapter.getBasePath()
                    : null;
                this.postMutate();
              }),
          )
          .addExtraButton(
            resetButton(
              i18n.t(
                "asset:components.terminal.edit-modal.working-directory-icon",
              ),
              i18n.t("components.terminal.edit-modal.reset"),
              () => {
                state.cwd = protostate.cwd;
              },
              () => {
                this.postMutate();
              },
            ),
          );
      })
      .newSetting(listEl, (setting) => {
        const { profiles } = settings.value,
          unselected = randomNotIn(Object.keys(profiles));
        setting
          .setName(i18n.t("components.terminal.edit-modal.profile"))
          .addDropdown(
            linkSetting(
              () => this.#profile ?? unselected,
              (value) => {
                const profile0 = profiles[value];
                if (!profile0) {
                  this.#profile = null;
                  return;
                }
                this.#profile = value;
                this.state.profile = cloneAsWritable(profile0);
              },
              () => {
                this.postMutate();
              },
              {
                pre: (component) => {
                  component
                    .addOption(
                      unselected,
                      i18n.t(
                        "components.terminal.edit-modal.profile-placeholder",
                      ),
                    )
                    .addOptions(
                      Object.fromEntries(
                        Object.entries(profiles).map((entry) => [
                          entry[0],

                          i18n.t(
                            `components.terminal.edit-modal.profile-name-${
                              Settings.Profile.isCompatible(
                                entry[1],
                                Platform.CURRENT,
                              )
                                ? ""
                                : "incompatible"
                            }`,
                            {
                              info: Settings.Profile.info(entry),
                              interpolation: { escapeValue: false },
                            },
                          ),
                        ]),
                      ),
                    );
                },
              },
            ),
          )
          .addButton((button) =>
            button
              .setIcon(
                i18n.t(
                  "asset:components.terminal.edit-modal.profile-edit-icon",
                ),
              )
              .setTooltip(i18n.t("components.terminal.edit-modal.profile-edit"))
              .onClick(() => {
                new ProfileModal(context, state.profile, (profile0) => {
                  this.#profile = null;
                  state.profile = profile0;
                  this.postMutate();
                }).open();
              }),
          )
          .addExtraButton(
            resetButton(
              i18n.t("asset:components.terminal.edit-modal.profile-icon"),
              i18n.t("components.terminal.edit-modal.reset"),
              () => {
                this.#profile = null;
                state.profile = cloneAsWritable(protostate.profile);
              },
              () => {
                this.postMutate();
              },
            ),
          );
      });
  }

  protected override async confirm(close: () => void): Promise<void> {
    await this.#confirm(cloneAsWritable(this.state));
    await super.confirm(close);
  }

  protected postMutate(): void {
    const { modalUI, ui } = this;
    modalUI.update();
    ui.update();
  }
}

export class TerminalView extends ItemView {
  public static readonly type = new UnnamespacedID(
    DOMClasses2.Namespaced.TERMINAL,
  );

  protected static lastFocusTimes = new Map<TerminalView, number>();
  protected static lastActiveOtherLeaf: WeakRef<WorkspaceLeaf> | null = null;
  protected static readonly focusedScope = new Scope();

  static #namespacedType: string;
  #title0 = "";
  #emulator0: TerminalView.EMULATOR | null = null;
  #find0: ReturnType<typeof FindComponent> | null = null;
  #state = TerminalView.State.DEFAULT;

  public constructor(
    protected readonly context: TerminalPlugin,
    leaf: WorkspaceLeaf,
  ) {
    super(leaf);
    this.navigation = true;
  }

  protected get isFocused(): boolean {
    const { contentEl } = this;
    return contentEl.contains(contentEl.ownerDocument.activeElement);
  }

  protected get state(): TerminalView.State {
    return this.#state;
  }

  protected get emulator(): TerminalView.EMULATOR | null {
    return this.#emulator0;
  }

  protected get find(): ReturnType<typeof FindComponent> | null {
    return this.#find0;
  }

  protected get title(): string {
    return this.#title0;
  }

  protected get name(): string {
    const { context: plugin, state } = this,
      { value: i18n } = plugin.language,
      { profile } = state,
      { name, type } = profile;
    if (this.title) {
      return this.title;
    }
    if (typeof name === "string" && name) {
      return name;
    }
    if ("executable" in profile) {
      const { executable } = profile;
      if (typeof executable === "string") {
        return basename(executable, extname(executable));
      }
    }
    return i18n.t("components.terminal.name.profile-type", {
      interpolation: { escapeValue: false },
      type,
    });
  }

  protected get hidesStatusBar(): boolean {
    const {
      context: { settings },
    } = this;
    switch (settings.value.hideStatusBar) {
      case "focused":
        return this.isFocused;
      case "running":
        return true;
      case "always":
      case "never":
        return false;
      // No default
    }
  }

  protected set state(value: TerminalView.State) {
    const value2 = cloneAsWritable(value);
    let cachedSerial = value2.serial;
    this.#state = Object.defineProperty(value2, "serial", {
      configurable: false,
      enumerable: true,
      get: (): TerminalView.State["serial"] => {
        // Cache the serial regardless if the serial needs to be saved.
        cachedSerial = this.emulator?.serialize() ?? cachedSerial;
        return value2.profile.type !== "invalid" &&
          value2.profile.restoreHistory
          ? cachedSerial
          : null;
      },
    });
    updateView(this.context, this);
  }

  protected set emulator(val: TerminalView.EMULATOR | null) {
    const { context: plugin } = this;
    this.#emulator0?.close(false).catch((error: unknown) => {
      printError(
        anyToError(error),
        () => plugin.language.value.t("errors.error-killing-pseudoterminal"),
        plugin,
      );
    });
    this.#emulator0 = val;
  }

  protected set find(val: ReturnType<typeof FindComponent> | null) {
    if (this.find) {
      unmount(this.find, { outro: true }).catch((error: unknown) => {
        activeSelf(this.contentEl).console.warn(error);
      });
    }
    this.#find0 = val;
  }

  protected set title(value: string) {
    this.#title0 = value;
    updateView(this.context, this);
  }

  public static load(context: TerminalPlugin): void {
    const {
      app: { workspace },
      language: { value: i18n },
    } = context;
    this.#namespacedType = this.type.namespaced(context);
    context.registerView(
      TerminalView.type.namespaced(context),
      (leaf) => new TerminalView(context, leaf),
    );

    // Track the last non-terminal leaf for restoring focus on unfocus
    context.registerEvent(
      workspace.on("active-leaf-change", (leaf) => {
        if (leaf && !(leaf.view instanceof TerminalView)) {
          this.lastActiveOtherLeaf = new WeakRef(leaf);
        }
      }),
    );

    const withLastFocusedView =
      (
        callback: (checking: boolean, view: TerminalView) => boolean,
        focused: readonly boolean[] = [true],
      ): ((checking: boolean) => boolean) =>
      (checking) => {
        let lastFocusTime = null,
          lastFocus = null;
        for (const [view, time] of this.lastFocusTimes.entries()) {
          if (lastFocusTime !== null && lastFocusTime >= time) {
            continue;
          }
          lastFocusTime = time;
          lastFocus = view;
        }
        if (!lastFocus || !focused.includes(lastFocus.isFocused)) {
          return false;
        }
        return callback(checking, lastFocus);
      };
    addCommand(context, () => i18n.t("commands.focus-on-last-terminal"), {
      checkCallback: withLastFocusedView(
        (checking, view) => {
          if (!checking) {
            view.focus();
          }
          return true;
        },
        [false],
      ),
      // No hotkeys: hotkeys: [],
      icon: i18n.t("asset:commands.focus-on-last-terminal-icon"),
      id: "focus-on-last-terminal",
    });
    const focusedScopeIDs = new Set([
        addCommand(
          context,
          () => i18n.t("commands.toggle-focus-on-last-terminal"),
          {
            checkCallback: withLastFocusedView(
              (checking, view) => {
                if (!checking) {
                  if (view.isFocused) {
                    view.unfocus();
                  } else {
                    view.focus();
                  }
                }
                return true;
              },
              [false, true],
            ),
            // Meta + ` does not work well on macOS.
            hotkeys: [
              {
                key: "`",
                modifiers: ["Ctrl", "Shift"],
              },
            ],
            icon: i18n.t("asset:commands.toggle-focus-on-last-terminal-icon"),
            id: "toggle-focus-on-last-terminal",
          },
        ).id,
        addCommand(context, () => i18n.t("commands.unfocus-terminal"), {
          checkCallback: withLastFocusedView((checking, view) => {
            if (!checking) {
              view.unfocus();
            }
            return true;
          }),
          // No hotkeys: hotkeys: [],
          icon: i18n.t("asset:commands.unfocus-terminal-icon"),
          id: "unfocus-terminal",
        }).id,
        addCommand(context, () => i18n.t("commands.clear-terminal"), {
          checkCallback: withLastFocusedView((checking, view) => {
            if (!checking) {
              view.emulator?.terminal.clear();
            }
            return true;
          }),
          hotkeys: [
            {
              key: "k",
              modifiers: ["Mod", "Shift"],
            },
          ],
          icon: i18n.t("asset:commands.clear-terminal-icon"),
          id: "clear-terminal",
        }).id,
        addCommand(context, () => i18n.t("commands.close-terminal"), {
          checkCallback: withLastFocusedView((checking, view) => {
            if (!checking) {
              view.leaf.detach();
            }
            return true;
          }),
          hotkeys: [
            {
              key: "w",
              modifiers: ["Mod", "Shift"],
            },
          ],
          icon: i18n.t("asset:commands.close-terminal-icon"),
          id: "close-terminal",
        }).id,
        addCommand(context, () => i18n.t("commands.find-in-terminal"), {
          checkCallback: withLastFocusedView((checking, view) => {
            if (!checking) {
              view.startFind();
            }
            return true;
          }),
          hotkeys: [
            {
              key: "f",
              modifiers: ["Mod", "Shift"],
            },
          ],
          icon: i18n.t("asset:commands.find-in-terminal-icon"),
          id: "find-in-terminal",
        }).id,
      ]),
      handler = this.focusedScope.register(
        null,
        null,
        newHotkeyListener(context, focusedScopeIDs),
      );
    context.register(() => {
      this.focusedScope.unregister(handler);
    });
  }

  public override async setState(
    state: unknown,
    result: ViewStateResult,
  ): Promise<void> {
    const { context: plugin } = this,
      ownState = readStateCollaboratively(
        TerminalView.type.namespaced(plugin),
        state,
      ),
      { value, valid } = TerminalView.State.fix(ownState);
    if (!valid) {
      printMalformedData(plugin, ownState, value);
    }
    await super.setState(state, result);
    const { focus } = value;
    value.focus = false;
    this.state = value;
    this.startEmulator(focus);
    recordViewStateHistory(plugin, result);
  }

  public override getState(): unknown {
    return writeStateCollaboratively(
      super.getState(),
      TerminalView.type.namespaced(this.context),
      this.state,
    );
  }

  public getDisplayText(): string {
    return this.context.language.value.t(
      `components.${TerminalView.type.id}.display-name`,
      {
        interpolation: { escapeValue: false },
        name: this.name,
      },
    );
  }

  public override getIcon(): string {
    return this.context.language.value.t(
      `asset:components.${TerminalView.type.id}.icon`,
    );
  }

  public getViewType(): string {
    return TerminalView.#namespacedType;
  }

  public override onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    const {
      context,
      context: {
        language: { value: i18n },
      },
      leaf,
      app: {
        vault: { adapter },
      },
    } = this;
    menu
      .addSeparator()
      .addItem((item) =>
        item
          .setTitle(i18n.t("components.terminal.menus.clear"))
          .setIcon(i18n.t("asset:components.terminal.menus.clear-icon"))
          .onClick(() => {
            this.emulator?.terminal.clear();
          }),
      )
      .addItem((item) =>
        item
          .setTitle(i18n.t("components.terminal.menus.find"))
          .setIcon(i18n.t("asset:components.terminal.menus.find-icon"))
          .setDisabled(this.find !== null)
          .onClick(() => {
            this.startFind();
          }),
      )
      .addSeparator()
      .addItem((item) =>
        item
          .setTitle(i18n.t("components.terminal.menus.copy"))
          .setIcon(i18n.t("asset:components.terminal.menus.copy-icon"))
          .onClick(async () =>
            TerminalView.spawn(
              context,
              this.state,
              TerminalView.getLeaf(context, this.leaf),
              this.getViewType(),
            ),
          ),
      )
      .addItem((item) =>
        item
          .setTitle(i18n.t("components.terminal.menus.edit"))
          .setIcon(i18n.t("asset:components.terminal.menus.edit-icon"))
          .onClick(() => {
            new EditTerminalModal(context, this.state, async (state) =>
              TerminalView.spawn(context, state, leaf, this.getViewType()),
            ).open();
          }),
      )
      .addItem((item) =>
        item
          .setTitle(i18n.t("components.terminal.menus.restart"))
          .setIcon(i18n.t("asset:components.terminal.menus.restart-icon"))
          .onClick(() => {
            this.startEmulator(true);
          }),
      )
      .addSeparator()
      .addItem((item) =>
        item
          .setTitle(i18n.t("components.terminal.menus.save-as-HTML"))
          .setIcon(i18n.t("asset:components.terminal.menus.save-as-HTML-icon"))
          .setDisabled(!this.emulator?.addons.serialize)
          .onClick(async () => {
            const ser = this.emulator?.addons.serialize;
            if (!ser) {
              return;
            }
            await saveFileAs(
              context,
              adapter,
              new File(
                [
                  ser.serializeAsHTML({
                    includeGlobalBackground: false,
                    onlySelection: false,
                  }),
                ],
                `${this.name}.html`,
                { type: `text/html; charset=${DEFAULT_ENCODING};` },
              ),
            );
          }),
      );
  }

  protected focus(): void {
    const { app, emulator, leaf } = this;
    app.workspace.revealLeaf(leaf);
    emulator?.terminal.focus();
  }

  protected unfocus(): void {
    const {
      app: { workspace },
    } = this;

    // Try to restore focus to the last non-terminal leaf
    const lastActiveOtherLeaf = TerminalView.lastActiveOtherLeaf?.deref();
    if (lastActiveOtherLeaf) {
      if (
        workspace
          .getLeavesOfType(lastActiveOtherLeaf.view.getViewType())
          .includes(lastActiveOtherLeaf)
      ) {
        workspace.setActiveLeaf(lastActiveOtherLeaf, { focus: true });
        return;
      }
      TerminalView.lastActiveOtherLeaf = null;
    }

    // Fallback: just blur the active element
    const {
      contentEl: {
        ownerDocument: { activeElement },
      },
    } = this;
    if (
      instanceOf(activeElement, HTMLElement) ||
      instanceOf(activeElement, SVGElement)
    ) {
      activeElement.blur();
    }
  }

  protected override async onOpen(): Promise<void> {
    await super.onOpen();
    const { focusedScope } = TerminalView,
      { context, contentEl, app } = this,
      { language, statusBarHider } = context,
      { value: i18n } = language,
      { keymap } = app;

    this.register(
      language.onChangeLanguage.listen(() => {
        updateView(context, this);
        this.find?.setI18n(i18n.t);
      }),
    );

    this.register(() => {
      keymap.popScope(focusedScope);
      TerminalView.lastFocusTimes.delete(this);
    });
    this.registerDomEvent(
      contentEl,
      "focusout",
      () => {
        keymap.popScope(focusedScope);
        statusBarHider.update();
      },
      { passive: true },
    );
    this.registerDomEvent(
      contentEl,
      "focusin",
      () => {
        TerminalView.lastFocusTimes.set(this, Date.now());
        keymap.pushScope(focusedScope);
        statusBarHider.update();
      },
      { capture: true, passive: true },
    );
    TerminalView.lastFocusTimes.set(this, Date.now());
    if (this.isFocused) {
      keymap.pushScope(focusedScope);
    }

    this.register(statusBarHider.hide(() => this.hidesStatusBar));
    this.register(() => {
      this.emulator = null;
    });
  }

  protected startFind(): void {
    const { context: plugin, contentEl } = this,
      { language } = plugin,
      { value: i18n } = language;
    if (!this.find) {
      const onFind = (
          direction: FindComponent$.Direction,
          params: FindComponent$.Params,
          incremental = false,
        ): void => {
          const finder = this.emulator?.addons.search;
          if (!finder) {
            return;
          }
          const func =
            direction === "next"
              ? finder.findNext.bind(finder)
              : finder.findPrevious.bind(finder);
          let empty = params.findText === "";
          try {
            func(params.findText, {
              caseSensitive: params.caseSensitive,
              decorations: {
                activeMatchColorOverviewRuler: "#00000000",
                matchOverviewRuler: "#00000000",
              },
              incremental,
              regex: params.regex,
              wholeWord: params.wholeWord,
            });
          } catch (error) {
            /* @__PURE__ */ activeSelf(contentEl).console.debug(error);
            empty = true;
          }
          if (empty) {
            this.find?.setResults("");
          }
        },
        optional: { anchor?: Element } = {};
      assignExact(optional, "anchor", contentEl.firstElementChild ?? void 0);
      this.find = mount(FindComponent, {
        intro: true,
        props: {
          focused: true,
          i18n: i18n.t,
          onClose: () => {
            this.find = null;
          },
          onFind,
          onParamsChanged: (params: FindComponent$.Params) => {
            this.emulator?.addons.search.clearDecorations();
            onFind("previous", params);
          },
        },
        target: contentEl,
        ...optional,
      });
    }
    this.find.focus();
  }

  protected startEmulator(focus: boolean): void {
    const {
        contentEl,
        context,
        context: {
          language: { onChangeLanguage, value: i18n },
          settings,
        },
        leaf,
        state: { profile, cwd, serial },
        app: {
          workspace: { requestSaveLayout },
        },
      } = this,
      noticeSpawn = (): void => {
        notice2(
          () =>
            i18n.t("notices.spawning-terminal", {
              interpolation: { escapeValue: false },
              name: this.name,
            }),
          settings.value.noticeTimeout,
          context,
        );
      };
    if (!PROFILE_PROPERTIES[profile.type].integratable) {
      (async (): Promise<void> => {
        try {
          noticeSpawn();
          await openProfile(context, profile, { cwd: cwd ?? void 0 });
        } catch (error) {
          printError(
            anyToError(error),
            () => i18n.t("errors.error-spawning-terminal"),
            context,
          );
        }
      })();
      leaf.detach();
      return;
    }
    createChildElement(contentEl, "div", (ele) => {
      function warn(error: unknown): void {
        activeSelf(ele).console.warn(error);
      }
      ele.classList.add(TerminalView.type.namespaced(context));
      (async (): Promise<void> => {
        try {
          await awaitCSS(ele);
          noticeSpawn();
          const [
              { CanvasAddon },

              { LigaturesAddon },

              { SearchAddon },

              { Unicode11Addon },

              { WebLinksAddon },

              { WebglAddon },
            ] = await Promise.all([
              xtermAddonCanvas,
              xtermAddonLigatures,
              xtermAddonSearch,
              xtermAddonUnicode11,
              xtermAddonWebLinks,
              xtermAddonWebgl,
            ]),
            emulator = new TerminalView.EMULATOR(
              ele,
              async (terminal) => {
                if (serial) {
                  await writePromise(
                    terminal,
                    i18n.t("components.terminal.restored-history", {
                      datetime: new Date(),
                      interpolation: { escapeValue: false },
                    }),
                  );
                }
                const ret = await openProfile(context, profile, {
                  cwd: cwd ?? void 0,
                  terminal: TerminalView.EMULATOR.type,
                });
                if (ret) {
                  return ret;
                }
                const pty = new TextPseudoterminal(
                  i18n.t("components.terminal.unsupported-profile", {
                    interpolation: { escapeValue: false },
                    profile: JSON.stringify(
                      profile,
                      null,
                      JSON_STRINGIFY_SPACE,
                    ),
                  }),
                );
                pty.onExit
                  .catch(noop satisfies () => unknown as () => unknown)
                  .finally(
                    onChangeLanguage.listen(() => {
                      pty.text = i18n.t(
                        "components.terminal.unsupported-profile",
                        {
                          interpolation: { escapeValue: false },
                          profile: JSON.stringify(
                            profile,
                            null,
                            JSON_STRINGIFY_SPACE,
                          ),
                        },
                      );
                    }),
                  );
                return pty;
              },
              serial ?? void 0,
              {
                allowProposedApi: true,
                ...(profile.type === "invalid"
                  ? {}
                  : cloneAsWritable(profile.terminalOptions, cloneDeep)),
              },
              {
                disposer: new DisposerAddon(
                  () => {
                    ele.remove();
                  },
                  () => {
                    this.title = "";
                  },
                  ele.onWindowMigrated(() => {
                    emulator.reopen();
                    emulator.resize(false).catch(warn);
                  }),
                  () => {
                    this.find?.setResults("");
                  },
                ),
                dragAndDrop: new DragAndDropAddon(ele),
                followTheme: new FollowThemeAddon(context, ele, {
                  enabled(): boolean {
                    return profile.type === "invalid" || profile.followTheme;
                  },
                }),
                ligatures: new LigaturesAddon({}),
                renderer: new RendererAddon(
                  () => new CanvasAddon(),
                  () => new WebglAddon(false),
                ),
                rightClickAction: new RightClickActionAddon(
                  profile.type === "invalid"
                    ? void 0
                    : (): RightClickActionAddon.Action =>
                        profile.rightClickAction,
                ),
                search: new SearchAddon(),
                unicode11: new Unicode11Addon(),
                webLinks: new WebLinksAddon(
                  (event, uri) => openExternal(activeSelf(event), uri),
                  {},
                ),
              },
            ),
            { pseudoterminal, terminal, addons } = emulator,
            { disposer, renderer, search } = addons;
          pseudoterminal
            .then(async (pty0) => pty0.onExit)
            .then(
              (code) => {
                notice2(
                  () =>
                    i18n.t("notices.terminal-exited", {
                      code,
                      interpolation: { escapeValue: false },
                    }),
                  (profile.type === "invalid"
                    ? DEFAULT_SUCCESS_EXIT_CODES
                    : profile.successExitCodes
                  ).includes(code.toString())
                    ? settings.value.noticeTimeout
                    : settings.value.errorNoticeTimeout,
                  context,
                );
              },
              (error: unknown) => {
                printError(
                  anyToError(error),
                  () => i18n.t("errors.error-spawning-terminal"),
                  context,
                );
              },
            );
          terminal.onWriteParsed(requestSaveLayout);
          terminal.onResize(requestSaveLayout);
          terminal.onTitleChange((title) => {
            this.title = title;
          });

          terminal.unicode.activeVersion = "11";
          disposer.push(
            settings.onMutate(
              (settings0) => settings0.preferredRenderer,
              (cur) => {
                renderer.use(cur);
              },
            ),
          );
          renderer.use(settings.value.preferredRenderer);
          search.onDidChangeResults((results0) => {
            const { resultIndex, resultCount } = results0,
              results =
                resultIndex === -1 && resultCount > 0
                  ? i18n.t("components.find.too-many-results", {
                      interpolation: { escapeValue: false },
                      limit: resultCount - 1,
                    })
                  : i18n.t("components.find.results", {
                      interpolation: { escapeValue: false },
                      replace: {
                        count: resultCount,
                        index: resultIndex + 1,
                      },
                    });
            this.find?.setResults(results);
          });

          emulator.resize().catch(warn);
          onResize(ele, (ent) => {
            if (
              ent.contentBoxSize.every(
                (size) => size.blockSize <= 0 || size.inlineSize <= 0,
              )
            ) {
              return;
            }
            emulator.resize(false).catch(warn);
          });
          this.emulator = emulator;
          if (focus) {
            terminal.focus();
          }
        } catch (error) {
          activeSelf(ele).console.error(error);
        }
      })();
    });
  }
}
export namespace TerminalView {
  export const EMULATOR = XtermTerminalEmulator<Addons>;
  export type EMULATOR = XtermTerminalEmulator<Addons>;
  export interface Addons {
    readonly disposer: DisposerAddon;
    readonly dragAndDrop: DragAndDropAddon;
    readonly followTheme: FollowThemeAddon;
    readonly ligatures: LigaturesAddon;
    readonly renderer: RendererAddon;
    readonly rightClickAction: RightClickActionAddon;
    readonly search: SearchAddon;
    readonly unicode11: Unicode11Addon;
    readonly webLinks: WebLinksAddon;
  }
  export interface State {
    readonly profile: Settings.Profile;
    readonly cwd: string | null;
    readonly serial: XtermTerminalEmulator.State | null;
    readonly focus: boolean;
  }
  export namespace State {
    export const DEFAULT: State = deepFreeze({
      cwd: null,
      focus: false,
      profile: Settings.Profile.DEFAULTS.invalid,
      serial: null,
    });
    export function fix(self0: unknown): Fixed<State> {
      const unc = launderUnchecked<State>(self0);
      return markFixed(self0, {
        cwd: fixTyped(DEFAULT, unc, "cwd", ["string", "null"]),
        focus: fixTyped(DEFAULT, unc, "focus", ["boolean"]),
        profile: Settings.Profile.fix(unc.profile).value,
        serial:
          unc.serial === null
            ? null
            : XtermTerminalEmulator.State.fix(unc.serial).value,
      });
    }
  }
  export function getLeaf(
    context: TerminalPlugin,
    leaf?: WorkspaceLeaf,
  ): WorkspaceLeaf {
    const {
        app: {
          workspace,
          workspace: { leftSplit, rightSplit },
        },
        settings,
      } = context,
      newLeaf = ((): WorkspaceLeaf => {
        if (settings.value.createInstanceNearExistingOnes) {
          const existingLeaves = workspace.getLeavesOfType(
              TerminalView.type.namespaced(context),
            ),
            existingLeaf = leaf ?? existingLeaves[existingLeaves.length - 1];
          if (existingLeaf) {
            const root = existingLeaf.getRoot();
            if (root === leftSplit) {
              return workspace.getLeftLeaf(false);
            }
            if (root === rightSplit) {
              return workspace.getRightLeaf(false);
            }
            workspace.setActiveLeaf(existingLeaf);
            return workspace.getLeaf("tab");
          }
        }
        switch (settings.value.newInstanceBehavior) {
          case "replaceTab":
            return workspace.getLeaf();
          case "newTab":
            return workspace.getLeaf("tab");
          case "newLeftTab":
            return workspace.getLeftLeaf(false);
          case "newLeftSplit":
            return workspace.getLeftLeaf(true);
          case "newRightTab":
            return workspace.getRightLeaf(false);
          case "newRightSplit":
            return workspace.getRightLeaf(true);
          case "newHorizontalSplit":
            return workspace.getLeaf("split", "horizontal");
          case "newVerticalSplit":
            return workspace.getLeaf("split", "vertical");
          case "newWindow":
            return workspace.getLeaf("window");
          // No default
        }
      })();
    newLeaf.setPinned(settings.value.pinNewInstance);
    return newLeaf;
  }
  export async function spawn(
    context: TerminalPlugin,
    state: State,
    leaf?: WorkspaceLeaf,
    type: string = TerminalView.type.namespaced(context),
  ): Promise<void> {
    await (leaf ?? getLeaf(context)).setViewState({
      active: true,
      state: newCollaborativeState(
        context,
        new Map([[TerminalView.type, state]]),
      ),
      type,
    });
  }
}
