/** Minimal controls for the Python rows; runs the production row callbacks. */
import {
  UpdatableUI,
  cloneAsWritable,
} from "@polyipseity/obsidian-plugin-library";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { App, ButtonComponent, Setting, TextComponent } from "obsidian";
import type { DeepWritable } from "ts-essentials";
import { vi } from "vitest";
import { TerminalPlugin } from "../../src/main.js";
import { Settings } from "../../src/settings-data.js";
import {
  CONPTY_HOST_POOL,
  type ConPtySpareHost,
  WindowsNamedPipeControlChannel,
} from "../../src/terminal/pseudoterminal.js";

/** Seed returned ownership to test pool disposal independently of pipe I/O. */
export async function withPythonSpare(
  executable: string,
  run: (spare: ConPtySpareHost) => Promise<void>,
): Promise<void> {
  const server = createServer();
  // The UI tests exercise the pool and channel lifecycle, not authentication.
  // Socket transport is covered by pseudoterminal.spec.ts and the native suite.
  vi.spyOn(server, "listen").mockImplementation(() => {
    queueMicrotask(() => server.emit("listening"));
    return server;
  });
  const control = await WindowsNamedPipeControlChannel.create({
      createServer: () => server,
      randomUUID,
      deferred: true,
    }),
    host = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "pipe", "pipe"],
    }),
    exited = new Promise<void>((resolve) => {
      host.once("exit", () => {
        resolve();
      });
    }),
    spare = { control, host, generation: CONPTY_HOST_POOL.generation };
  try {
    CONPTY_HOST_POOL.release(executable, spare);
    await run(spare);
  } finally {
    CONPTY_HOST_POOL.clear();
    host.kill();
    await control.dispose();
    await exited;
  }
}

// The tests need a plugin context without loading managers or patching windows.
vi.mock("../../src/main.js", () => ({
  TerminalPlugin: class {
    public readonly language = { value: { t: (key: string): string => key } };
    public readonly register = vi.fn();
    public readonly registerEvent = vi.fn();
    public readonly addChild = vi.fn();
    public readonly settings = {
      value: Settings.DEFAULT,
      mutate: vi.fn(
        async (mutate: (value: DeepWritable<Settings>) => unknown) => {
          const value = cloneAsWritable(this.settings.value);
          await mutate(value);
          this.settings.value = Settings.fix(value).value;
        },
      ),
      onMutate: vi.fn().mockReturnValue(vi.fn()),
      write: vi.fn().mockResolvedValue(void 0),
    };
    public constructor(public readonly app: App) {}
  },
}));

export async function pythonSettingsContext(
  initial: unknown = {},
): Promise<TerminalPlugin> {
  const context = new TerminalPlugin(new App(), {
    author: "test",
    description: "test",
    id: "terminal-test",
    minAppVersion: "1.4.11",
    name: "Terminal test",
    version: "0.0.0",
  });
  await context.settings.mutate((settings) => {
    Object.assign(settings, Settings.fix(initial).value);
  });
  return context;
}

class PythonText extends TextComponent {
  public override readonly inputEl = document.createElement("input");

  public override setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  public override getValue(): string {
    return this.inputEl.value;
  }

  public override onChange(callback: (value: string) => unknown): this {
    this.inputEl.oninput = () => {
      callback(this.inputEl.value);
    };
    return this;
  }
}

class PythonRow extends Setting {
  public override readonly settingEl = document.createElement("div");
  public override readonly nameEl = document.createElement("div");
  public override readonly descEl = document.createElement("div");
  public readonly buttons: ButtonComponent[] = [];
  public readonly texts: TextComponent[] = [];
  // UpdatableUI reconfigures the same controls on each render.
  public buttonIndex = 0;
  public textIndex = 0;

  public override setName(name: string): this {
    this.nameEl.textContent = name;
    return this;
  }

  public override setDesc(description: string | DocumentFragment): this {
    this.descEl.replaceChildren(description);
    return this;
  }

  public override addButton(
    configure: (button: ButtonComponent) => unknown,
  ): this {
    const index = this.buttonIndex++;
    const button =
      this.buttons[index] ??
      Object.assign(new ButtonComponent(this.settingEl), {
        buttonEl: document.createElement("button"),
      });
    // The shared Obsidian mock keeps click handlers private; use its public
    // button element for these tests just as the real control does.
    vi.spyOn(button, "onClick").mockImplementation((callback) => {
      button.buttonEl.onclick = callback;
      return button;
    });
    vi.spyOn(button, "setTooltip").mockImplementation((tooltip) => {
      button.buttonEl.title = tooltip;
      return button;
    });
    this.buttons[index] = button;
    configure(button);
    return this;
  }

  public override addText(configure: (text: TextComponent) => unknown): this {
    const index = this.textIndex++;
    const text = this.texts[index] ?? new PythonText(this.settingEl);
    this.texts[index] = text;
    configure(text);
    return this;
  }
}

/** Retains real UpdatableUI update/disposal, with only the needed mock controls. */
export function capturePythonRows(): ReadonlyMap<string, PythonRow> {
  const rows = new Map<string, PythonRow>();
  vi.spyOn(UpdatableUI.prototype, "newSetting").mockImplementation(function (
    this: UpdatableUI,
    element,
    configure,
  ) {
    return this.new(
      () => new PythonRow(element),
      (row) => {
        row.buttonIndex = 0;
        row.textIndex = 0;
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

/** Native typing invokes TextComponent.onChange; programmatic setValue does not. */
export function typePythonValue(
  text: TextComponent | undefined,
  value: string,
): HTMLInputElement {
  if (!text) throw new Error("Python text control missing");
  text.inputEl.value = value;
  text.inputEl.dispatchEvent(new Event("input"));
  return text.inputEl;
}
