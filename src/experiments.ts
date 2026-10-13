/**
 * Experimental features: the registry and the gate.
 *
 * Feature code asks `isExperimentEnabled` or runs inside
 * `whileExperimentEnabled`. It never reads the stored flags itself.
 */
import {
  type AnyObject,
  deepFreeze,
  launderUnchecked,
} from "@polyipseity/obsidian-plugin-library";

export interface Experiment {
  /** Key of the stored flag and of the texts. Lower camel case. Never reused. */
  readonly id: string;
  /** Where feedback goes: an https URL. */
  readonly feedback: string;
  /** How a change of the toggle takes effect. */
  readonly applies: Experiment.Applies;
}
export namespace Experiment {
  export const APPLIES = deepFreeze(["live", "newTerminals", "restart"]);
  export type Applies = (typeof APPLIES)[number];

  /** What the settings row of an experiment shows. */
  export interface Presentation {
    readonly name: () => string;
    /** One sentence. */
    readonly effect: () => string;
    /** The known risk, without the "Known risk:" label. */
    readonly risk: () => string;
    /**
     * Draws the rows of the experiment's own options into `container`.
     * Called once, the first time the settings tab updates while the
     * experiment is on.
     */
    readonly options?: (container: HTMLElement) => void;
  }
  export interface Row extends Experiment, Presentation {}
}

/** Every experiment of this version. One line each. */
export const EXPERIMENTS = deepFreeze([]) satisfies readonly Experiment[];

/** `never` while the registry is empty. */
export type ExperimentId = (typeof EXPERIMENTS)[number]["id"];

/** The stored flags: a key is present, with `true`, only for an experiment that is on. */
// A mapped type, so `type` and not `interface`.
export type ExperimentFlags<I extends string = ExperimentId> = {
  readonly [K in I]?: true;
};

/** The part of a settings manager the gate needs. */
export interface ExperimentSettings<I extends string> {
  readonly value: { readonly experiments: ExperimentFlags<I> };
  onMutate<V>(
    accessor: (settings: { readonly experiments: ExperimentFlags<I> }) => V,
    callback: (cur: V) => unknown,
  ): () => void;
}

/**
 * Keeps the flag of every experiment in `experiments` that is stored as
 * `true` and drops everything else. Walks the registry, not the input, so an
 * unknown or retired id cannot survive.
 */
export function fixExperiments<E extends Experiment>(
  raw: unknown,
  experiments: readonly E[],
): { [K in E["id"]]?: true } {
  const unc = launderUnchecked<AnyObject>(raw),
    ret: { [K in E["id"]]?: true } = {};
  for (const { id } of experiments) {
    const key: E["id"] = id;
    if (unc[key] === true) {
      ret[key] = true;
    }
  }
  return ret;
}

/** Whether the user turned the experiment on. */
export function isExperimentEnabled<I extends string>(
  settings: { readonly experiments: ExperimentFlags<I> },
  id: NoInfer<I>,
): boolean {
  return settings.experiments[id] === true;
}

/**
 * Runs `start` while the experiment is on: at once if it already is, and again
 * each time it is turned on. Calls the function `start` returned when it is
 * turned off. `start` and that function are synchronous and must not write
 * settings. An error from either is logged and does not reach the settings
 * change that caused it.
 *
 * @returns stops a running experiment and ends the subscription
 */
export function whileExperimentEnabled<I extends string>(
  settings: ExperimentSettings<I>,
  id: NoInfer<I>,
  start: () => () => void,
): () => void {
  let stop: (() => void) | null = null;
  const apply = (on: boolean): void => {
      if (on === (stop !== null)) {
        return;
      }
      try {
        if (stop === null) {
          stop = start();
        } else {
          const stop0 = stop;
          stop = null;
          stop0();
        }
      } catch (error) {
        self.console.error(error);
      }
    },
    unlisten = settings.onMutate(
      (value) => isExperimentEnabled(value, id),
      apply,
    );
  apply(isExperimentEnabled(settings.value, id));
  return (): void => {
    unlisten();
    apply(false);
  };
}

/** Pairs every experiment with its texts, in registry order. */
export function describeExperiments<E extends Experiment>(
  experiments: readonly E[],
  presentations: { readonly [K in E["id"]]: Experiment.Presentation },
): readonly Experiment.Row[] {
  return experiments.map((experiment) => {
    const id: E["id"] = experiment.id;
    return { ...experiment, ...presentations[id] };
  });
}
