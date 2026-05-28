import {
  DISABLED_TOOLTIP,
  DOMClasses,
  EditDataModal,
  ListModal,
  Platform,
  SI_PREFIX_SCALE,
  type StatusUI,
  UpdatableUI,
  activeSelf,
  anyToError,
  assignExact,
  clearProperties,
  cloneAsWritable,
  composeSetters,
  consumeEvent,
  createChildElement,
  createDocumentFragment,
  dynamicRequire,
  escapeQuerySelectorAttribute,
  inSet,
  linkSetting,
  notice2,
  printError,
  randomNotIn,
  resetButton,
  setTextToEnum,
  setTextToNumber,
  unexpected,
  useSettings,
  useSubsettings,
} from "@polyipseity/obsidian-plugin-library";
import { constant, identity, noop } from "lodash-es";
import { Modal, Setting } from "obsidian";
import type { DeepWritable } from "ts-essentials";
import { BUNDLE } from "./import.js";
import { CHECK_EXECUTABLE_WAIT, PYTHON_REQUIREMENTS } from "./magic.js";
import {
  DEFAULT_TERMINAL_OPTIONS,
  PROFILE_PRESETS,
  PROFILE_PRESET_ORDERED_KEYS,
} from "./terminal/profile-presets.js";
import { PROFILE_PROPERTIES } from "./terminal/profile-properties.js";
import { Pseudoterminal } from "./terminal/pseudoterminal.js";
import { applyFixedEnv, sanitizeEnv } from "./terminal/environment.js";

import SemVer from "semver/classes/semver.js";
import semverCoerce from "semver/functions/coerce.js";
import getPackageVersion from "./get_package_version.py";
import type { TerminalPlugin } from "./main.js";
import { Settings } from "./settings-data.js";

const childProcess = dynamicRequire<typeof import("node:child_process")>(
    BUNDLE,
    "node:child_process",
  ),
  process = dynamicRequire<typeof import("node:process")>(
    BUNDLE,
    "node:process",
  ),
  util = dynamicRequire<typeof import("node:util")>(BUNDLE, "node:util"),
  execFileP = (async () => {
    const [childProcess2, util2] = await Promise.all([childProcess, util]);
    return util2.promisify(childProcess2.execFile);
  })();

export class TerminalOptionsModal extends EditDataModal<Settings.Profile.TerminalOptions> {
  public constructor(
    context: TerminalPlugin,
    data: Settings.Profile.TerminalOptions,
    options?: TerminalOptionsModal.Options,
  ) {
    const {
      language: { value: i18n },
    } = context;
    super(context, data, Settings.Profile.fixTerminalOptions, {
      ...options,
      elements: ["data"],
      title: () => i18n.t("components.terminal-options.title"),
    });
  }

  protected override draw(
    ui: UpdatableUI,
    element: HTMLElement,
    errorEl: StatusUI,
  ): void {
    const {
        context: {
          language: { value: i18n },
        },
        data,
      } = this,
      temp = new WeakMap<Setting, string>();
    ui.new(
      () => createChildElement(element, "div"),
      (ele) => {
        ele.innerHTML = i18n.t("components.terminal-options.description-HTML");
      },
      (ele) => {
        ele.remove();
      },
    )
      .newSetting(element, (setting) => {
        setting
          .setName(i18n.t("components.terminal-options.font-family"))
          .addText(
            linkSetting(
              () => data.fontFamily ?? "",
              (value) => {
                data.fontFamily = value;
              },
              async () => this.postMutate2(errorEl),
              {
                post(component) {
                  if (data.fontFamily === void 0) {
                    component.setPlaceholder(
                      i18n.t(
                        "components.terminal-options.undefined-placeholder",
                      ),
                    );
                  }
                },
              },
            ),
          )
          .addButton((button) =>
            button
              .setIcon(
                i18n.t("asset:components.terminal-options.undefine-icon"),
              )
              .setTooltip(i18n.t("components.terminal-options.undefine"))
              .onClick(async () => {
                delete data.fontFamily;
                await this.postMutate2(errorEl);
              }),
          )
          .addExtraButton(
            resetButton(
              i18n.t("asset:components.terminal-options.font-family-icon"),
              i18n.t("components.edit-data.reset"),
              () => {
                assignExact(
                  data,
                  "fontFamily",
                  DEFAULT_TERMINAL_OPTIONS.fontFamily,
                );
              },
              async () => this.postMutate2(errorEl),
            ),
          );
      })
      .newSetting(element, (setting) => {
        setting
          .setName(i18n.t("components.terminal-options.font-size"))
          .addText(
            linkSetting(
              () => data.fontSize?.toString() ?? "",
              composeSetters(
                (value) => {
                  if (value) {
                    return false;
                  }
                  delete data.fontSize;
                  return true;
                },
                setTextToNumber((value) => {
                  data.fontSize = value;
                }),
              ),
              async () => this.postMutate2(errorEl),
              {
                post(component) {
                  component.inputEl.type = "number";
                  component.setPlaceholder(
                    i18n.t("components.terminal-options.undefined-placeholder"),
                  );
                },
              },
            ),
          )
          .addButton((button) =>
            button
              .setIcon(
                i18n.t("asset:components.terminal-options.undefine-icon"),
              )
              .setTooltip(i18n.t("components.terminal-options.undefine"))
              .onClick(async () => {
                delete data.fontSize;
                await this.postMutate2(errorEl);
              }),
          )
          .addExtraButton(
            resetButton(
              i18n.t("asset:components.terminal-options.font-size-icon"),
              i18n.t("components.edit-data.reset"),
              () => {
                assignExact(
                  data,
                  "fontSize",
                  DEFAULT_TERMINAL_OPTIONS.fontSize,
                );
              },
              async () => this.postMutate2(errorEl),
            ),
          );
      })
      .newSetting(element, (setting) => {
        setting
          .setName(i18n.t("components.terminal-options.font-weight"))
          .setDesc(
            temp.has(setting)
              ? createDocumentFragment(
                  setting.settingEl.ownerDocument,
                  (frag) => {
                    createChildElement(frag, "span", (ele) => {
                      ele.classList.add(DOMClasses.MOD_WARNING);
                      ele.textContent = i18n.t(
                        "components.terminal-options.invalid-description",
                      );
                    });
                  },
                )
              : "",
          )
          .addText(
            linkSetting(
              () => temp.get(setting) ?? data.fontWeight?.toString() ?? "",
              composeSetters(
                () => {
                  temp.delete(setting);
                  return false;
                },
                (value) => {
                  if (value) {
                    return false;
                  }
                  delete data.fontWeight;
                  return true;
                },
                setTextToNumber((value) => {
                  data.fontWeight = value;
                }),
                setTextToEnum(
                  Settings.Profile.TerminalOptions.FONT_WEIGHTS,
                  (value) => {
                    data.fontWeight = value;
                  },
                ),
                (value) => {
                  temp.set(setting, value);
                  return true;
                },
              ),
              async () => this.postMutate2(errorEl),
              {
                post(component) {
                  component.setPlaceholder(
                    i18n.t("components.terminal-options.undefined-placeholder"),
                  );
                },
              },
            ),
          )
          .addButton((button) =>
            button
              .setIcon(
                i18n.t("asset:components.terminal-options.undefine-icon"),
              )
              .setTooltip(i18n.t("components.terminal-options.undefine"))
              .onClick(async () => {
                delete data.fontWeight;
                temp.delete(setting);
                await this.postMutate2(errorEl);
              }),
          )
          .addExtraButton(
            resetButton(
              i18n.t("asset:components.terminal-options.font-weight-icon"),
              i18n.t("components.edit-data.reset"),
              () => {
                assignExact(
                  data,
                  "fontWeight",
                  DEFAULT_TERMINAL_OPTIONS.fontWeight,
                );
                temp.delete(setting);
              },
              async () => this.postMutate2(errorEl),
            ),
          );
      })
      .newSetting(element, (setting) => {
        setting
          .setName(i18n.t("components.terminal-options.bold-font-weight"))
          .setDesc(
            temp.has(setting)
              ? createDocumentFragment(
                  setting.settingEl.ownerDocument,
                  (frag) => {
                    createChildElement(frag, "span", (ele) => {
                      ele.classList.add(DOMClasses.MOD_WARNING);
                      ele.textContent = i18n.t(
                        "components.terminal-options.invalid-description",
                      );
                    });
                  },
                )
              : "",
          )
          .addText(
            linkSetting(
              () => temp.get(setting) ?? data.fontWeightBold?.toString() ?? "",
              composeSetters(
                () => {
                  temp.delete(setting);
                  return false;
                },
                (value) => {
                  if (value) {
                    return false;
                  }
                  delete data.fontWeightBold;
                  return true;
                },
                setTextToNumber((value) => {
                  data.fontWeightBold = value;
                }),
                setTextToEnum(
                  Settings.Profile.TerminalOptions.FONT_WEIGHTS,
                  (value) => {
                    data.fontWeightBold = value;
                  },
                ),
                (value) => {
                  temp.set(setting, value);
                  return true;
                },
              ),
              async () => this.postMutate2(errorEl),
              {
                post(component) {
                  component.setPlaceholder(
                    i18n.t("components.terminal-options.undefined-placeholder"),
                  );
                },
              },
            ),
          )
          .addButton((button) =>
            button
              .setIcon(
                i18n.t("asset:components.terminal-options.undefine-icon"),
              )
              .setTooltip(i18n.t("components.terminal-options.undefine"))
              .onClick(async () => {
                delete data.fontWeightBold;
                temp.delete(setting);
                await this.postMutate2(errorEl);
              }),
          )
          .addExtraButton(
            resetButton(
              i18n.t("asset:components.terminal-options.bold-font-weight-icon"),
              i18n.t("components.edit-data.reset"),
              () => {
                assignExact(
                  data,
                  "fontWeightBold",
                  DEFAULT_TERMINAL_OPTIONS.fontWeightBold,
                );
                temp.delete(setting);
              },
              async () => this.postMutate2(errorEl),
            ),
          );
      });
    super.draw(ui, element, errorEl);
  }

  protected async postMutate2(errorEl: StatusUI): Promise<void> {
    errorEl.report();
    await this.postMutate();
  }
}
export namespace TerminalOptionsModal {
  type InitialOptions = EditDataModal.Options<Settings.Profile.TerminalOptions>;
  export type PredefinedOptions = {
    readonly [K in never]: InitialOptions[K];
  };
  export type Options = Omit<InitialOptions, keyof PredefinedOptions>;
}

export class ProfileModal extends Modal {
  protected readonly modalUI = new UpdatableUI();
  protected readonly ui = new UpdatableUI();
  protected readonly data;
  readonly #callback;
  readonly #presets;
  #preset = NaN;
  #setupTypedUI = noop;

  public constructor(
    protected readonly context: TerminalPlugin,
    data: Settings.Profile,
    callback: (data_: DeepWritable<typeof data>) => unknown,
    presets: readonly {
      readonly name: string;
      readonly value: Settings.Profile;
    }[] = PROFILE_PRESET_ORDERED_KEYS.map((key) => ({
      get name(): string {
        return context.language.value.t(`profile-presets.${key}`);
      },
      value: PROFILE_PRESETS[key],
    })),
  ) {
    super(context.app);
    this.data = cloneAsWritable(data);
    this.#callback = callback;
    this.#presets = presets;
  }

  public override onOpen(): void {
    super.onOpen();
    const { context, ui, data, titleEl, modalUI } = this,
      { element: listEl, remover: listElRemover } = useSettings(this.contentEl),
      profile = data,
      { language } = context,
      { value: i18n, onChangeLanguage } = language;
    modalUI
      .finally(
        onChangeLanguage.listen(() => {
          modalUI.update();
        }),
      )
      .new(
        constant(titleEl),
        (ele) => {
          ele.textContent = i18n.t("components.profile.title", {
            interpolation: { escapeValue: false },
            name: Settings.Profile.name(profile),
            profile,
          });
        },
        (ele) => {
          ele.textContent = null;
        },
      );
    ui.finally(listElRemover).finally(
      onChangeLanguage.listen(() => {
        ui.update();
      }),
    );
    let keepPreset = false;
    ui.newSetting(listEl, (setting) => {
      setting
        .setName(i18n.t("components.profile.name"))
        .addText(
          linkSetting(
            () => Settings.Profile.name(profile),
            (value) => {
              profile.name = value;
            },
            async () => this.postMutate(),
          ),
        )
        .addExtraButton(
          resetButton(
            i18n.t("asset:components.profile.name-icon"),
            i18n.t("components.profile.reset"),
            () => {
              profile.name = Settings.Profile.DEFAULTS[profile.type].name;
            },
            async () => this.postMutate(),
          ),
        );
    })
      .newSetting(listEl, (setting) => {
        if (!keepPreset) {
          this.#preset = NaN;
        }
        keepPreset = false;
        setting
          .setName(i18n.t("components.profile.preset"))
          .addDropdown(
            linkSetting(
              () => this.#preset.toString(),
              (value) => {
                this.#preset = Number(value);
              },
              async () => {
                const preset = this.#presets[this.#preset];
                if (!preset) {
                  return;
                }
                this.replaceData(cloneAsWritable(preset.value), true);
                this.#setupTypedUI();
                keepPreset = true;
                await this.postMutate();
              },
              {
                pre: (component) => {
                  component
                    .addOption(
                      NaN.toString(),
                      i18n.t("components.profile.preset-placeholder"),
                    )
                    .addOptions(
                      Object.fromEntries(
                        this.#presets.map((selection, index) => [
                          index,
                          selection.name,
                        ]),
                      ),
                    );
                },
              },
            ),
          )
          .addExtraButton(
            resetButton(
              i18n.t("asset:components.profile.preset-icon"),
              DISABLED_TOOLTIP,
              unexpected,
              unexpected,
              {
                post(component) {
                  component.setDisabled(true);
                },
              },
            ),
          );
      })
      .newSetting(listEl, (setting) => {
        setting
          .setName(i18n.t("components.profile.data"))
          .addButton((button) => {
            button
              .setIcon(i18n.t("asset:components.profile.data-icon"))
              .setTooltip(i18n.t("components.profile.data-edit"))
              .onClick(() => {
                new EditDataModal(context, profile, Settings.Profile.fix, {
                  callback: async (profileM): Promise<void> => {
                    this.replaceData(profileM);
                    this.#setupTypedUI();
                    await this.postMutate();
                  },
                  title(): string {
                    return i18n.t("components.profile.data");
                  },
                }).open();
              });
          });
      })
      .embed(
        () => {
          const typedUI = new UpdatableUI(),
            ele = useSubsettings(listEl);
          this.#setupTypedUI = (): void => {
            this.setupTypedUI(typedUI, ele);
          };
          this.#setupTypedUI();
          return typedUI;
        },
        null,
        () => {
          this.#setupTypedUI = noop;
        },
      );
  }

  public override onClose(): void {
    super.onClose();
    this.modalUI.destroy();
    this.ui.destroy();
  }

  protected async postMutate(): Promise<void> {
    const { data, modalUI, ui } = this,
      cb = this.#callback(cloneAsWritable(data));
    modalUI.update();
    ui.update();
    await cb;
  }

  protected replaceData(
    profile: DeepWritable<Settings.Profile>,
    keepName = false,
  ): void {
    const { data } = this,
      { name } = data;
    clearProperties(data);
    Object.assign(data, profile);
    if (keepName) {
      data.name = name;
    }
  }

  protected setupTypedUI(ui: UpdatableUI, element: HTMLElement): void {
    const {
        context,
        context: { settings },
        data,
      } = this,
      profile = data,
      { value: i18n } = context.language;
    ui.destroy();
    ui.newSetting(element, (setting) => {
      setting
        .setName(i18n.t("components.profile.type"))
        .addDropdown(
          linkSetting(
            (): string => profile.type,
            setTextToEnum(Settings.Profile.TYPES, (value) => {
              this.replaceData(
                cloneAsWritable(Settings.Profile.DEFAULTS[value]),
                true,
              );
            }),
            async () => {
              this.#setupTypedUI();
              await this.postMutate();
            },
            {
              pre: (dropdown) => {
                dropdown.addOptions(
                  Object.fromEntries(
                    Settings.Profile.TYPES.map((type) => [
                      type,
                      i18n.t("components.profile.type-options", {
                        interpolation: { escapeValue: false },
                        type,
                      }),
                    ]),
                  ),
                );
                for (const opt of Settings.Profile.TYPES.filter(
                  (type) => !PROFILE_PROPERTIES[type].valid,
                ).flatMap((type) =>
                  Array.from(
                    dropdown.selectEl.querySelectorAll<HTMLOptionElement>(
                      `option[value="${escapeQuerySelectorAttribute(type)}"]`,
                    ),
                  ),
                )) {
                  opt.hidden = true;
                  opt.disabled = true;
                }
              },
            },
          ),
        )
        .addExtraButton(
          resetButton(
            i18n.t("asset:components.profile.type-icon"),
            DISABLED_TOOLTIP,
            unexpected,
            unexpected,
            {
              post(component) {
                component.setDisabled(true);
              },
            },
          ),
        );
    });
    if (profile.type === "invalid") {
      return;
    }
    ui.newSetting(element, (setting) => {
      setting
        .setName(i18n.t("components.profile.terminal-options"))
        .addButton((button) =>
          button
            .setIcon(
              i18n.t("asset:components.profile.terminal-options-edit-icon"),
            )
            .setTooltip(i18n.t("components.profile.terminal-options-edit"))
            .onClick(() => {
              new TerminalOptionsModal(context, profile.terminalOptions, {
                callback: async (value): Promise<void> => {
                  profile.terminalOptions = value;
                  await this.postMutate();
                },
              }).open();
            }),
        )
        .addExtraButton(
          resetButton(
            i18n.t("asset:components.profile.terminal-options-icon"),
            i18n.t("components.profile.reset"),
            () => {
              profile.terminalOptions = cloneAsWritable(
                Settings.Profile.DEFAULTS[profile.type].terminalOptions,
              );
            },
            async () => this.postMutate(),
          ),
        );
    })
      .newSetting(element, (setting) => {
        setting
          .setName(i18n.t("components.profile.follow-theme"))
          .addToggle(
            linkSetting(
              () => profile.followTheme,
              (value) => {
                profile.followTheme = value;
              },
              async () => this.postMutate(),
            ),
          )
          .addExtraButton(
            resetButton(
              i18n.t("asset:components.profile.follow-theme-icon"),
              i18n.t("components.profile.reset"),
              () => {
                profile.followTheme =
                  Settings.Profile.DEFAULTS[profile.type].followTheme;
              },
              async () => this.postMutate(),
            ),
          );
      })
      .newSetting(element, (setting) => {
        const { settingEl } = setting;
        setting
          .setName(i18n.t("components.profile.restore-history"))
          .setDesc(
            createDocumentFragment(settingEl.ownerDocument, (frag) => {
              createChildElement(frag, "span", (ele) => {
                ele.innerHTML = i18n.t(
                  "components.profile.restore-history-description-HTML",
                );
              });
            }),
          )
          .addToggle(
            linkSetting(
              () => profile.restoreHistory,
              (value) => {
                profile.restoreHistory = value;
              },
              async () => this.postMutate(),
            ),
          )
          .addExtraButton(
            resetButton(
              i18n.t("asset:components.profile.restore-history-icon"),
              i18n.t("components.profile.reset"),
              () => {
                profile.restoreHistory =
                  Settings.Profile.DEFAULTS[profile.type].restoreHistory;
              },
              async () => this.postMutate(),
            ),
          );
      })
      .newSetting(element, (setting) => {
        setting
          .setName(i18n.t("components.profile.success-exit-codes"))
          .setDesc(
            i18n.t("components.profile.success-exit-codes-description", {
              count: profile.successExitCodes.length,
              interpolation: { escapeValue: false },
            }),
          )
          .addButton((button) =>
            button
              .setIcon(
                i18n.t("asset:components.profile.success-exit-codes-edit-icon"),
              )
              .setTooltip(i18n.t("components.profile.success-exit-codes-edit"))
              .onClick(() => {
                new ListModal(
                  context,
                  ListModal.stringInputter<string>({
                    back: identity,
                    forth: identity,
                  }),
                  () => "",
                  profile.successExitCodes,
                  {
                    callback: async (value): Promise<void> => {
                      profile.successExitCodes = value;
                      await this.postMutate();
                    },
                    title: (): string =>
                      i18n.t("components.profile.success-exit-codes"),
                  },
                ).open();
              }),
          )
          .addExtraButton(
            resetButton(
              i18n.t("asset:components.profile.success-exit-codes-icon"),
              i18n.t("components.profile.reset"),
              () => {
                profile.successExitCodes = cloneAsWritable(
                  Settings.Profile.DEFAULTS[profile.type].successExitCodes,
                );
              },
              async () => this.postMutate(),
            ),
          );
      });
    switch (profile.type) {
      case "": {
        break;
      }
      case "developerConsole": {
        break;
      }
      case "external":
      case "integrated": {
        ui.newSetting(element, (setting) => {
          setting
            .setName(i18n.t(`components.profile.${profile.type}.executable`))
            .addText(
              linkSetting(
                () => profile.executable,
                (value) => {
                  profile.executable = value;
                },
                async () => this.postMutate(),
              ),
            )
            .addExtraButton(
              resetButton(
                i18n.t(
                  `asset:components.profile.${profile.type}.executable-icon`,
                ),
                i18n.t("components.profile.reset"),
                () => {
                  profile.executable =
                    Settings.Profile.DEFAULTS[profile.type].executable;
                },
                async () => this.postMutate(),
              ),
            );
        }).newSetting(element, (setting) => {
          setting
            .setName(i18n.t(`components.profile.${profile.type}.arguments`))
            .setDesc(
              i18n.t(
                `components.profile.${profile.type}.arguments-description`,
                {
                  count: profile.args.length,
                  interpolation: { escapeValue: false },
                },
              ),
            )
            .addButton((button) =>
              button
                .setIcon(
                  i18n.t(
                    `asset:components.profile.${profile.type}.arguments-edit-icon`,
                  ),
                )
                .setTooltip(
                  i18n.t(`components.profile.${profile.type}.arguments-edit`),
                )
                .onClick(() => {
                  new ListModal(
                    context,
                    ListModal.stringInputter<string>({
                      back: identity,
                      forth: identity,
                    }),
                    () => "",
                    profile.args,
                    {
                      callback: async (value): Promise<void> => {
                        profile.args = value;
                        await this.postMutate();
                      },
                      title: (): string =>
                        i18n.t(`components.profile.${profile.type}.arguments`),
                    },
                  ).open();
                }),
            )
            .addExtraButton(
              resetButton(
                i18n.t(
                  `asset:components.profile.${profile.type}.arguments-icon`,
                ),
                i18n.t("components.profile.reset"),
                () => {
                  profile.args = cloneAsWritable(
                    Settings.Profile.DEFAULTS[profile.type].args,
                  );
                },
                async () => this.postMutate(),
              ),
            );
        });
        ui.newSetting(element, (setting) => {
          setting
            .setName(i18n.t(`components.profile.${profile.type}.environment`))
            .setDesc(
              i18n.t(
                `components.profile.${profile.type}.environment-description`,
                {
                  count: profile.environment.length,
                  interpolation: { escapeValue: false },
                },
              ),
            )
            .addButton((button) =>
              button
                .setIcon(
                  i18n.t(
                    `asset:components.profile.${profile.type}.arguments-edit-icon`,
                  ),
                )
                .setTooltip(
                  i18n.t(`components.profile.${profile.type}.environment-edit`),
                )
                .onClick(() => {
                  const envPair = (
                    k: string,
                    v: string,
                  ): readonly [string, string] => [k, v];
                  new ListModal<readonly [string, string]>(
                    context,
                    (setting, editable, refs) => {
                      setting.addTextArea((textArea) => {
                        textArea
                          .setPlaceholder(
                            i18n.t(
                              `components.profile.${profile.type}.environment-key-placeholder`,
                            ),
                          )
                          .setDisabled(!editable);
                        if (!refs) {
                          textArea.inputEl.style.visibility = "hidden";
                          return;
                        }
                        textArea
                          .setValue(refs.getter()[0])
                          .onChange((value) => {
                            refs.setter((item, index, data) => {
                              data[index] = envPair(value, item[1]);
                            });
                          });
                      });
                      setting.addTextArea((textArea) => {
                        textArea
                          .setPlaceholder(
                            i18n.t(
                              `components.profile.${profile.type}.environment-value-placeholder`,
                            ),
                          )
                          .setDisabled(!editable);
                        if (!refs) {
                          textArea.inputEl.style.visibility = "hidden";
                          return;
                        }
                        textArea
                          .setValue(refs.getter()[1])
                          .onChange((value) => {
                            refs.setter((item, index, data) => {
                              data[index] = envPair(item[0], value);
                            });
                          });
                      });
                    },
                    (): readonly [string, string] => ["", ""],
                    profile.environment,
                    {
                      callback: async (value): Promise<void> => {
                        profile.environment = value;
                        await this.postMutate();
                      },
                      description: (): string =>
                        i18n.t(
                          `components.profile.${profile.type}.environment-list-description`,
                        ),
                      title: (): string =>
                        i18n.t(
                          `components.profile.${profile.type}.environment`,
                        ),
                    },
                  ).open();
                }),
            )
            .addExtraButton(
              resetButton(
                i18n.t(
                  `asset:components.profile.${profile.type}.arguments-icon`,
                ),
                i18n.t("components.profile.reset"),
                () => {
                  profile.environment = cloneAsWritable(
                    Settings.Profile.DEFAULTS[profile.type].environment,
                  );
                },
                async () => this.postMutate(),
              ),
            );
        });
        for (const platform of Pseudoterminal.SUPPORTED_PLATFORMS) {
          ui.newSetting(element, (setting) => {
            setting
              .setName(
                i18n.t("components.profile.platform", {
                  interpolation: { escapeValue: false },
                  type: platform,
                }),
              )
              .setDesc(
                i18n.t(
                  `components.profile.platform-description-${
                    platform === Platform.CURRENT ? "current" : ""
                  }`,
                ),
              )
              .addToggle(
                linkSetting(
                  () =>
                    profile.platforms[platform] ??
                    Settings.Profile.DEFAULTS[profile.type].platforms[platform],
                  (value) => {
                    profile.platforms[platform] = value;
                  },
                  async () => this.postMutate(),
                ),
              )
              .addExtraButton(
                resetButton(
                  i18n.t("asset:components.profile.platform-icon", {
                    interpolation: { escapeValue: false },
                    type: platform,
                  }),
                  i18n.t("components.profile.reset"),
                  () => {
                    profile.platforms[platform] =
                      Settings.Profile.DEFAULTS[profile.type].platforms[
                        platform
                      ];
                  },
                  async () => this.postMutate(),
                ),
              );
          });
        }
        if (profile.type === "integrated") {
          let checkingPython = false;
          ui.newSetting(element, (setting) => {
            setting
              .setName(
                i18n.t(`components.profile.${profile.type}.Python-executable`),
              )
              .setDesc(
                i18n.t(
                  `components.profile.${profile.type}.Python-executable-description`,
                  {
                    interpolation: { escapeValue: false },
                    version: PYTHON_REQUIREMENTS.Python.version,
                  },
                ),
              )
              .addText(
                linkSetting(
                  () => profile.pythonExecutable,
                  (value) => {
                    profile.pythonExecutable = value;
                  },
                  async () => this.postMutate(),
                  {
                    post: (component) => {
                      component.setPlaceholder(
                        i18n.t(
                          `components.profile.${profile.type}.Python-executable-placeholder`,
                        ),
                      );
                    },
                  },
                ),
              )
              .addButton((button) => {
                const { buttonEl } = button,
                  i18nVariant = checkingPython ? "ing" : "";
                button
                  .setIcon(
                    i18n.t(
                      `asset:components.profile.${profile.type}.Python-executable-check${i18nVariant}-icon`,
                    ),
                  )
                  .setTooltip(
                    i18n.t(
                      `components.profile.${profile.type}.Python-executable-check${i18nVariant}`,
                    ),
                  )
                  .onClick(() => {
                    if (checkingPython) {
                      return;
                    }
                    checkingPython = true;
                    (async (): Promise<void> => {
                      try {
                        const [execFileP2, process2, getPackageVersion2] =
                            await Promise.all([
                              execFileP,
                              process,
                              getPackageVersion,
                            ]),
                          env = applyFixedEnv(await sanitizeEnv(process2.env)),
                          { stdout, stderr } = await execFileP2(
                            profile.pythonExecutable,
                            ["--version"],
                            {
                              env,
                              timeout: CHECK_EXECUTABLE_WAIT * SI_PREFIX_SCALE,
                              windowsHide: true,
                            },
                          );
                        if (stdout) {
                          activeSelf(buttonEl).console.log(stdout);
                        }
                        if (stderr) {
                          activeSelf(buttonEl).console.error(stderr);
                        }
                        if (!stdout.trimStart().startsWith("Python ")) {
                          throw new Error(i18n.t("errors.not-Python"));
                        }
                        const msgs = await Promise.all(
                          Object.entries(PYTHON_REQUIREMENTS)
                            .filter(([, { platforms }]) =>
                              inSet(platforms, Platform.CURRENT),
                            )
                            .map(async ([name, { version: req }]) => {
                              let ver: SemVer | null = null;
                              try {
                                if (name === "Python") {
                                  ver = new SemVer(
                                    semverCoerce(stdout, { loose: true }) ??
                                      stdout,
                                    { loose: true },
                                  );
                                } else {
                                  const { stdout: stdout2, stderr: stderr2 } =
                                    await execFileP2(
                                      profile.pythonExecutable,
                                      ["-c", getPackageVersion2, name],
                                      {
                                        env,
                                        timeout:
                                          CHECK_EXECUTABLE_WAIT *
                                          SI_PREFIX_SCALE,
                                        windowsHide: true,
                                      },
                                    );
                                  if (stdout2) {
                                    activeSelf(buttonEl).console.log(stdout2);
                                  }
                                  if (stderr2) {
                                    activeSelf(buttonEl).console.error(stderr2);
                                  }
                                  ver = new SemVer(
                                    semverCoerce(stdout2, { loose: true }) ??
                                      stdout2,
                                    { loose: true },
                                  );
                                }
                              } catch (error) {
                                /* @__PURE__ */ activeSelf(
                                  buttonEl,
                                ).console.debug(error);
                              }
                              const variant =
                                (ver?.compare(req) ?? -1) >= 0
                                  ? ""
                                  : "unsatisfied";
                              return (): string =>
                                i18n.t(
                                  `notices.Python-status-entry-${variant}`,
                                  {
                                    interpolation: { escapeValue: false },
                                    name,
                                    requirement: `>=${req.version}`,
                                    version: ver?.version ?? "",
                                  },
                                );
                            }),
                        );
                        notice2(
                          () => msgs.map((msg) => msg()).join("\n"),
                          settings.value.noticeTimeout,
                          context,
                        );
                      } catch (error) {
                        printError(
                          anyToError(error),
                          () => i18n.t("errors.error-checking-Python"),
                          context,
                        );
                      } finally {
                        checkingPython = false;
                        ui.update();
                      }
                    })();
                    ui.update();
                  });
                if (checkingPython) {
                  button.setCta();
                }
              })
              .addExtraButton(
                resetButton(
                  i18n.t(
                    `asset:components.profile.${profile.type}.Python-executable-icon`,
                  ),
                  i18n.t("components.profile.reset"),
                  () => {
                    profile.pythonExecutable =
                      Settings.Profile.DEFAULTS[profile.type].pythonExecutable;
                  },
                  async () => this.postMutate(),
                ),
              );
          }).newSetting(element, (setting) => {
            setting
              .setName(
                i18n.t(`components.profile.${profile.type}.use-win32-conhost`),
              )
              .setDesc(
                i18n.t(
                  `components.profile.${profile.type}.use-win32-conhost-description`,
                ),
              )
              .addToggle(
                linkSetting(
                  () => profile.useWin32Conhost,
                  (value) => {
                    profile.useWin32Conhost = value;
                  },
                  async () => this.postMutate(),
                ),
              )
              .addExtraButton(
                resetButton(
                  i18n.t(
                    `asset:components.profile.${profile.type}.use-win32-conhost-icon`,
                  ),
                  i18n.t("components.profile.reset"),
                  () => {
                    profile.useWin32Conhost =
                      Settings.Profile.DEFAULTS[profile.type].useWin32Conhost;
                  },
                  async () => this.postMutate(),
                ),
              );
          });
        }
        break;
      }
      // No default
    }
  }
}

export class ProfileListModal extends ListModal<
  DeepWritable<Settings.Profile>
> {
  protected readonly dataProfileList: DeepWritable<
    Omit<ProfileListModal.Data, "entries">
  >;
  protected readonly entryKeys;

  public constructor(
    context: TerminalPlugin,
    data: ProfileListModal.Data,
    options?: ProfileListModal.Options,
  ) {
    const { value: i18n } = context.language,
      dataW = cloneAsWritable(data),
      entryKeys = new Map(dataW.entries.map(([key, value]) => [value, key])),
      callback = options?.callback ?? ((): void => {}),
      keygen = options?.keygen ?? ((): string => self.crypto.randomUUID());
    super(
      context,
      (setting, editable, refs) => {
        setting.addButton((button) => {
          button
            .setIcon(
              i18n.t("asset:components.profile-list.mark-as-default-icon"),
            )
            .setTooltip(i18n.t("components.profile-list.mark-as-default"))
            .setDisabled(!editable);
          if (!refs) {
            button.buttonEl.style.visibility = "hidden";
            return;
          }
          if (
            entryKeys.get(refs.getter()) === this.dataProfileList.defaultProfile
          ) {
            button.setCta();
          }
          button.onClick(async () => {
            await refs.setter((item) => {
              const id = entryKeys.get(item);
              if (id === void 0) {
                return;
              }
              if (id === this.dataProfileList.defaultProfile) {
                // Unset default profile if it's already the default
                this.dataProfileList.defaultProfile = null;
                return;
              }
              // Set the default profile to the clicked profile
              this.dataProfileList.defaultProfile = id;
            });
          });
        });
        setting.addButton((button) => {
          button
            .setIcon(i18n.t("asset:components.profile-list.edit-icon"))
            .setTooltip(i18n.t("components.profile-list.edit"))
            .setDisabled(!editable);
          if (!refs) {
            button.buttonEl.style.visibility = "hidden";
            return;
          }
          button.onClick(() => {
            new ProfileModal(context, refs.getter(), async (value) => {
              await refs.setter(async (item) => {
                clearProperties(item);
                Object.assign(item, value);
                await this.postMutate();
              });
            }).open();
          });
        });
      },
      unexpected,
      dataW.entries.map(([, value]) => value),
      {
        ...options,
        ...({
          callback: async (data0): Promise<void> => {
            await callback({
              ...this.dataProfileList,
              entries: data0.map((profile) => {
                let id = entryKeys.get(profile);
                if (id === void 0) {
                  entryKeys.set(
                    profile,
                    (id = randomNotIn([...entryKeys.values()], keygen)),
                  );
                }
                return [id, cloneAsWritable(profile)];
              }),
            });
          },
        } satisfies ProfileListModal.PredefinedOptions),
        descriptor:
          options?.descriptor ??
          ((profile): string => {
            const id = entryKeys.get(profile) ?? "";
            return i18n.t(
              `components.profile-list.descriptor-${
                Settings.Profile.isCompatible(profile, Platform.CURRENT)
                  ? ""
                  : "incompatible"
              }`,
              {
                info: Settings.Profile.info([id, profile]),
                interpolation: { escapeValue: false },
              },
            );
          }),
        namer:
          options?.namer ??
          ((profile): string => {
            const id = entryKeys.get(profile) ?? "";
            return i18n.t(
              `components.profile-list.namer-${
                Settings.Profile.isCompatible(profile, Platform.CURRENT)
                  ? ""
                  : "incompatible"
              }`,
              {
                info: Settings.Profile.info([id, profile]),
                interpolation: { escapeValue: false },
              },
            );
          }),
        presets:
          options?.presets ??
          PROFILE_PRESET_ORDERED_KEYS.map((key) => ({
            get name(): string {
              return context.language.value.t(`profile-presets.${key}`);
            },
            get value(): DeepWritable<Settings.Profile> {
              return cloneAsWritable(PROFILE_PRESETS[key]);
            },
          })),
        title:
          options?.title ??
          ((): string => i18n.t("components.profile-list.title")),
      },
    );
    this.dataProfileList = dataW;
    this.entryKeys = entryKeys;
  }
}
export namespace ProfileListModal {
  export interface Data {
    readonly defaultProfile: Settings.DefaultProfile;
    readonly entries: readonly Settings.Profile.Entry[];
  }

  type InitialOptions = ListModal.Options<DeepWritable<Settings.Profile>>;
  export type PredefinedOptions = {
    readonly [K in "callback"]: InitialOptions[K];
  };
  export interface Options extends Omit<
    InitialOptions,
    keyof PredefinedOptions
  > {
    readonly callback?: (data: DeepWritable<Data>) => unknown;
    readonly keygen?: () => string;
  }
}

/** Modal for editing a single keymapping (key recording, action, platform, arg). */
export class KeymappingEditModal extends Modal {
  protected readonly modalUI = new UpdatableUI();
  protected readonly ui = new UpdatableUI();
  protected readonly data: DeepWritable<Settings.Keymapping>;
  readonly #callback: (data: DeepWritable<Settings.Keymapping>) => unknown;
  #recordDoc: Document | null = null;
  #recordHandler: ((event: KeyboardEvent) => void) | null = null;

  public constructor(
    protected readonly context: TerminalPlugin,
    keymapping: Settings.Keymapping,
    callback: (data: DeepWritable<Settings.Keymapping>) => unknown,
  ) {
    super(context.app);
    this.data = cloneAsWritable(keymapping);
    this.#callback = callback;
  }

  public override onOpen(): void {
    super.onOpen();
    const { context, data, ui, titleEl, modalUI } = this,
      { element: listEl, remover: listElRemover } = useSettings(this.contentEl),
      doc = this.contentEl.ownerDocument,
      { language } = context,
      { value: i18n, onChangeLanguage } = language;

    const startRecording = async (): Promise<void> => {
      if (this.#recordHandler !== null) {
        return;
      }
      const handler = (event: KeyboardEvent): void => {
        consumeEvent(event);
        if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) {
          return;
        }
        this.#stopRecording();

        data.key = event.key;
        data.ctrl = event.ctrlKey;
        data.alt = event.altKey;
        data.meta = event.metaKey;
        data.shift = event.shiftKey;
        (async () => {
          try {
            await this.postMutate();
          } catch (error) {
            activeSelf(event).console.error(error);
          }
        })();
      };
      this.#recordHandler = handler;
      this.#recordDoc = doc;
      doc.addEventListener("keydown", handler, true);
      ui.update();
      modalUI.update();
    };

    modalUI
      .finally(
        onChangeLanguage.listen(() => {
          modalUI.update();
        }),
      )
      .new(
        constant(titleEl),
        (ele) => {
          ele.textContent =
            this.#recordHandler !== null
              ? i18n.t("components.keymappings.recording")
              : KeymappingEditModal.formatShortcut(data, i18n);
        },
        (ele) => {
          ele.textContent = null;
        },
      );
    ui.finally(listElRemover).finally(
      onChangeLanguage.listen(() => {
        ui.update();
      }),
    );

    // Key recording row: desc shows current shortcut; button toggles recording
    ui.newSetting(listEl, (setting) => {
      const isRecording = this.#recordHandler !== null;
      setting
        .setName(i18n.t("components.keymappings.record"))
        .setDesc(
          isRecording
            ? i18n.t("components.keymappings.recording")
            : KeymappingEditModal.formatShortcut(data, i18n),
        )
        .addButton((button) => {
          button
            .setIcon(i18n.t("asset:components.keymappings.add-icon"))
            .setTooltip(
              isRecording
                ? i18n.t("components.keymappings.recording")
                : i18n.t("components.keymappings.record"),
            )
            .onClick(() => {
              if (isRecording) {
                this.#stopRecording();
                return;
              }
              startRecording();
            });
          if (isRecording) {
            button.setCta();
          }
        });
    });

    // Action dropdown
    ui.newSetting(listEl, (setting) => {
      setting
        .setName(i18n.t("components.keymappings.action"))
        .addDropdown((dd) => {
          for (const action of Settings.KEY_MAPPING_ACTIONS) {
            dd.addOption(
              action,
              i18n.t(`components.keymappings.actions.${action}`),
            );
          }
          dd.setValue(data.action);
          dd.onChange(async (val) => {
            data.action = Settings.isKeymappingAction(val)
              ? val
              : Settings.Keymapping.DEFAULT.action;
            await this.postMutate();
          });
        });
    });

    // Platform dropdown
    ui.newSetting(listEl, (setting) => {
      setting
        .setName(i18n.t("components.keymappings.platform"))
        .addDropdown((dd) => {
          for (const platform of Settings.KEY_MAPPING_PLATFORMS) {
            dd.addOption(
              platform ?? "",
              i18n.t(
                `components.keymappings.platform-options-${platform ?? ""}`,
              ),
            );
          }
          dd.setValue(data.platform ?? "");
          dd.onChange(async (val) => {
            const val2 = val === "" ? null : val;
            data.platform = Settings.isKeymappingPlatform(val2)
              ? val2
              : Settings.Keymapping.DEFAULT.platform;
            await this.postMutate();
          });
        });
    });

    // Arg input — shown only for actions that take an argument
    // Always create both number and text inputs; hide one based on action type.
    // This ensures the input component type cannot change when action changes.
    ui.newSetting(listEl, (setting) => {
      const argType = Settings.ACTION_ARG_TYPES[data.action];
      setting.settingEl.style.display = argType === null ? "none" : "";

      // Number input for numeric actions (scrollLines, scrollPages)
      setting.addText((text) => {
        // Hide/show based on action type
        text.inputEl.style.display = argType === "number" ? "" : "none";

        text.setPlaceholder(
          i18n.t(`components.keymappings.placeholders.${data.action}`),
        );
        text.inputEl.type = "number";
        text.inputEl.step = "1";

        // Display current value if it's a number, else empty
        const numValue = data.actionArg;
        if (typeof numValue === "number") {
          text.setValue(String(numValue));
          text.onChange(async (val) => {
            const parsed = parseInt(val, 10);
            if (!Settings.Keymapping.isValidActionArg("number", parsed)) {
              text.setValue(String(data.actionArg));
              return;
            }
            data.actionArg = parsed;
            await this.postMutate();
          });
        }
      });

      // Text area for string actions (sendEscapeSequence, sendHexCode, sendText)
      setting.addTextArea((text) => {
        // Hide/show based on action type
        text.inputEl.style.display = argType === "string" ? "" : "none";

        text.setPlaceholder(
          i18n.t(`components.keymappings.placeholders.${data.action}`),
        );

        // Display current value if it's a string, else empty
        const strValue = data.actionArg;
        if (typeof strValue === "string") {
          text.setValue(strValue);
          text.onChange(async (val) => {
            if (!Settings.Keymapping.isValidActionArg("string", val)) {
              text.setValue(data.actionArg);
              return;
            }
            data.actionArg = val;
            await this.postMutate();
          });
        }
      });
    });
  }

  public override onClose(): void {
    super.onClose();
    this.#stopRecording();
    this.modalUI.destroy();
    this.ui.destroy();
  }

  #stopRecording(): void {
    const recordDoc = this.#recordDoc,
      recordHandler = this.#recordHandler;
    if (recordDoc === null || recordHandler === null) {
      return;
    }
    recordDoc.removeEventListener("keydown", recordHandler, true);
    this.#recordHandler = null;
    this.#recordDoc = null;
    this.modalUI.update();
    this.ui.update();
  }

  protected async postMutate(): Promise<void> {
    const { data, modalUI, ui } = this,
      cb = this.#callback(cloneAsWritable(data));
    modalUI.update();
    ui.update();
    await cb;
  }

  static formatShortcut(
    mapping: Settings.Keymapping,
    i18n: TerminalPlugin["language"]["value"],
  ): string {
    if (!mapping.key) {
      return i18n.t("components.keymappings.record");
    }
    const shortcut = [
      mapping.ctrl && "Ctrl",
      mapping.alt && "Alt",
      mapping.meta && "Meta",
      mapping.shift && "Shift",
      mapping.key,
    ]
      .filter(Boolean)
      .join("+");
    if (mapping.platform !== null) {
      return `${i18n.t(`generic.platforms.${mapping.platform}`)}: ${shortcut}`;
    }
    return shortcut;
  }
}

/** Modal listing all keymappings with add/remove/reorder and per-item editing. */
export class KeymappingsModal extends ListModal<
  DeepWritable<Settings.Keymapping>
> {
  public constructor(
    context: TerminalPlugin,
    keymappings: Settings.Keymapping[],
    callback: (keymappings: DeepWritable<Settings.Keymapping>[]) => unknown,
  ) {
    const { value: i18n } = context.language;
    super(
      context,
      (setting, editable, refs) => {
        setting.addButton((button) => {
          button
            .setIcon(i18n.t("asset:components.keymappings.edit-icon"))
            .setTooltip(i18n.t("components.keymappings.edit"))
            .setDisabled(!editable);
          if (!refs) {
            button.buttonEl.style.visibility = "hidden";
            return;
          }
          button.onClick(() => {
            new KeymappingEditModal(context, refs.getter(), async (value) => {
              await refs.setter(async (item) => {
                clearProperties(item);
                Object.assign(item, value);
                await this.postMutate();
              });
            }).open();
          });
        });
      },
      () => cloneAsWritable(Settings.Keymapping.DEFAULT),
      cloneAsWritable(keymappings),
      {
        callback: async (data): Promise<void> => {
          await callback(cloneAsWritable(data));
        },
        descriptor: (mapping): string =>
          i18n.t(`components.keymappings.actions.${mapping.action}`),
        namer: (mapping): string =>
          KeymappingEditModal.formatShortcut(mapping, i18n),
        title: (): string => i18n.t("components.keymappings.title"),
      },
    );
  }
}
