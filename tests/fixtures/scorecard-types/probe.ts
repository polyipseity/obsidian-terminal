/**
 * Sample for `tests/src/scorecard-types.test.ts`: one union or intersection
 * member of each kind that becomes `any` once the vendored library does not
 * resolve, next to the spelled-out form that stays a literal type.
 */
import {
  type SemVerString,
  deepFreeze,
} from "@polyipseity/obsidian-plugin-library";

export const INFERRED = deepFreeze(["a", "b"]),
  SPELLED: readonly ["a", "b"] = deepFreeze(["a", "b"]);

export interface Probe {
  /** Inferred through a library value. */
  readonly inferred: (typeof INFERRED)[number] | undefined;
  /** A library type named in the union. */
  readonly library: SemVerString | null;
  /** The same inferred type in an intersection. */
  readonly intersected: (typeof INFERRED)[number] & { readonly tag: true };
  /** Spelled out: still a literal type without the library. */
  readonly spelled: (typeof SPELLED)[number] | undefined;
}
