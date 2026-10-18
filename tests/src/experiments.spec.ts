/**
 * Unit tests for `src/experiments.ts`: the fixer of the stored flags, the gate
 * and the pairing of experiments with their texts.
 *
 * The registry is empty, so every test passes fixture experiments as
 * arguments. The two tests that walk the real registry guard later entries.
 */
import {
  AbstractSettingsManager,
  type AnyObject,
  type SettingsManager,
  launderUnchecked,
  markFixed,
} from "@polyipseity/obsidian-plugin-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXPERIMENTS,
  Experiment,
  type ExperimentFlags,
  type ExperimentSettings,
  describeExperiments,
  fixExperiments,
  isExperimentEnabled,
  whileExperimentEnabled,
} from "../../src/experiments.js";
import { Settings } from "../../src/settings-data.js";

const ALPHA = {
    applies: "live",
    feedback: "https://example.invalid/alpha",
    id: "alpha",
  } as const,
  BETA = {
    applies: "restart",
    feedback: "https://example.invalid/beta",
    id: "beta",
  } as const;

interface FakeSettings<I extends string> extends ExperimentSettings<I> {
  /** Replaces the stored flags and waits for every listener. */
  readonly set: (flags: ExperimentFlags<I>) => Promise<void>;
}

/** A settings source that notifies a listener only when its value changed. */
function fakeSettings<I extends string>(
  initial: ExperimentFlags<I>,
): FakeSettings<I> {
  let value = { experiments: initial };
  const listeners: (() => unknown)[] = [];
  return {
    get value() {
      return value;
    },
    onMutate<V>(
      accessor: (settings: { readonly experiments: ExperimentFlags<I> }) => V,
      callback: (cur: V) => unknown,
    ): () => void {
      let prev = accessor(value);
      const listener = (): unknown => {
        const cur = accessor(value);
        if (cur === prev) {
          return void 0;
        }
        prev = cur;
        return callback(cur);
      };
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
    async set(flags: ExperimentFlags<I>): Promise<void> {
      value = { experiments: flags };
      for (const listener of [...listeners]) {
        await listener();
      }
    },
  };
}

interface MemorySettings extends AbstractSettingsManager.Type {
  readonly experiments: ExperimentFlags<"alpha" | "beta">;
}

/** The library's settings manager, reading nothing and writing nowhere. */
class MemorySettingsManager extends AbstractSettingsManager<MemorySettings> {
  public constructor() {
    super((raw) =>
      markFixed(raw, {
        experiments: fixExperiments(
          launderUnchecked<AnyObject>(raw)["experiments"],
          [ALPHA, BETA],
        ),
      }),
    );
  }

  /** Replaces the stored flags. `mutate` does not run the fixer. */
  public async set(flags: ExperimentFlags<"alpha" | "beta">): Promise<void> {
    await this.mutate((settings) => {
      settings.experiments = { ...flags };
    });
  }

  public write(): void {}

  protected onInvalidData(): void {}

  protected read0(): null {
    return null;
  }
}

/** A loaded manager with every flag off. */
async function memorySettings(): Promise<MemorySettingsManager> {
  const settings = new MemorySettingsManager();
  settings.load();
  await settings.onLoaded;
  return settings;
}

describe("src/experiments.ts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fixExperiments", () => {
    it("keeps a registered id stored as true", () => {
      expect(fixExperiments({ alpha: true }, [ALPHA])).toEqual({ alpha: true });
    });

    // One tuple per case: `it.each` spreads a bare array into arguments.
    it.each([[undefined], [null], ["x"], [7], [true], [[]], [[true]], [{}]])(
      "returns an empty object for %j",
      (raw) => {
        expect(fixExperiments(raw, [ALPHA])).toEqual({});
      },
    );

    it.each([[false], ["true"], [1], [0], [null], [{}], [[]]])(
      "drops a malformed value %j",
      (value) => {
        expect(fixExperiments({ alpha: value }, [ALPHA])).toEqual({});
      },
    );

    it("drops ids that are not registered", () => {
      const fixed = fixExperiments(
        { alpha: true, constructor: true, gone: true },
        [ALPHA],
      );
      expect(fixed).toEqual({ alpha: true });
      expect(Object.keys(fixed)).toEqual(["alpha"]);
      // An inherited flag is not a stored flag.
      expect(fixExperiments(Object.create({ alpha: true }), [ALPHA])).toEqual(
        {},
      );
      // Parsed JSON can hold an own `__proto__` key, which a copy inherits from.
      expect(
        fixExperiments(JSON.parse('{"__proto__":{"alpha":true}}'), [ALPHA]),
      ).toEqual({});
    });

    it("does not change its input", () => {
      const stored = Object.freeze({
        alpha: true,
        gone: Object.freeze({ nested: true }),
      });
      expect(fixExperiments(stored, [ALPHA])).toEqual({ alpha: true });
      expect(stored).toEqual({ alpha: true, gone: { nested: true } });
    });

    it("drops a flag whose experiment left the registry", () => {
      const stored = Object.freeze({ alpha: true, beta: true });
      expect(fixExperiments(stored, [ALPHA, BETA])).toEqual({
        alpha: true,
        beta: true,
      });
      // Alpha graduated or was removed.
      expect(fixExperiments(stored, [BETA])).toEqual({ beta: true });
      expect(fixExperiments(stored, [])).toEqual({});
    });
  });

  describe("isExperimentEnabled", () => {
    it("is true only for a stored true", () => {
      const settings = {
        experiments: fixExperiments({ alpha: true }, [ALPHA, BETA]),
      };
      expect(isExperimentEnabled(settings, "alpha")).toBe(true);
      expect(isExperimentEnabled(settings, "beta")).toBe(false);
      expect(isExperimentEnabled<"alpha">({ experiments: {} }, "alpha")).toBe(
        false,
      );
      // @ts-expect-error -- "beta" is not an id of these flags.
      isExperimentEnabled({ experiments: fixExperiments({}, [ALPHA]) }, "beta");
    });

    it("is false for every registered experiment by default", () => {
      const registered: readonly Experiment[] = EXPERIMENTS;
      for (const { id } of registered) {
        expect(isExperimentEnabled<string>(Settings.DEFAULT, id), id).toBe(
          false,
        );
      }
    });
  });

  describe("whileExperimentEnabled", () => {
    /** Gates a spied start on alpha; the settings source also knows beta. */
    function watchAlpha(initial: ExperimentFlags<"alpha" | "beta">) {
      const settings = fakeSettings(initial),
        stop = vi.fn(),
        start = vi.fn(() => stop);
      return {
        dispose: whileExperimentEnabled(settings, "alpha", start),
        settings,
        start,
        stop,
      };
    }

    it("does not call start while the experiment is off", async () => {
      const { settings, start } = watchAlpha({});
      await settings.set({ beta: true });
      expect(start).not.toHaveBeenCalled();
    });

    it("calls start when turned on and its disposer when turned off", async () => {
      const { settings, start, stop } = watchAlpha({});
      await settings.set({ alpha: true });
      expect(start).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
      await settings.set({});
      expect(start).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
    });

    it("starts at once when the experiment is already on", () => {
      const { start, stop } = watchAlpha({ alpha: true });
      expect(start).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
    });

    it("starts again after off and on", async () => {
      const { settings, start, stop } = watchAlpha({});
      await settings.set({ alpha: true });
      // A change that leaves the flag as it is calls neither.
      await settings.set({ alpha: true, beta: true });
      expect(start).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
      await settings.set({ beta: true });
      await settings.set({});
      expect(stop).toHaveBeenCalledOnce();
      await settings.set({ alpha: true });
      expect(start).toHaveBeenCalledTimes(2);
      expect(stop).toHaveBeenCalledOnce();
    });

    it("the returned disposer stops a running experiment and unsubscribes", async () => {
      const { dispose, settings, start, stop } = watchAlpha({ alpha: true });
      dispose();
      expect(stop).toHaveBeenCalledOnce();
      await settings.set({});
      await settings.set({ alpha: true });
      expect(start).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
    });

    it("the returned disposer does nothing more while off", async () => {
      const { dispose, settings, start, stop } = watchAlpha({});
      dispose();
      await settings.set({ alpha: true });
      expect(start).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
    });

    it("does not start a scope that an earlier listener disposed in the same change", async () => {
      const settings = fakeSettings<"alpha" | "beta">({}),
        start = vi.fn(() => vi.fn());
      let dispose = (): void => {};
      // Registered first, so it runs before the gate hears of the change.
      settings.onMutate(
        (value) => isExperimentEnabled(value, "beta"),
        () => {
          dispose();
        },
      );
      dispose = whileExperimentEnabled(settings, "alpha", start);
      await settings.set({ alpha: true, beta: true });
      expect(start).not.toHaveBeenCalled();
    });

    it("stops at once when start disposes its own scope", async () => {
      const settings = fakeSettings<"alpha">({}),
        stop = vi.fn();
      let dispose = (): void => {};
      const start = vi.fn(() => {
        dispose();
        return stop;
      });
      dispose = whileExperimentEnabled(settings, "alpha", start);
      await settings.set({ alpha: true });
      expect(stop).toHaveBeenCalledOnce();
      await settings.set({});
      expect(start).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
    });

    it("an error thrown by start is logged and does not escape", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {}),
        settings = fakeSettings<"alpha">({}),
        failure = new Error("start failed"),
        start = vi
          .fn<() => () => void>()
          .mockImplementationOnce(() => {
            throw failure;
          })
          .mockImplementation(() => vi.fn());
      whileExperimentEnabled(settings, "alpha", start);
      await expect(settings.set({ alpha: true })).resolves.toBeUndefined();
      // The log names the experiment and keeps the error, with its stack.
      expect(logged).toHaveBeenCalledExactlyOnceWith(
        'Experiment "alpha":',
        failure,
      );
      await settings.set({});
      await settings.set({ alpha: true });
      expect(start).toHaveBeenCalledTimes(2);
      expect(logged).toHaveBeenCalledOnce();
    });

    it("an error thrown by the disposer is logged and does not escape", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {}),
        settings = fakeSettings<"alpha">({ alpha: true }),
        failure = new Error("stop failed"),
        stop = vi.fn(() => {
          throw failure;
        }),
        start = vi.fn(() => stop);
      whileExperimentEnabled(settings, "alpha", start);
      await expect(settings.set({})).resolves.toBeUndefined();
      expect(stop).toHaveBeenCalledOnce();
      expect(logged).toHaveBeenCalledExactlyOnceWith(
        'Experiment "alpha":',
        failure,
      );
      await settings.set({ alpha: true });
      expect(start).toHaveBeenCalledTimes(2);
    });

    it("the change has applied when the settings change resolves", async () => {
      vi.useFakeTimers();
      try {
        const { settings, start, stop } = watchAlpha({});
        await settings.set({ alpha: true });
        expect(start).toHaveBeenCalledOnce();
        await settings.set({});
        expect(stop).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("accepts the plugin's settings manager as it is", () => {
      const check = (
        manager: SettingsManager<Settings>,
      ): ExperimentSettings<never> => manager;
      expect(check).toBeTypeOf("function");
    });

    // The fake above waits for each listener in turn. The library's manager
    // calls them all in one pass, under a lock, and rejects when one rejects.
    describe("on the library's settings manager", () => {
      it("ends stopped after on and off without a wait in between", async () => {
        const settings = await memorySettings(),
          stop = vi.fn(),
          start = vi.fn(() => stop);
        whileExperimentEnabled(settings, "alpha", start);
        await Promise.all([settings.set({ alpha: true }), settings.set({})]);
        expect(start).toHaveBeenCalledOnce();
        expect(stop).toHaveBeenCalledOnce();
        expect(settings.value.experiments).toEqual({});
      });

      it("a start that throws neither rejects the change nor silences another listener", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => {}),
          settings = await memorySettings(),
          other = vi.fn();
        whileExperimentEnabled(settings, "alpha", () => {
          throw new Error("start failed");
        });
        settings.onMutate(
          (value) => isExperimentEnabled(value, "alpha"),
          other,
        );
        await expect(settings.set({ alpha: true })).resolves.toBeUndefined();
        expect(other).toHaveBeenCalledOnce();
        expect(logged).toHaveBeenCalledOnce();
      });

      it("does not start a scope that an earlier listener disposed in the same change", async () => {
        const settings = await memorySettings(),
          start = vi.fn(() => vi.fn());
        let dispose = (): void => {};
        settings.onMutate(
          (value) => isExperimentEnabled(value, "beta"),
          () => {
            dispose();
          },
        );
        dispose = whileExperimentEnabled(settings, "alpha", start);
        await settings.set({ alpha: true, beta: true });
        expect(start).not.toHaveBeenCalled();
      });
    });
  });

  describe("describeExperiments", () => {
    const texts = (name: string): Experiment.Presentation => ({
      effect: () => `${name} effect.`,
      name: () => name,
      risk: () => `${name} risk.`,
    });

    it("pairs every experiment with its texts in registry order", () => {
      const rows = describeExperiments([BETA, ALPHA], {
        alpha: texts("Alpha"),
        beta: texts("Beta"),
      });
      expect(
        rows.map((row) => ({
          applies: row.applies,
          effect: row.effect(),
          feedback: row.feedback,
          id: row.id,
          name: row.name(),
          risk: row.risk(),
        })),
      ).toEqual([
        { ...BETA, effect: "Beta effect.", name: "Beta", risk: "Beta risk." },
        {
          ...ALPHA,
          effect: "Alpha effect.",
          name: "Alpha",
          risk: "Alpha risk.",
        },
      ]);
      expect(describeExperiments([], {})).toEqual([]);
      // @ts-expect-error -- beta has no texts.
      describeExperiments([ALPHA, BETA], { alpha: texts("Alpha") });
      // @ts-expect-error -- alpha is not registered.
      describeExperiments([], { alpha: texts("Alpha") });
      describeExperiments([ALPHA], {
        // @ts-expect-error -- optionz is no key of the texts.
        alpha: { ...texts("Alpha"), optionz: (): void => {} },
      });
      describeExperiments([ALPHA], {
        // @ts-expect-error -- id is the registry's: the texts would replace it.
        alpha: { ...texts("Alpha"), id: "other" },
      });
      describeExperiments([ALPHA], {
        alpha: {
          effect: () => "e",
          name: () => "n",
          options: (container) => {
            container.remove();
          },
          risk: () => "r",
        },
      });
    });
  });

  describe("EXPERIMENTS", () => {
    it("holds only well-formed experiments", () => {
      const registered: readonly Experiment[] = EXPERIMENTS,
        ids = registered.map(({ id }) => id),
        applies: readonly string[] = Experiment.APPLIES;
      expect(new Set(ids).size).toBe(ids.length);
      for (const experiment of registered) {
        expect(experiment.id).toMatch(/^[a-z][A-Za-z0-9]*$/u);
        expect(experiment.feedback, experiment.id).toMatch(/^https:\/\//u);
        expect(applies, experiment.id).toContain(experiment.applies);
      }
    });
  });
});
