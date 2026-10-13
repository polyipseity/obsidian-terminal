/**
 * Unit tests for `src/terminal/tab-icons.ts`, and checks of the stylesheet
 * that drives the icons, `src/terminal/tab-status.css`. The two are one
 * feature: the icon carries the tile and every mark, the stylesheet decides
 * what shows.
 *
 * Nothing is rendered here. The icon is read as XML into a tree; the
 * stylesheet is split into rules; and a small selector matcher with the
 * cascade (specificity, then order) says what the rules declare for a part
 * of an icon on a tab in a given state. That is how the tests below ask what
 * a tab shows. happy-dom's own matcher is not used: it reads `:is()` with a
 * descendant inside wrongly (20.11.1) and knows no pseudo-elements. The
 * readers throw on whatever they do not know, so markup or a selector they
 * cannot judge fails the tests instead of passing unread.
 */
import {
  TAB_ICON_CLASSES,
  TAB_ICON_LINE_TILE,
  TAB_ICON_MARKS,
  TAB_ICON_TILE_BOX,
  TAB_ICON_WRAPPER_ATTRIBUTES,
  composeTabIcon,
  tabIconSkinned,
} from "../../../src/terminal/tab-icons.js";
import {
  TAB_STATUS_ATTRIBUTES,
  type TabStatusDisplay,
} from "../../../src/terminal/tab-status.js";
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { Settings } from "../../../src/settings-data.js";
import { TAB_SKINS } from "../../../src/terminal/tab-skins.js";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const SETS = Settings.TAB_ICON_SETS,
  /** The at-rules of the stylesheet: what must hold of the device for their rules to apply. */
  MOTION = "@media (prefers-reduced-motion: no-preference)",
  HOVER = "@media (hover: hover)",
  /** Whether the browser can place a box from another element (Chromium 125 and later). */
  ANCHORS = "@supports (left: anchor(left))",
  /** Whether it can also keep an anchor's name to one element (Chromium 131 and later). */
  SCOPES = "@supports (anchor-scope: --tts-icon)",
  /** Between the at-rules a rule sits in, from the outermost. */
  INSIDE = " / ",
  /** How far an icon beside a title is lowered: `--tts-down` on its container. */
  LOWERING = "var(--tts-drop, calc(var(--tab-font-size, 13px) * 0.06))",
  /** The same on the drawing, as a margin above that the one below takes back. */
  CARRIED = "var(--tts-down, 0px) calc(-1 * var(--tts-down, 0px))";

// ---------- The icon, read as XML ----------

/** An element of the icon, or of the page around it. */
interface Part {
  readonly tag: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly classes: ReadonlySet<string>;
  readonly children: readonly Part[];
}

/** An element with everything it lies in, outermost first. */
type Chain = readonly Part[];

function part(
  tag: string,
  attributes: ReadonlyMap<string, string>,
  children: readonly Part[],
): Part {
  return {
    attributes,
    children,
    classes: new Set(
      (attributes.get("class") ?? "").split(" ").filter(Boolean),
    ),
    tag,
  };
}

/** An element of the page: a `div` with these classes around these children. */
function box(
  classes: string,
  children: readonly Part[],
  attributes: Readonly<Record<string, string>> = {},
): Part {
  return part(
    "div",
    new Map([["class", classes], ...Object.entries(attributes)]),
    children,
  );
}

const XML_TAG =
  /<(?<close>\/)?(?<tag>[A-Za-z][\w.-]*)(?<attributes>(?:\s+[\w:.-]+="[^"<&]*")*)\s*(?<empty>\/)?>/uy;

/**
 * Reads markup as strict XML: one root, every element closed by its own
 * name, attributes in double quotes and named once, and no text. Anything
 * else throws.
 */
function readXml(source: string): Part {
  let cursor = 0;
  const tagAt = (): Readonly<Record<string, string | undefined>> => {
      XML_TAG.lastIndex = cursor;
      const groups = XML_TAG.exec(source)?.groups;
      if (!groups) {
        throw new Error(`no tag at ${String(cursor)}`);
      }
      cursor = XML_TAG.lastIndex;
      return groups;
    },
    element = (): Part => {
      const open = tagAt(),
        tag = open["tag"] ?? "",
        attributes = new Map<string, string>(),
        children: Part[] = [];
      if (open["close"] !== undefined) {
        throw new Error(`</${tag}> closes nothing`);
      }
      for (const match of (open["attributes"] ?? "").matchAll(
        /(?<name>[\w:.-]+)="(?<value>[^"]*)"/gu,
      )) {
        const name = match.groups?.["name"] ?? "";
        if (attributes.has(name)) {
          throw new Error(`<${tag}> names ${name} twice`);
        }
        attributes.set(name, match.groups?.["value"] ?? "");
      }
      if (open["empty"] === undefined) {
        while (!source.startsWith("</", cursor)) {
          children.push(element());
        }
        const close = tagAt();
        if (close["tag"] !== tag || close["attributes"] !== "") {
          throw new Error(`<${tag}> closed by </${close["tag"] ?? ""}>`);
        }
      }
      return part(tag, attributes, children);
    },
    root = element();
  if (cursor !== source.length) {
    throw new Error("more than one root");
  }
  return root;
}

/** The chain itself and that of everything inside its last element. */
function within(chain: Chain): readonly Chain[] {
  const last = chain.at(-1);
  return last
    ? [chain, ...last.children.flatMap((child) => within([...chain, child]))]
    : [];
}

/** Everything of a class at or inside the last element of a chain. */
function parts(chain: Chain, name: string): readonly Chain[] {
  return within(chain).filter((found) => found.at(-1)?.classes.has(name));
}

/** The one of a list that must hold exactly one. */
function one<T>(found: readonly T[], what: string): T {
  const [first, ...rest] = found;
  if (first === undefined || rest.length > 0) {
    throw new Error(`${String(found.length)} of ${what}, not one`);
  }
  return first;
}

/** The last element of a chain. */
function subject(chain: Chain): Part {
  return one(chain.slice(-1), "subject");
}

/** A numeric attribute; `NaN` where it is missing, so that a comparison fails. */
function number(of: Part, name: string): number {
  return Number(of.attributes.get(name) ?? Number.NaN);
}

/** Where a `transform="translate(x y)"` puts an element. */
function place(of: Part): { readonly x: number; readonly y: number } {
  const found = /^translate\((?<x>-?[\d.]+) (?<y>-?[\d.]+)\)$/u.exec(
    of.attributes.get("transform") ?? "",
  )?.groups;
  return { x: Number(found?.["x"]), y: Number(found?.["y"]) };
}

const DRAWN = new Map(SETS.map((set) => [set, readXml(composeTabIcon(set))]));

/** The icon of a set, as a tree. */
function drawn(set: Settings.TabIconSet): Part {
  return one(
    [...DRAWN].filter(([name]) => name === set).map(([, icon]) => icon),
    set,
  );
}

/** Whether a name is that of a rendered tile. */
function isSkin(name: string): name is keyof typeof TAB_SKINS {
  return name in TAB_SKINS;
}

/** The rendered tile a set stands on, or `null` for the set drawn in lines alone. */
function tileOf(set: Settings.TabIconSet): keyof typeof TAB_SKINS | null {
  return isSkin(set) ? set : null;
}

// ---------- The stylesheet, read as rules ----------

interface Rule {
  readonly selectors: readonly string[];
  readonly body: string;
  /** The at-rules the rule sits in, from the outermost, or an empty string. */
  readonly at: string;
}
interface Sheet {
  readonly rules: readonly Rule[];
  readonly keyframes: ReadonlyMap<string, string>;
}

/** Splits on commas that are not inside parentheses. */
function splitSelectors(text: string): readonly string[] {
  const found: string[] = [];
  let depth = 0,
    current = "";
  for (const char of text) {
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    }
    if (char === "," && depth === 0) {
      found.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  found.push(current);
  // Prettier breaks a long `:is(...)` over lines; read it as one line.
  return found.map((selector) =>
    selector
      .replace(/\s+/gu, " ")
      .replace(/\( /gu, "(")
      .replace(/ \)/gu, ")")
      .trim(),
  );
}

/** Index of the brace that closes the block opened at `open`. */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  for (let index = open; index < css.length; index++) {
    if (css[index] === "{") {
      depth += 1;
    } else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error("unbalanced braces");
}

/** A parser just good enough for a stylesheet without strings holding braces. */
function parse(source: string): Sheet {
  const rules: Rule[] = [],
    keyframes = new Map<string, string>(),
    walk = (css: string, at: string): void => {
      let cursor = 0;
      for (;;) {
        const open = css.indexOf("{", cursor);
        if (open < 0) {
          return;
        }
        const close = blockEnd(css, open),
          prelude = css.slice(cursor, open).trim(),
          body = css.slice(open + 1, close);
        if (prelude.startsWith("@keyframes")) {
          keyframes.set(prelude.slice("@keyframes".length).trim(), body);
        } else if (prelude.startsWith("@")) {
          walk(body, at === "" ? prelude : `${at}${INSIDE}${prelude}`);
        } else {
          rules.push({ at, body, selectors: splitSelectors(prelude) });
        }
        cursor = close + 1;
      }
    };
  walk(source.replace(/\/\*[\s\S]*?\*\//gu, ""), "");
  return { keyframes, rules };
}

/** What a block declares, by property. */
function declarations(body: string): ReadonlyMap<string, string> {
  return new Map(
    body
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const colon = declaration.indexOf(":");
        if (colon < 0 || declaration.includes("!important")) {
          throw new Error(`cannot read "${declaration}"`);
        }
        return [
          declaration.slice(0, colon).trim(),
          declaration
            .slice(colon + 1)
            .replace(/\s+/gu, " ")
            .trim(),
        ];
      }),
  );
}

type Pseudo = "after" | "before" | null;
type Simple =
  | { readonly kind: "any" }
  | {
      readonly kind: "attribute";
      readonly name: string;
      readonly value: string | null;
    }
  | { readonly kind: "class"; readonly name: string }
  | { readonly kind: "hover" }
  | { readonly kind: "is"; readonly options: readonly Complex[] };
interface Compound {
  /** How it stands to the compound on its left: inside it, or directly inside it. */
  readonly combinator: " " | ">" | null;
  readonly simples: readonly Simple[];
}
interface Complex {
  readonly compounds: readonly Compound[];
  readonly pseudo: Pseudo;
}

const SELECTOR_TOKEN =
  /\s*>\s*|\s+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]|::[\w-]+|:[\w-]+|\*/uy;

/**
 * Reads one selector: classes, attributes, `*`, `:is()`, `:hover`, the two
 * combinators and `::before` / `::after` at the end. Anything else throws.
 */
function readSelector(text: string): Complex {
  const compounds: Compound[] = [],
    unread = (): Error => new Error(`cannot read the selector "${text}"`);
  let simples: Simple[] = [],
    combinator: Compound["combinator"] = null,
    pseudo: Pseudo = null,
    cursor = 0;
  while (cursor < text.length) {
    SELECTOR_TOKEN.lastIndex = cursor;
    const token = SELECTOR_TOKEN.exec(text)?.[0];
    // Nothing follows a pseudo-element.
    if (token === undefined || pseudo !== null) {
      throw unread();
    }
    cursor += token.length;
    if (token.trim() === "" || token.trim() === ">") {
      if (simples.length === 0) {
        throw unread();
      }
      compounds.push({ combinator, simples });
      simples = [];
      combinator = token.trim() === ">" ? ">" : " ";
    } else if (token === "::before" || token === "::after") {
      pseudo = token === "::before" ? "before" : "after";
    } else if (token === ":is") {
      const close = text[cursor] === "(" ? blockEndOfParens(text, cursor) : -1;
      if (close < 0) {
        throw unread();
      }
      simples.push({
        kind: "is",
        options: splitSelectors(text.slice(cursor + 1, close)).map(
          readSelector,
        ),
      });
      cursor = close + 1;
    } else if (token === ":hover") {
      simples.push({ kind: "hover" });
    } else if (token === "*") {
      simples.push({ kind: "any" });
    } else if (token.startsWith(".")) {
      simples.push({ kind: "class", name: token.slice(1) });
    } else if (token.startsWith("[")) {
      const found = /^\[(?<name>[\w-]+)(?:="(?<value>[^"]*)")?\]$/u.exec(
        token,
      )?.groups;
      simples.push({
        kind: "attribute",
        name: found?.["name"] ?? "",
        value: found?.["value"] ?? null,
      });
    } else {
      throw unread();
    }
  }
  if (simples.length === 0) {
    throw unread();
  }
  compounds.push({ combinator, simples });
  return { compounds, pseudo };
}

/** Index of the parenthesis that closes the one at `open`, or -1. */
function blockEndOfParens(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "(") {
      depth += 1;
    } else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** Whether the element at `index` of a chain is what the compounds up to `at` select. */
function selects(
  chain: Chain,
  index: number,
  compounds: readonly Compound[],
  at: number = compounds.length - 1,
): boolean {
  const element = chain[index],
    compound = compounds[at];
  if (
    !element ||
    !compound ||
    !compound.simples.every((simple) => holds(chain, index, element, simple))
  ) {
    return false;
  }
  if (at === 0) {
    return true;
  }
  if (compound.combinator === ">") {
    return selects(chain, index - 1, compounds, at - 1);
  }
  for (let up = index - 1; up >= 0; up--) {
    if (selects(chain, up, compounds, at - 1)) {
      return true;
    }
  }
  return false;
}

function holds(
  chain: Chain,
  index: number,
  element: Part,
  simple: Simple,
): boolean {
  switch (simple.kind) {
    case "any":
      return true;
    case "attribute":
      return simple.value === null
        ? element.attributes.has(simple.name)
        : element.attributes.get(simple.name) === simple.value;
    case "class":
      return element.classes.has(simple.name);
    case "hover":
      // The pointer is nowhere.
      return false;
    case "is":
      return simple.options.some(
        (option) =>
          option.pseudo === null && selects(chain, index, option.compounds),
      );
  }
}

/** Specificity: there are no ids and no element names, so classes count and a pseudo-element breaks a tie. */
function weight({ compounds, pseudo }: Complex): number {
  const of = (simple: Simple): number => {
    switch (simple.kind) {
      case "any":
        return 0;
      case "is":
        return Math.max(...simple.options.map(weight));
      case "attribute":
      case "class":
      case "hover":
        return 1000;
    }
  };
  return (
    compounds
      .flatMap((compound) => compound.simples)
      .reduce((sum, simple) => sum + of(simple), 0) + (pseudo === null ? 0 : 1)
  );
}

interface ReadRule {
  readonly at: string;
  readonly selectors: readonly Complex[];
  readonly declarations: ReadonlyMap<string, string>;
}

const css = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../src/terminal/tab-status.css",
    ),
    "utf8",
  ),
  sheet = parse(css),
  /** The rules in the order of the stylesheet. */
  READ: readonly ReadRule[] = sheet.rules.map((rule) => ({
    at: rule.at,
    declarations: declarations(rule.body),
    selectors: rule.selectors.map(readSelector),
  }));

/** Every simple selector of a selector, those inside `:is()` too. */
function simplesOf({ compounds }: Complex): readonly Simple[] {
  return compounds
    .flatMap((compound) => compound.simples)
    .flatMap((simple) =>
      simple.kind === "is"
        ? [simple, ...simple.options.flatMap(simplesOf)]
        : [simple],
    );
}

// ---------- A tab, and what the stylesheet makes of it ----------

/** A tab header, or a preview in the settings, with an icon on it. */
interface Scene {
  readonly set: Settings.TabIconSet;
  /** `null`: the program has reported nothing, so no status is written. */
  readonly status: TabStatusDisplay | null;
  readonly animation: Settings.TabStatusAnimation;
  /** `null`: no size is written. */
  readonly size: Settings.TabIconSize | null;
  /** A real tab header, or what stands in for one in the settings. */
  readonly host: "preview" | "tab";
  /** For a tab: in the root split of a window, where it has a title, or in a sidebar. */
  readonly split:
    | "mod-left-split"
    | "mod-primary-split"
    | "mod-right-split"
    | "mod-root"
    | "mod-secondary-split";
  readonly light: boolean;
  readonly active: boolean;
  /** The user asked the system for less motion. */
  readonly still: boolean;
  /** The browser cannot place a box from another element (before Chromium 125). */
  readonly old: boolean;
  /** It can, but cannot keep an anchor's name to one element (Chromium 125 to 130). */
  readonly unscoped: boolean;
}

const PLAIN: Scene = {
  active: false,
  animation: Settings.DEFAULT.tabStatusAnimation,
  host: "tab",
  light: false,
  set: Settings.DEFAULT.tabIconSet,
  size: Settings.DEFAULT.tabIconSize,
  split: "mod-root",
  old: false,
  status: null,
  still: false,
  unscoped: false,
};

interface View {
  /** The tab header or its stand-in. */
  readonly header: Chain;
  /** The icon's container, whose two boxes light the dots. */
  readonly container: Chain;
  /** The icon: its root group. */
  readonly icon: Chain;
  readonly media: ReadonlySet<string>;
}

/** Builds the page around an icon as Obsidian does for a tab, and as the pickers do for a preview. */
function view(over: Partial<Scene> = {}): View {
  const scene = { ...PLAIN, ...over },
    written = {
      [TAB_STATUS_ATTRIBUTES.animation]: scene.animation,
      ...(scene.size === null
        ? {}
        : { [TAB_STATUS_ATTRIBUTES.size]: String(scene.size) }),
      ...(scene.status === null
        ? {}
        : { [TAB_STATUS_ATTRIBUTES.status]: scene.status }),
    },
    icon = drawn(scene.set),
    svg = part("svg", new Map([["class", "svg-icon"]]), [icon]),
    tab = scene.host === "tab",
    container = box(tab ? "workspace-tab-header-inner-icon" : "tts-host-icon", [
      svg,
    ]),
    inner = box("workspace-tab-header-inner", [container]),
    header = tab
      ? box(
          `workspace-tab-header${scene.active ? " is-active" : ""}`,
          [inner],
          { "data-type": "terminal:terminal", ...written },
        )
      : box("tts-host", [container], written),
    split = box(scene.split, [header]),
    body = box(scene.light ? "theme-light" : "theme-dark", [
      tab ? split : header,
    ]),
    above = tab ? [body, split, header] : [body, header],
    upTo = tab ? [...above, inner, container] : [...above, container];
  return {
    container: upTo,
    header: above,
    icon: [...upTo, svg, icon],
    media: new Set([
      HOVER,
      ...(scene.still ? [] : [MOTION]),
      ...(scene.old ? [] : [ANCHORS]),
      ...(scene.old || scene.unscoped ? [] : [SCOPES]),
    ]),
  };
}

/**
 * What the stylesheet declares for an element (or one of its two boxes):
 * of the rules that select it, the most specific wins, the later of equals.
 */
function declared(
  { media }: View,
  chain: Chain,
  property: string,
  pseudo: Pseudo = null,
): string | undefined {
  let won: { readonly value: string; readonly weight: number } | null = null;
  for (const rule of READ) {
    const value = rule.declarations.get(property);
    if (
      value === undefined ||
      !(
        rule.at === "" ||
        rule.at.split(INSIDE).every((condition) => media.has(condition))
      )
    ) {
      continue;
    }
    for (const selector of rule.selectors) {
      if (
        selector.pseudo === pseudo &&
        selects(chain, chain.length - 1, selector.compounds) &&
        (won === null || weight(selector) >= won.weight)
      ) {
        won = { value, weight: weight(selector) };
      }
    }
  }
  return won?.value;
}

/** What an element has of an inherited property: its own, or that of the nearest element around it. */
function inherited(
  on: View,
  chain: Chain,
  property: string,
): string | undefined {
  for (let length = chain.length; length > 0; length--) {
    const value = declared(on, chain.slice(0, length), property);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/** Whether an element is drawn: nothing from the page down to it is taken out. */
function shown(on: View, chain: Chain): boolean {
  return chain.every(
    (_element, index) =>
      declared(on, chain.slice(0, index + 1), "display") !== "none",
  );
}

/** Where a tab can be: the root split of a window, or one of the sidebars under either of its names. */
const SPLITS = [
  "mod-root",
  "mod-left-split",
  "mod-primary-split",
  "mod-right-split",
  "mod-secondary-split",
] as const satisfies readonly Scene["split"][];

const MARKS = ["dot", "eye", "badge", "dots"] as const,
  SYMBOLS = ["check", "moon"] as const;
type Mark = (typeof MARKS)[number];
type MarkSymbol = (typeof SYMBOLS)[number];

/** The chain of a mark of the icon. */
function markOf(on: View, mark: Mark): Chain {
  return one(parts(on.icon, `tts-mk-${mark}`), mark);
}

/** The marks an icon shows, and the symbols on them. */
function showing(on: View): {
  readonly marks: readonly Mark[];
  readonly symbols: readonly MarkSymbol[];
} {
  return {
    marks: MARKS.filter((mark) => shown(on, markOf(on, mark))),
    symbols: SYMBOLS.filter((symbol) =>
      shown(on, one(parts(on.icon, `tts-sym-${symbol}`), symbol)),
    ),
  };
}

/** Whether one of the container's two boxes is there at all. */
function hasBox(on: View, pseudo: Pseudo): boolean {
  return declared(on, on.container, "content", pseudo) !== undefined;
}

/** `calc(1.5 * var(--tts-u))` as a number of units of the 24-unit drawing. */
function units(value: string | undefined): number {
  return Number(
    /^calc\((?<units>-?[\d.]+) \* var\(--tts-u\)\)$/u.exec(value ?? "")
      ?.groups?.["units"],
  );
}

/** `calc(anchor(left) + 1.5 * var(--tts-u))`: units from that side of the anchor. */
function unitsFrom(side: "left" | "top", value: string | undefined): number {
  return Number(
    new RegExp(
      `^calc\\(anchor\\(${side}\\) \\+ (?<units>-?[\\d.]+) \\* var\\(--tts-u\\)\\)$`,
      "u",
    ).exec(value ?? "")?.groups?.["units"],
  );
}

/** What each status shows, as it was chosen in the catalogue. */
interface Shows {
  readonly mark: Mark;
  readonly symbol: MarkSymbol | null;
  /** The colour of the mark, and of the glow where there is one. */
  readonly colour: string;
  readonly glow: boolean;
  /** Idle and seen: the badge is grey and has no ring, as it is not there to be noticed. */
  readonly grey: boolean;
}
const ACCENT = "var(--interactive-accent)",
  RED = "var(--color-red)",
  GREY = "var(--text-faint)",
  /** Every status the presenter can write (`TabStatusPresenter.render`). */
  SHOWS: Readonly<Record<TabStatusDisplay, Shows>> = {
    blocked: {
      colour: RED,
      glow: true,
      mark: "dot",
      grey: false,
      symbol: null,
    },
    done: {
      colour: ACCENT,
      glow: true,
      mark: "dot",
      grey: false,
      symbol: null,
    },
    error: { colour: RED, glow: true, grey: false, mark: "eye", symbol: null },
    idle: {
      colour: GREY,
      glow: false,
      mark: "badge",
      grey: true,
      symbol: "moon",
    },
    seen: {
      colour: GREY,
      glow: false,
      mark: "badge",
      grey: true,
      symbol: "check",
    },
    working: {
      colour: ACCENT,
      glow: true,
      mark: "dots",
      grey: false,
      symbol: null,
    },
  },
  STATUSES = [
    "idle",
    "working",
    "done",
    "seen",
    "blocked",
    "error",
  ] as const satisfies readonly TabStatusDisplay[],
  HOSTS = ["tab", "preview"] as const;

/**
 * The two boxes that light the dots, as they are laid out on a working tab
 * under "loop": in a browser that cannot place them from the drawing, where
 * their place is counted from the container.
 */
const MOVING = view({ animation: "loop", old: true, status: "working" }),
  LIT = {
    height: units(declared(MOVING, MOVING.container, "height", "before")),
    left: units(declared(MOVING, MOVING.container, "left", "before")),
    top: units(declared(MOVING, MOVING.container, "top", "before")),
    width: units(declared(MOVING, MOVING.container, "width", "before")),
  };

/** One stop of the keyframes: when, how visible, how far left (in box widths) and how large. */
interface Stop {
  readonly offset: number;
  readonly opacity: number;
  readonly shift: number;
  readonly scale: number;
  readonly properties: readonly string[];
}

function stops(frames: string): readonly Stop[] {
  return Array.from(
    frames.matchAll(/(?<offset>[\d.]+)%\s*\{(?<body>[^}]*)\}/gu),
    (match) => {
      const declares = declarations(match.groups?.["body"] ?? ""),
        transform =
          /^translateX\((?<shift>0|-?[\d.]+%)\) scale\((?<scale>[\d.]+)\)$/u.exec(
            declares.get("transform") ?? "",
          )?.groups;
      return {
        offset: Number(match.groups?.["offset"]),
        opacity: Number(declares.get("opacity") ?? Number.NaN),
        properties: [...declares.keys()],
        scale: Number(transform?.["scale"]),
        shift: Number.parseFloat(transform?.["shift"] ?? "") / 100,
      };
    },
  );
}

describe("composeTabIcon", () => {
  it("draws in 24 units, scaled to Obsidian's view box of 100", () => {
    const wrapper = readXml(`<g ${TAB_ICON_WRAPPER_ATTRIBUTES}/>`),
      scale = Number(
        /^scale\((?<scale>[\d.]+)\)$/u.exec(
          wrapper.attributes.get("transform") ?? "",
        )?.groups?.["scale"],
      );
    expect(scale * 24).toBeCloseTo(100, 4);
    // Lines in the text colour, round at their ends, and no fill unless a part asks for one.
    expect(Object.fromEntries(wrapper.attributes)).toMatchObject({
      fill: "none",
      stroke: "currentColor",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    });
  });

  it.each(SETS)("%s is well-formed XML with one root group", (set) => {
    const source = composeTabIcon(set);
    expect(() => readXml(source)).not.toThrow();
    expect(source).not.toContain("&");
    const root = drawn(set);
    expect(root.tag).toBe("g");
    for (const [name, value] of readXml(`<g ${TAB_ICON_WRAPPER_ATTRIBUTES}/>`)
      .attributes) {
      expect(root.attributes.get(name), name).toBe(value);
    }
  });

  it.each(SETS)("%s says its set, and nothing else, on its root", (set) => {
    expect(drawn(set).attributes.get("class")).toBe(`tts tts-set-${set}`);
  });

  it.each(SETS)("%s carries every class the stylesheet relies on", (set) => {
    const all = within([drawn(set)]).map((chain) => subject(chain).classes);
    expect(TAB_ICON_CLASSES.length).toBeGreaterThan(0);
    // An entry names one element by all of its classes.
    for (const name of TAB_ICON_CLASSES) {
      expect(
        all.some((classes) =>
          name.split(" ").every((each) => classes.has(each)),
        ),
        name,
      ).toBe(true);
    }
    // Each mark once, and each symbol once on the badge.
    for (const mark of MARKS) {
      expect(parts([drawn(set)], `tts-mk-${mark}`), mark).toHaveLength(1);
    }
    for (const symbol of SYMBOLS) {
      expect(
        parts(
          one(parts([drawn(set)], "tts-mk-badge"), "badge"),
          `tts-sym-${symbol}`,
        ),
        symbol,
      ).toHaveLength(1);
    }
  });

  it.each(SETS)("%s has nothing that breaks when the icon is cloned", (set) => {
    for (const chain of within([drawn(set)])) {
      const { attributes, tag } = subject(chain);
      // Nothing that is addressed by an id, and nothing that runs or moves.
      expect(tag).not.toMatch(
        /^(?:defs|use|mask|clipPath|linearGradient|radialGradient|pattern|filter|symbol|style|script|set|animate\w*)$/u,
      );
      for (const [name, value] of attributes) {
        expect(name, tag).not.toMatch(/^(?:(?:xml:)?id|style)$/u);
        // No reference, to an id or by `url()`: a data URI in base64 has neither.
        expect(value, `${tag} ${name}`).not.toMatch(/#|url\(/u);
      }
    }
  });

  it.each(SETS)("%s draws the marks over the tile", (set) => {
    // Later is over: the terminal group, then the marks group, and nothing else.
    expect(
      drawn(set).children.map((child) => child.attributes.get("class")),
    ).toEqual(["tts-t", "tts-m"]);
    expect(drawn(set).children.map((child) => child.tag)).toEqual(["g", "g"]);
  });

  it.each(SETS)("%s places nothing of the tile by a transform", (set) => {
    // The tile, its shadow and its face stand where they are drawn; only the marks are moved to their corner.
    const terminal = one(parts([drawn(set)], "tts-t"), "terminal");
    for (const chain of within(terminal)) {
      expect([...subject(chain).attributes.keys()]).not.toContain("transform");
    }
  });

  it.each(SETS)(
    "%s shows a prompt of two lines and no image but its tile's",
    (set) => {
      const terminal = one(parts([drawn(set)], "tts-t"), "terminal"),
        prompt = subject(one(parts(terminal, "tts-ink"), "prompt"));
      expect(prompt.children.map((child) => child.tag)).toEqual([
        "path",
        "path",
      ]);
      for (const line of prompt.children) {
        expect(line.attributes.get("d")).toMatch(/^[Mm]/u);
      }
      // The only images are the tile's.
      for (const chain of within(terminal).filter(
        (found) => subject(found).tag === "image",
      )) {
        expect(subject(chain).classes.has("tts-skin")).toBe(true);
      }
      // The prompt lies over the tile's image.
      expect(subject(terminal).children.at(-1)).toBe(prompt);
    },
  );

  it.each(SETS)("%s paints only with currentColor, white and black", (set) => {
    const source = composeTabIcon(set),
      paints = within([drawn(set)]).flatMap((chain) =>
        ["fill", "stroke"].flatMap((name) => {
          const paint = subject(chain).attributes.get(name);
          return paint === undefined ? [] : [paint];
        }),
      );
    expect(paints.length).toBeGreaterThan(0);
    expect(
      paints.filter(
        (paint) => !["none", "currentColor", "white", "black"].includes(paint),
      ),
    ).toEqual([]);
    expect(source).not.toMatch(/\b(?:rgba?|hsla?|color)\(/iu);
  });

  it("carries the same marks in every set", () => {
    const marks = (set: Settings.TabIconSet): string => {
      const source = composeTabIcon(set);
      return source.slice(source.indexOf('<g class="tts-m"'));
    };
    expect(marks(Settings.DEFAULT.tabIconSet)).toMatch(/^<g class="tts-m"/u);
    for (const set of SETS) {
      expect(marks(set), set).toBe(marks(Settings.DEFAULT.tabIconSet));
    }
  });
});

describe("the marks, to the catalogue's numbers", () => {
  // The marks are the same in every set (above), so one icon stands for all.
  const icon: Chain = [drawn(Settings.DEFAULT.tabIconSet)],
    mark = (name: Mark): Part =>
      subject(one(parts(icon, `tts-mk-${name}`), name)),
    classesOf = (of: Part): readonly (string | undefined)[] =>
      of.children.map((child) => child.attributes.get("class")),
    /** Tolerance for a number written with two decimals. */
    NEAR = 0.011;

  it("puts the dot at (21, 3), 2.9 in radius, in a white ring 1 wide and a hairline 0.3 wide", () => {
    const dot = mark("dot"),
      [edge, ring, ink] = dot.children;
    // Painted in this order: the hairline, the ring over it, the dot over both.
    expect(classesOf(dot)).toEqual([
      "tts-mk-edge",
      "tts-mk-ring",
      "tts-mk-ink",
    ]);
    expect(place(dot)).toEqual({ x: 21, y: 3 });
    for (const circle of dot.children) {
      expect(circle.tag).toBe("circle");
      // Around the mark's own middle.
      expect([...circle.attributes.keys()].sort()).toEqual(["class", "r"]);
    }
    expect(ink && number(ink, "r")).toBeCloseTo(2.9, 6);
    expect(ring && ink && number(ring, "r") - number(ink, "r")).toBeCloseTo(
      1,
      6,
    );
    expect(edge && ring && number(edge, "r") - number(ring, "r")).toBeCloseTo(
      0.3,
      6,
    );
  });

  it("draws the eye where the dot is: a ring that ends where the dot ends, with a core inside it", () => {
    const dot = mark("dot"),
      eye = mark("eye"),
      [edge, ring, line, core] = eye.children,
      [dotEdge, dotRing, dotInk] = dot.children;
    expect(classesOf(eye)).toEqual([
      "tts-mk-edge",
      "tts-mk-ring",
      "tts-mk-line",
      "tts-mk-ink",
    ]);
    expect(place(eye)).toEqual(place(dot));
    // The same white ring and hairline as the dot.
    expect(edge?.attributes).toEqual(dotEdge?.attributes);
    expect(ring?.attributes).toEqual(dotRing?.attributes);
    if (!line || !core || !dotInk) {
      throw new Error("the eye lacks a part");
    }
    expect([line.tag, core.tag]).toEqual(["circle", "circle"]);
    const middle = number(line, "r"),
      width = number(line, "stroke-width"),
      outer = middle + width / 2,
      inner = middle - width / 2;
    expect(Math.abs(outer - number(dotInk, "r"))).toBeLessThan(NEAR);
    expect(inner).toBeGreaterThan(0);
    // The core is whole inside the ring, with clear space between them.
    expect(number(core, "r")).toBeGreaterThan(0);
    expect(inner - number(core, "r")).toBeGreaterThan(0.5);
  });

  it("puts the badge at (20.9, 3.1), 4.37 in radius, in a ring 0.7 wide and a hairline 0.3 wide", () => {
    const badge = mark("badge"),
      [edge, ring, ink] = badge.children;
    expect(classesOf(badge)).toEqual([
      "tts-mk-edge",
      "tts-mk-ring",
      "tts-mk-ink",
      "tts-sym",
    ]);
    expect(place(badge)).toEqual({ x: 20.9, y: 3.1 });
    expect(ink && number(ink, "r")).toBeCloseTo(4.37, 6);
    expect(ring && ink && number(ring, "r") - number(ink, "r")).toBeCloseTo(
      0.7,
      6,
    );
    expect(edge && ring && number(edge, "r") - number(ring, "r")).toBeCloseTo(
      0.3,
      6,
    );
  });

  it("draws the check and the moon on the badge, scaled by 0.515, and no bolt", () => {
    const badge = mark("badge"),
      symbols = one(
        badge.children.filter((child) => child.classes.has("tts-sym")),
        "symbols",
      ),
      scale = Number(
        /^scale\((?<scale>[\d.]+)\)$/u.exec(
          symbols.attributes.get("transform") ?? "",
        )?.groups?.["scale"],
      ),
      disc = number(
        one(
          badge.children.filter((child) => child.classes.has("tts-mk-ink")),
          "disc",
        ),
        "r",
      ),
      // The symbols are lines of this width, by the stylesheet.
      on = view(),
      line = Number.parseFloat(
        declared(
          on,
          one(parts(on.icon, "tts-sym"), "symbols"),
          "stroke-width",
        ) ?? "",
      );
    expect(scale).toBe(0.515);
    expect(classesOf(symbols)).toEqual(["tts-sym-check", "tts-sym-moon"]);
    // A working program has three dots and nothing else: no set draws a bolt.
    for (const set of SETS) {
      expect(composeTabIcon(set), set).not.toContain("tts-sym-bolt");
    }
    expect(line).toBeGreaterThan(0);
    // The one drawn in lines stays on the disc: no coordinate reaches further
    // from the middle than `reach`, so no point further than its diagonal.
    // (The moon has a transform of its own and is not measured here.)
    for (const drawing of symbols.children.slice(0, 1)) {
      const coordinates = [
          ...(
            drawing.attributes.get("d") ??
            drawing.attributes.get("points") ??
            ""
          ).matchAll(/-?\d*\.?\d+/gu),
        ].map(([text]) => Math.abs(Number(text))),
        reach = Math.max(...coordinates);
      expect(coordinates.length).toBeGreaterThan(5);
      expect(
        (Math.hypot(reach, reach) + line / 2) * scale,
        drawing.attributes.get("class"),
      ).toBeLessThan(disc);
    }
  });

  it("stands the last of the three dots on the dot's centre and the others one and two pitches to its left", () => {
    const dots = mark("dots"),
      circles = dots.children.filter((child) => child.tag === "circle"),
      [first, second, third] = circles.map((circle) => number(circle, "cx"));
    expect(classesOf(dots)).toEqual([
      "tts-mk-edge",
      "tts-mk-ring",
      "tts-mk-ink",
      "tts-mk-ink",
      "tts-mk-ink",
    ]);
    expect(place(dots)).toEqual(place(mark("dot")));
    expect(third).toBe(0);
    expect(second).toBeCloseTo(-4.07, 6);
    expect(first).toBeCloseTo(-8.14, 6);
    for (const circle of circles) {
      // On one line, and at rest 0.8 of a dot 1.51 in radius.
      expect(circle.attributes.has("cy")).toBe(false);
      expect(Math.abs(number(circle, "r") - 1.51 * 0.8)).toBeLessThan(NEAR);
    }
  });

  it("keeps the three dots apart, also when one is lit", () => {
    const circles = mark("dots").children.filter(
        (child) => child.tag === "circle",
      ),
      pitches = circles
        .slice(1)
        .map(
          (circle, index) =>
            number(circle, "cx") - number(circles[index] ?? circle, "cx"),
        );
    expect(pitches).toHaveLength(2);
    for (const pitch of pitches) {
      // At rest, and with both neighbours as large as the box that lights one.
      expect(
        pitch - 2 * Math.max(...circles.map((circle) => number(circle, "r"))),
      ).toBeGreaterThan(0.5);
      expect(pitch - LIT.width).toBeGreaterThan(0.5);
    }
    // A lit dot is 1.1 of a dot 1.51 in radius.
    expect(LIT.width).toBeCloseTo(2 * 1.51 * 1.1, 6);
  });

  it("holds the dots, lit too, inside the white bar, and the bar inside its hairline", () => {
    const dots = mark("dots"),
      [edge, ring] = dots.children,
      centres = dots.children
        .filter((child) => child.tag === "circle")
        .map((circle) => number(circle, "cx"));
    if (!edge || !ring) {
      throw new Error("the dots lack their bar");
    }
    expect([edge.tag, ring.tag]).toEqual(["rect", "rect"]);
    const bar = (of: Part) => ({
        bottom: number(of, "y") + number(of, "height"),
        left: number(of, "x"),
        right: number(of, "x") + number(of, "width"),
        round: number(of, "rx"),
        top: number(of, "y"),
      }),
      white = bar(ring),
      hair = bar(edge);
    // The bar is round at its ends, around the line the dots stand on.
    expect(white.round).toBeCloseTo((white.bottom - white.top) / 2, 6);
    expect(white.top).toBeCloseTo(-white.bottom, 6);
    // A dot whose centre lies between the middles of the two round ends, and
    // which is smaller than they are, is inside the bar. The margin is 1.04
    // around a dot 1.51 in radius.
    expect(Math.min(...centres)).toBeGreaterThanOrEqual(
      white.left + white.round - 1e-6,
    );
    expect(Math.max(...centres)).toBeLessThanOrEqual(
      white.right - white.round + 1e-6,
    );
    expect(white.round - LIT.width / 2).toBeGreaterThan(0.5);
    expect(white.round).toBeCloseTo(1.51 + 1.04, 6);
    // The hairline is 0.3 wide, all the way round.
    expect(white.left - hair.left).toBeCloseTo(0.3, 6);
    expect(hair.right - white.right).toBeCloseTo(0.3, 6);
    expect(white.top - hair.top).toBeCloseTo(0.3, 6);
    expect(hair.bottom - white.bottom).toBeCloseTo(0.3, 6);
    expect(hair.round - white.round).toBeCloseTo(0.3, 6);
  });

  it("draws the dots, their distance and their bar 1.3 times as large as the catalogue chose them", () => {
    // The catalogue's: a dot 1.16 in radius, 3.13 from one to the next, and
    // a bar that reaches 0.8 past them, so 10.18 by 3.92.
    const { dots } = TAB_ICON_MARKS,
      [edge, ring] = mark("dots").children;
    if (!edge || !ring) {
      throw new Error("the dots lack their bar");
    }
    expect(dots.radius / 1.16).toBeCloseTo(1.3, 2);
    expect(dots.pitch / 3.13).toBeCloseTo(1.3, 2);
    expect(dots.margin / 0.8).toBeCloseTo(1.3, 2);
    expect(number(ring, "width") / 10.18).toBeCloseTo(1.3, 2);
    expect(number(ring, "height") / 3.92).toBeCloseTo(1.3, 2);
    // The hairline is not: it is the one every mark has.
    expect(dots.edge).toBe(TAB_ICON_MARKS.dot.edge);
    // And the whole mark, hairline too, is inside the 24 units of the drawing.
    const at = place(mark("dots")),
      left = at.x + number(edge, "x"),
      top = at.y + number(edge, "y");
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left + number(edge, "width")).toBeLessThanOrEqual(24);
    expect(top + number(edge, "height")).toBeLessThanOrEqual(24);
  });

  it("says in TAB_ICON_MARKS what is drawn", () => {
    const { badge, dot, dots } = TAB_ICON_MARKS,
      radius = (of: Mark, name: string): number =>
        number(
          one(
            mark(of).children.filter(
              (child) => child.tag === "circle" && child.classes.has(name),
            ),
            name,
          ),
          "r",
        );
    expect(place(mark("dot"))).toEqual({ x: dot.cx, y: dot.cy });
    expect(radius("dot", "tts-mk-ink")).toBeCloseTo(dot.radius, 6);
    expect(radius("dot", "tts-mk-ring")).toBeCloseTo(dot.radius + dot.ring, 6);
    expect(radius("dot", "tts-mk-edge")).toBeCloseTo(
      dot.radius + dot.ring + dot.edge,
      6,
    );
    expect(place(mark("badge"))).toEqual({ x: badge.cx, y: badge.cy });
    expect(radius("badge", "tts-mk-ink")).toBeCloseTo(badge.radius, 6);
    expect(radius("badge", "tts-mk-ring")).toBeCloseTo(
      badge.radius + badge.ring,
      6,
    );
    expect(radius("badge", "tts-mk-edge")).toBeCloseTo(
      badge.radius + badge.ring + badge.edge,
      6,
    );
    expect(
      one(
        mark("badge").children.filter((child) => child.classes.has("tts-sym")),
        "symbols",
      ).attributes.get("transform"),
    ).toBe(`scale(${String(badge.symbol)})`);
    const [edge, ring, ...circles] = mark("dots").children;
    expect(circles.map((circle) => number(circle, "cx"))).toEqual([
      -2 * dots.pitch,
      -dots.pitch,
      0,
    ]);
    for (const circle of circles) {
      expect(
        Math.abs(number(circle, "r") - dots.radius * dots.rest),
      ).toBeLessThan(0.011);
    }
    expect(ring && number(ring, "rx")).toBeCloseTo(
      dots.radius + dots.margin,
      6,
    );
    expect(edge && number(edge, "rx")).toBeCloseTo(
      dots.radius + dots.margin + dots.edge,
      6,
    );
  });
});

describe("tabIconSkinned", () => {
  const SKINS = Object.entries(TAB_SKINS),
    /** A tile's name, as the name it is. */
    named = (name: string): keyof typeof TAB_SKINS =>
      one(
        Object.keys(TAB_SKINS)
          .filter(isSkin)
          .filter((each) => each === name),
        name,
      ),
    terminalOf = (markup: string): Chain => [readXml(markup)],
    imagesOf = (terminal: Chain): readonly Part[] =>
      within(terminal)
        .map(subject)
        .filter((found) => found.tag === "image");

  it("stands one prompt set on the tile of its name, and the other is drawn in lines alone", () => {
    expect(SETS.filter((set) => tileOf(set) !== null)).toEqual(["bezel"]);
    expect(SETS.filter((set) => tileOf(set) === null)).toEqual(["tile"]);
  });

  it("packs no tile that no set stands on", () => {
    expect(
      [...new Set(SETS.flatMap((set) => tileOf(set) ?? []))].sort(),
    ).toEqual(Object.keys(TAB_SKINS).sort());
    expect(Object.keys(TAB_SKINS)).toEqual(["bezel"]);
  });

  it("gives the tile a raised border of a tenth of its width", () => {
    for (const [name, skin] of SKINS) {
      expect(skin.border, name).toBe(0.1);
      // The border is what differs between the themes.
      expect(skin.dark, name).not.toBe(skin.light);
    }
  });

  it("has no round tile: every circle was taken out", () => {
    for (const [name, skin] of SKINS) {
      expect(skin.radius, name).toBeGreaterThan(0);
      expect(skin.radius, name).toBeLessThan(0.35);
    }
  });

  it.each(SKINS)(
    "draws the image of %s as wide as the tile box, in the tile box",
    (name, skin) => {
      const terminal = terminalOf(tabIconSkinned(named(name)).terminal),
        images = imagesOf(terminal);
      expect(subject(terminal).attributes.get("class")).toBe("tts-t");
      for (const image of images) {
        expect(number(image, "x")).toBe(TAB_ICON_TILE_BOX.x);
        expect(number(image, "y")).toBe(TAB_ICON_TILE_BOX.y);
        expect(number(image, "width")).toBe(TAB_ICON_TILE_BOX.size);
        expect(number(image, "height")).toBe(TAB_ICON_TILE_BOX.size);
      }
      // An image per theme.
      expect(
        images.map((image) => [
          image.attributes.get("class"),
          image.attributes.get("href"),
        ]),
      ).toEqual([
        ["tts-skin tts-skin-dark", skin.dark],
        ["tts-skin tts-skin-light", skin.light],
      ]);
    },
  );

  it.each(SKINS)(
    "lays a shadow of the shape of %s under its image",
    (name, skin) => {
      const terminal = subject(
          terminalOf(tabIconSkinned(named(name)).terminal),
        ),
        [shadow] = terminal.children,
        middle = TAB_ICON_TILE_BOX.x + TAB_ICON_TILE_BOX.size / 2;
      // First, so under everything else of the tile.
      expect(shadow?.attributes.get("class")).toBe("tts-skin-drop");
      expect(shadow?.children.length).toBeGreaterThan(0);
      for (const shape of shadow?.children ?? []) {
        // A rounded square, no smaller than the tile.
        expect(shape.tag).toBe("rect");
        expect(number(shape, "x") + number(shape, "width") / 2).toBeCloseTo(
          middle,
          6,
        );
        expect(number(shape, "width")).toBeGreaterThanOrEqual(
          TAB_ICON_TILE_BOX.size,
        );
        expect(number(shape, "height")).toBe(number(shape, "width"));
        expect(number(shape, "rx")).toBeGreaterThanOrEqual(
          Math.round(skin.radius * TAB_ICON_TILE_BOX.size * 100) / 100,
        );
        // Soft: mostly transparent.
        expect(number(shape, "opacity")).toBeLessThan(0.5);
      }
    },
  );

  it("draws the prompt on the face, over the tile's image", () => {
    const terminal = terminalOf(tabIconSkinned("bezel").terminal);
    expect(parts(terminal, "tts-ink")).toHaveLength(1);
    expect(subject(terminal).children.at(-1)?.attributes.get("class")).toBe(
      "tts-ink",
    );
  });

  it("draws every prompt in lines about as wide as Obsidian's own", () => {
    const stroke = (set: Settings.TabIconSet): number =>
      number(
        subject(one(parts([drawn(set)], "tts-ink"), "prompt")),
        "stroke-width",
      );
    for (const set of SETS) {
      expect(stroke(set), set).toBeGreaterThan(1.5);
      expect(stroke(set), set).toBeLessThanOrEqual(2);
    }
  });
});

describe("the set drawn in lines alone", () => {
  const terminal = (): Part =>
      subject(one(parts([drawn("tile")], "tts-t"), "terminal")),
    square = (): Part => {
      const [tile] = terminal().children;
      return one(tile?.children ?? [], "square");
    },
    /** The corners of a path of straight lines (`m`, `M`, `l`, `h`, `v` and their numbers). */
    corners = (d: string): readonly (readonly [number, number])[] => {
      const found: (readonly [number, number])[] = [];
      let at: readonly [number, number] = [0, 0];
      for (const [, command = "", rest = ""] of d.matchAll(
        /(?<command>[A-Za-z])(?<rest>[^A-Za-z]*)/gu,
      )) {
        const numbers = (rest.match(/-?\d*\.?\d+/gu) ?? []).map(Number);
        if (!/^[MmLlHhVv]$/u.test(command)) {
          throw new Error(`a command this reader does not know: ${command}`);
        }
        const step = /[Hh]/u.test(command) || /[Vv]/u.test(command) ? 1 : 2;
        for (let index = 0; index < numbers.length; index += step) {
          const first = numbers[index] ?? Number.NaN,
            second = numbers[index + 1] ?? Number.NaN,
            relative = command === command.toLowerCase();
          if (/[Hh]/u.test(command)) {
            at = [relative ? at[0] + first : first, at[1]];
          } else if (/[Vv]/u.test(command)) {
            at = [at[0], relative ? at[1] + first : first];
          } else {
            at = relative ? [at[0] + first, at[1] + second] : [first, second];
          }
          found.push(at);
        }
      }
      return found;
    };

  it("is a rounded square and a prompt, with no image and no shadow", () => {
    const [tile, prompt, ...more] = terminal().children;
    expect(more).toEqual([]);
    expect(tile?.tag).toBe("g");
    expect(tile?.attributes.get("class")).toBe("tts-skin");
    expect(square().tag).toBe("rect");
    expect(prompt?.attributes.get("class")).toBe("tts-ink");
    expect(prompt?.children.map((line) => line.tag)).toEqual(["path", "path"]);
    const all = within([drawn("tile")]).map(subject);
    expect(all.filter((found) => found.tag === "image")).toEqual([]);
    expect(parts([drawn("tile")], "tts-skin-drop")).toEqual([]);
    expect(composeTabIcon("tile")).not.toContain("data:");
  });

  it("draws the square to its measures, a square with rounded corners and no circle", () => {
    const { radius, size, x, y } = TAB_ICON_LINE_TILE;
    expect(
      ["x", "y", "width", "height", "rx"].map((name) => number(square(), name)),
    ).toEqual([x, y, size, size, radius]);
    expect(radius).toBeGreaterThan(0);
    expect(radius).toBeLessThan(size / 3);
  });

  it("keeps the square's line inside the tile box, where every other tile is", () => {
    const { size, x, y } = TAB_ICON_LINE_TILE,
      // The line is the icon's own, as wide as the wrapper says; half of it lies outside the square.
      half =
        Number(
          readXml(`<g ${TAB_ICON_WRAPPER_ATTRIBUTES}/>`).attributes.get(
            "stroke-width",
          ),
        ) / 2;
    expect(half).toBe(1);
    expect(x - half).toBeGreaterThanOrEqual(TAB_ICON_TILE_BOX.x);
    expect(y - half).toBeGreaterThanOrEqual(TAB_ICON_TILE_BOX.y);
    expect(x + size + half).toBeLessThanOrEqual(
      TAB_ICON_TILE_BOX.x + TAB_ICON_TILE_BOX.size,
    );
    expect(y + size + half).toBeLessThanOrEqual(
      TAB_ICON_TILE_BOX.y + TAB_ICON_TILE_BOX.size,
    );
    // And it stands around the same middle, to a tenth of a unit.
    expect(x + size / 2).toBeCloseTo(
      TAB_ICON_TILE_BOX.x + TAB_ICON_TILE_BOX.size / 2,
      1,
    );
    expect(
      Math.abs(
        y + size / 2 - (TAB_ICON_TILE_BOX.y + TAB_ICON_TILE_BOX.size / 2),
      ),
    ).toBeLessThan(0.3);
  });

  it("paints the square and the prompt as the icon's own lines: no paint of their own", () => {
    for (const chain of within([terminal()])) {
      const { attributes } = subject(chain);
      expect(attributes.has("fill")).toBe(false);
      expect(attributes.has("stroke")).toBe(false);
    }
    const [, prompt] = terminal().children;
    // As wide as the square's line, which is the wrapper's.
    expect(
      prompt === undefined ? Number.NaN : number(prompt, "stroke-width"),
    ).toBe(2);
    expect(square().attributes.has("stroke-width")).toBe(false);
  });

  it("keeps the prompt inside the square, clear of its line", () => {
    const { size, x, y } = TAB_ICON_LINE_TILE,
      [, prompt] = terminal().children,
      points = (prompt?.children ?? []).flatMap((line) =>
        corners(line.attributes.get("d") ?? ""),
      );
    // A chevron of three corners and an underscore of two.
    expect(points).toHaveLength(5);
    for (const [px, py] of points) {
      // Two units from the middle of the square's line: a line's own half width and the square's, and room between.
      expect(px).toBeGreaterThanOrEqual(x + 2);
      expect(px).toBeLessThanOrEqual(x + size - 2);
      expect(py).toBeGreaterThanOrEqual(y + 2);
      expect(py).toBeLessThanOrEqual(y + size - 2);
    }
  });
});

describe("tab-status.css", () => {
  /** What stands for a real tab header in a selector. */
  const isTab = (simples: readonly Simple[]): boolean => {
      const [first, second] = simples;
      return (
        first?.kind === "class" &&
        first.name === "workspace-tab-header" &&
        second?.kind === "attribute" &&
        second.name === "data-type" &&
        second.value === "terminal:terminal"
      );
    },
    /** The classes of the icon's own root element. */
    isIcon = (simples: readonly Simple[]): boolean => {
      const [first] = simples;
      return (
        first?.kind === "class" &&
        (first.name === "tts" ||
          SETS.some((set) => first.name === `tts-set-${set}`))
      );
    },
    isPreview = (simples: readonly Simple[]): boolean => {
      const [first] = simples;
      return first?.kind === "class" && first.name === "tts-host";
    };

  it("sits in no at-rule but the four it is read with", () => {
    expect([...new Set(sheet.rules.map((rule) => rule.at))].sort()).toEqual(
      [
        "",
        HOVER,
        MOTION,
        `${MOTION}${INSIDE}${ANCHORS}`,
        `${MOTION}${INSIDE}${ANCHORS}${INSIDE}${SCOPES}`,
      ].sort(),
    );
    expect(sheet.rules.length).toBeGreaterThan(30);
  });

  it("starts every selector at the terminal tab header, at .tts-host or at .tts", () => {
    for (const rule of READ) {
      for (const selector of rule.selectors) {
        const [start] = selector.compounds,
          [first] = start?.simples ?? [],
          // `:is(<tab header>, .tts-host)`: each choice is one of the two.
          choice =
            first?.kind === "is" &&
            first.options.every((option) => {
              const [compound, ...more] = option.compounds;
              return (
                more.length === 0 &&
                compound !== undefined &&
                (isTab(compound.simples) || isPreview(compound.simples))
              );
            });
        expect(
          choice ||
            isTab(start?.simples ?? []) ||
            isPreview(start?.simples ?? []) ||
            isIcon(start?.simples ?? []),
          JSON.stringify(selector),
        ).toBe(true);
      }
    }
  });

  it("names only classes that an icon, a tab or a preview has", () => {
    const named = new Set(
        READ.flatMap((rule) => rule.selectors)
          .flatMap(simplesOf)
          .flatMap((simple) => (simple.kind === "class" ? [simple.name] : [])),
      ),
      inIcons = new Set(
        SETS.flatMap((set) =>
          within([drawn(set)]).flatMap((chain) => [...subject(chain).classes]),
        ),
      ),
      /** Obsidian's own, and the two a preview is built from. */
      around = [
        "is-active",
        "mod-left-split",
        "mod-primary-split",
        "mod-right-split",
        "mod-root",
        "mod-secondary-split",
        "svg-icon",
        "theme-light",
        "tts-host",
        "tts-host-icon",
        "workspace-tab-header",
        "workspace-tab-header-inner",
        "workspace-tab-header-inner-icon",
      ];
    expect(
      [...named].filter((name) => !inIcons.has(name) && !around.includes(name)),
    ).toEqual([]);
  });

  it("knows no attribute and no value that the presenter cannot write", () => {
    const written: Readonly<Record<string, readonly string[]>> = {
        [TAB_STATUS_ATTRIBUTES.animation]: Settings.TAB_STATUS_ANIMATIONS,
        [TAB_STATUS_ATTRIBUTES.size]: Settings.TAB_ICON_SIZES.map(String),
        [TAB_STATUS_ATTRIBUTES.status]: STATUSES,
      },
      asked = READ.flatMap((rule) => rule.selectors)
        .flatMap(simplesOf)
        .flatMap((simple) => (simple.kind === "attribute" ? [simple] : []));
    expect(Object.keys(written).sort()).toEqual(
      Object.values(TAB_STATUS_ATTRIBUTES).sort(),
    );
    expect([...STATUSES].sort()).toEqual(Object.keys(SHOWS).sort());
    expect(asked.length).toBeGreaterThan(20);
    for (const { name, value } of asked) {
      if (name === "data-type") {
        // Obsidian's own: the view type of the tab.
        expect(value).toBe("terminal:terminal");
        continue;
      }
      expect(Object.keys(written), name).toContain(name);
      if (value !== null) {
        expect(written[name], `${name}="${value}"`).toContain(value);
      }
    }
    // And none hides in a place the reader does not look: every mention is one of the three.
    for (const [mention] of css
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .matchAll(/data-terminal-[\w-]*/gu)) {
      expect(Object.keys(written)).toContain(mention);
    }
  });

  it("asks for no quiet attribute: the grey badge of idle and seen needs none", () => {
    expect(Object.values<string>(TAB_STATUS_ATTRIBUTES).sort()).toEqual([
      "data-terminal-animation",
      "data-terminal-size",
      "data-terminal-status",
    ]);
    expect(css.replace(/\/\*[\s\S]*?\*\//gu, "")).not.toMatch(/quiet/iu);
    // No scene writes one either, on a tab or on a preview.
    for (const host of HOSTS) {
      for (const status of [null, ...STATUSES]) {
        const { header } = view({ host, status });
        expect(
          [...subject(header).attributes.keys()].filter((name) =>
            name.startsWith("data-terminal-"),
          ),
        ).toEqual(
          [
            TAB_STATUS_ATTRIBUTES.animation,
            TAB_STATUS_ATTRIBUTES.size,
            ...(status === null ? [] : [TAB_STATUS_ATTRIBUTES.status]),
          ].sort(),
        );
      }
    }
  });

  it("takes its colours from the theme, or uses black and white", () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(rules).not.toMatch(/\b(?:rgba?|hsla?|oklch|color-mix)\(/u);
  });

  describe("which mark a tab shows", () => {
    it.each(SETS)(
      "shows no mark on %s where nothing is around the icon",
      (set) => {
        // An icon in a menu or a list: no tab header, no stand-in.
        const icon = drawn(set),
          alone: View = {
            container: [],
            header: [],
            icon: [part("svg", new Map([["class", "svg-icon"]]), [icon]), icon],
            media: new Set([HOVER, MOTION]),
          };
        expect(showing(alone)).toEqual({ marks: [], symbols: [] });
        for (const tile of parts(alone.icon, "tts-skin")) {
          expect(declared(alone, tile, "filter")).toBeUndefined();
        }
      },
    );

    it.each(HOSTS)(
      "shows no mark, no symbol and no glow on a %s whose program has reported nothing",
      (host) => {
        for (const set of SETS) {
          for (const animation of Settings.TAB_STATUS_ANIMATIONS) {
            const on = view({ animation, host, set });
            expect(showing(on), set).toEqual({ marks: [], symbols: [] });
            expect(hasBox(on, "before") || hasBox(on, "after")).toBe(false);
            for (const tile of parts(on.icon, "tts-skin")) {
              expect(declared(on, tile, "filter")).toBeUndefined();
            }
          }
        }
      },
    );

    it.each(STATUSES)("shows the mark of %s, and no other", (status) => {
      const { mark, symbol } = SHOWS[status];
      for (const host of HOSTS) {
        for (const set of SETS) {
          // As the settings are at first: nothing moving.
          expect(
            showing(view({ host, set, status })),
            `${set} ${host}`,
          ).toEqual({
            marks: [mark],
            symbols: symbol === null ? [] : [symbol],
          });
        }
      }
    });

    it("says which mark each status has: a dot for done and needs input, an eye for an error, three dots for working, a moon and a check on a grey badge for idle and seen", () => {
      expect(
        Object.fromEntries(
          STATUSES.map((status) => [
            status,
            [SHOWS[status].mark, SHOWS[status].symbol],
          ]),
        ),
      ).toEqual({
        blocked: ["dot", null],
        done: ["dot", null],
        error: ["eye", null],
        idle: ["badge", "moon"],
        seen: ["badge", "check"],
        working: ["dots", null],
      });
    });

    it.each([
      ["idle", "moon"],
      ["seen", "check"],
    ] as const)(
      "always shows %s as a grey badge with a %s, in every scene",
      (status, symbol) => {
        expect(SHOWS[status]).toMatchObject({
          colour: GREY,
          grey: true,
          mark: "badge",
          symbol,
        });
        // Nothing but the status asks for it: no scene has a setting for it.
        for (const host of HOSTS) {
          for (const set of SETS) {
            for (const animation of Settings.TAB_STATUS_ANIMATIONS) {
              expect(
                showing(view({ animation, host, set, status })),
                `${set} ${host} ${animation}`,
              ).toEqual({ marks: ["badge"], symbols: [symbol] });
            }
          }
          for (const over of [
            { light: true },
            { active: true },
            { still: true },
            { old: true },
            { unscoped: true },
            { size: null },
            ...Settings.TAB_ICON_SIZES.map((size) => ({ size })),
            ...SPLITS.map((split) => ({ split })),
          ] satisfies readonly Partial<Scene>[]) {
            const on = view({ ...over, animation: "loop", host, status }),
              badge = markOf(on, "badge");
            expect(showing(on), `${host} ${JSON.stringify(over)}`).toEqual({
              marks: ["badge"],
              symbols: [symbol],
            });
            // Grey, with no light around the tile.
            expect(inherited(on, badge, "--tts-st")).toBe(GREY);
            expect(inherited(on, on.icon, "--tts-glow")).toBeUndefined();
          }
        }
      },
    );

    it("marks both as the settings are at first", () => {
      for (const host of HOSTS) {
        expect(showing(view({ host, status: "idle" })), host).toEqual({
          marks: ["badge"],
          symbols: ["moon"],
        });
        expect(showing(view({ host, status: "seen" })), host).toEqual({
          marks: ["badge"],
          symbols: ["check"],
        });
      }
    });

    it("gives the grey badge no ring and no hairline, and every other mark both", () => {
      for (const status of STATUSES) {
        const on = view({ status }),
          { grey, mark } = SHOWS[status],
          around = [
            ...parts(markOf(on, mark), "tts-mk-edge"),
            ...parts(markOf(on, mark), "tts-mk-ring"),
          ];
        expect(around, status).toHaveLength(2);
        expect(
          around.map((chain) => shown(on, chain)),
          status,
        ).toEqual(grey ? [false, false] : [true, true]);
        // What is left of a grey badge is its disc.
        expect(
          parts(markOf(on, mark), "tts-mk-ink").every((chain) =>
            shown(on, chain),
          ),
        ).toBe(true);
      }
    });

    it("draws the ring white and the hairline dark in both themes", () => {
      for (const light of [false, true]) {
        const on = view({ light, status: "done" }),
          dot = markOf(on, "dot");
        expect(
          declared(on, one(parts(dot, "tts-mk-ring"), "ring"), "fill"),
        ).toBe("white");
        expect(
          declared(on, one(parts(dot, "tts-mk-edge"), "edge"), "fill"),
        ).toBe("black");
      }
    });
  });

  describe("the colour of a status", () => {
    it.each(STATUSES)("paints the mark of %s in its colour", (status) => {
      const { colour, mark } = SHOWS[status];
      for (const host of HOSTS) {
        const on = view({ host, status }),
          inks = parts(markOf(on, mark), "tts-mk-ink"),
          lines = parts(markOf(on, mark), "tts-mk-line");
        expect(inks.length).toBeGreaterThan(0);
        // Every part of a mark that has a colour takes the state's.
        for (const ink of inks) {
          expect(declared(on, ink, "fill")).toBe("var(--tts-st, currentColor)");
          expect(inherited(on, ink, "--tts-st"), host).toBe(colour);
        }
        for (const line of lines) {
          expect(declared(on, line, "stroke")).toBe(
            "var(--tts-st, currentColor)",
          );
          expect(declared(on, line, "fill")).toBe("none");
        }
        expect(lines).toHaveLength(mark === "eye" ? 1 : 0);
      }
    });

    it("uses the accent for working and done, red for needs input and error, grey for idle and seen", () => {
      expect(
        Object.fromEntries(
          STATUSES.map((status) => [status, SHOWS[status].colour]),
        ),
      ).toEqual({
        blocked: "var(--color-red)",
        done: "var(--interactive-accent)",
        error: "var(--color-red)",
        idle: "var(--text-faint)",
        seen: "var(--text-faint)",
        working: "var(--interactive-accent)",
      });
    });

    it.each(STATUSES)(
      "lights the rendered tile of %s from behind in the colour of its mark, or not at all",
      (status) => {
        const { colour, glow } = SHOWS[status];
        for (const host of HOSTS) {
          // The set drawn in lines has nothing to light: see the next test.
          for (const set of SETS.filter((each) => tileOf(each) !== null)) {
            for (const light of [false, true]) {
              const on = view({ host, light, set, status }),
                tiles = parts(on.icon, "tts-skin");
              expect(tiles.length).toBeGreaterThan(0);
              for (const tile of tiles) {
                const filter = declared(on, tile, "filter"),
                  what = `${set} ${host}`;
                // An image takes no colour: the light is all a state does to it.
                expect(declared(on, tile, "stroke"), what).toBeUndefined();
                expect(
                  declared(on, tile, "stroke-opacity"),
                  what,
                ).toBeUndefined();
                if (!glow) {
                  expect(filter, what).toBeUndefined();
                  continue;
                }
                // A light around the tile's image, of the state's colour and of no other.
                const lights = (filter ?? "").match(
                  /drop-shadow\([^()]*(?:\([^()]*\))?[^()]*\)/gu,
                );
                expect(lights?.length, what).toBeGreaterThan(0);
                expect(lights?.join(" "), what).toBe(filter);
                for (const each of lights ?? []) {
                  // Around the tile, not to one side of it.
                  expect(each, what).toMatch(
                    /^drop-shadow\(0 0 [\d.]+px var\(--tts-glow\)\)$/u,
                  );
                }
                expect(inherited(on, tile, "--tts-glow"), what).toBe(colour);
              }
            }
          }
        }
      },
    );

    it.each(STATUSES)(
      "colours the square of the set drawn in lines for %s where a rendered tile would glow, and lights nothing",
      (status) => {
        const { colour, glow } = SHOWS[status];
        for (const host of HOSTS) {
          for (const light of [false, true]) {
            const on = view({ host, light, set: "tile", status }),
              square = one(parts(on.icon, "tts-skin"), "square"),
              prompt = one(parts(on.icon, "tts-ink"), "prompt"),
              what = `${host} ${light ? "light" : "dark"}`;
            // The prompt keeps the icon's colour, whatever the state.
            expect(declared(on, prompt, "stroke"), what).toBeUndefined();
            expect(
              declared(on, prompt, "stroke-opacity"),
              what,
            ).toBeUndefined();
            expect(declared(on, prompt, "filter"), what).toBeUndefined();
            if (!glow) {
              // Idle and seen: the square as at rest, faint and in the icon's colour.
              expect(declared(on, square, "stroke"), what).toBeUndefined();
              expect(declared(on, square, "filter"), what).toBeUndefined();
              expect(
                Number(declared(on, square, "stroke-opacity")),
                what,
              ).toBeLessThan(0.9);
              continue;
            }
            expect(declared(on, square, "stroke"), what).toBe("var(--tts-st)");
            expect(inherited(on, square, "--tts-st"), what).toBe(colour);
            // At full strength, and with no light round it.
            expect(declared(on, square, "stroke-opacity"), what).toBe("1");
            expect(declared(on, square, "filter"), what).toBe("none");
          }
        }
      },
    );

    it("glows for working, done, needs input and error only", () => {
      expect(STATUSES.filter((status) => SHOWS[status].glow).sort()).toEqual([
        "blocked",
        "done",
        "error",
        "working",
      ]);
      // And where no state lights it, nothing names a glow's colour.
      for (const status of [null, "idle", "seen"] as const) {
        const on = view({ status });
        expect(inherited(on, on.icon, "--tts-glow")).toBeUndefined();
      }
    });

    it("lights nothing but the tile's image: no border, no wash, no dashes", () => {
      for (const status of STATUSES) {
        for (const set of SETS) {
          const on = view({ set, status });
          for (const chain of within(on.icon)) {
            if (!subject(chain).classes.has("tts-skin")) {
              expect(declared(on, chain, "filter")).toBeUndefined();
            }
            for (const property of [
              "stroke-dasharray",
              "stroke-dashoffset",
              "outline",
              "box-shadow",
              "background",
            ]) {
              expect(declared(on, chain, property)).toBeUndefined();
            }
          }
        }
      }
    });
  });

  describe("the tile", () => {
    it("shows one image of a tile in each theme, or the square of the set drawn in lines", () => {
      for (const set of SETS) {
        const pair = tileOf(set) !== null;
        for (const light of [false, true]) {
          const on = view({ light, set }),
            visible = parts(on.icon, "tts-skin")
              .filter((chain) => shown(on, chain))
              .map((chain) => subject(chain).attributes.get("class"));
          expect(visible, set).toEqual([
            pair ? `tts-skin tts-skin-${light ? "light" : "dark"}` : "tts-skin",
          ]);
        }
      }
    });

    it("stands a rendered tile on its shadow in both themes", () => {
      for (const set of SETS) {
        const tile = tileOf(set);
        if (tile === null) {
          // Lines alone: nothing to cast a shadow, and none is drawn.
          expect(parts([drawn(set)], "tts-skin-drop"), set).toHaveLength(0);
          continue;
        }
        for (const light of [false, true]) {
          const on = view({ light, set });
          expect(
            shown(on, one(parts(on.icon, "tts-skin-drop"), "shadow")),
            set,
          ).toBe(true);
        }
      }
    });

    it("draws the prompt green on the tile with a dark face, and in the text colour where it is lines alone", () => {
      const stroke = (set: Settings.TabIconSet): string | undefined => {
        const on = view({ set });
        return declared(on, one(parts(on.icon, "tts-ink"), "prompt"), "stroke");
      };
      expect(stroke("bezel")).toBe("var(--color-green)");
      // Nothing declared: the icon's own `stroke="currentColor"` holds.
      expect(stroke("tile")).toBeUndefined();
    });

    it("draws the square of the set in lines fainter than its prompt, where no state colours it", () => {
      for (const status of [null, "idle", "seen"] as const) {
        for (const light of [false, true]) {
          const on = view({ light, set: "tile", status }),
            tile = one(parts(on.icon, "tts-skin"), "square"),
            prompt = one(parts(on.icon, "tts-ink"), "prompt"),
            faint = Number(declared(on, tile, "stroke-opacity"));
          expect(faint).toBeGreaterThan(0.4);
          expect(faint).toBeLessThan(0.9);
          expect(declared(on, prompt, "stroke-opacity")).toBeUndefined();
          // The colour stays the icon's: nothing gives the square or the prompt one.
          expect(declared(on, tile, "stroke")).toBeUndefined();
          expect(declared(on, tile, "fill")).toBeUndefined();
        }
      }
      // No other set has its tile thinned: a rendered tile is an image.
      for (const set of SETS.filter((each) => each !== "tile")) {
        const on = view({ set });
        for (const tile of parts(on.icon, "tts-skin")) {
          expect(declared(on, tile, "stroke-opacity"), set).toBeUndefined();
        }
      }
    });

    it("is never cut: no rule clips or masks anything, and the icon cuts nothing itself", () => {
      expect(
        READ.filter((rule) =>
          [...rule.declarations.keys()].some((property) =>
            /^(?:clip|clip-path|mask(?:-.+)?)$/u.test(property),
          ),
        ),
      ).toEqual([]);
      expect(
        sheet.rules.filter((rule) => /clip|mask/u.test(rule.body)),
      ).toEqual([]);
      for (const set of SETS) {
        expect(composeTabIcon(set)).not.toMatch(/clip-path|mask/u);
      }
    });

    it("has no dashes anywhere", () => {
      expect(css.replace(/\/\*[\s\S]*?\*\//gu, "")).not.toMatch(
        /stroke-dash|pathLength/u,
      );
      for (const set of SETS) {
        expect(composeTabIcon(set)).not.toMatch(/stroke-dash|pathLength/u);
      }
    });
  });

  describe("motion", () => {
    /** What moves, turns, resizes or fades something over time. */
    const MOVES =
        /^(?:transform(?:-.+)?|translate|rotate|scale|offset(?:-.+)?|animation(?:-.+)?|transition(?:-.+)?|will-change)$/u,
      moving = READ.filter((rule) =>
        [...rule.declarations.keys()].some((property) => MOVES.test(property)),
      ),
      frames = stops(sheet.keyframes.get("tts-dots") ?? ""),
      { dots } = TAB_ICON_MARKS;

    it("moves nothing of the icon: only the two boxes of its container, on a working tab under loop, where motion is welcome", () => {
      expect(moving.length).toBeGreaterThan(0);
      for (const rule of moving) {
        expect(rule.at).toBe(MOTION);
        for (const selector of rule.selectors) {
          const [start, ...rest] = selector.compounds,
            asked = (start?.simples ?? []).flatMap((simple) =>
              simple.kind === "attribute"
                ? [`${simple.name}=${String(simple.value)}`]
                : [],
            ),
            last = rest.at(-1)?.simples ?? [];
          // On a box, not on an element: so not on the tile, its face or a mark.
          expect(selector.pseudo).not.toBeNull();
          expect(asked).toEqual(
            expect.arrayContaining([
              `${TAB_STATUS_ATTRIBUTES.animation}=loop`,
              `${TAB_STATUS_ATTRIBUTES.status}=working`,
            ]),
          );
          // The box is the icon container's.
          expect(rest).toHaveLength(1);
          expect(
            simplesOf({
              compounds: [{ combinator: null, simples: last }],
              pseudo: null,
            })
              .flatMap((simple) =>
                simple.kind === "class" ? [simple.name] : [],
              )
              .sort(),
          ).toEqual(["tts-host-icon", "workspace-tab-header-inner-icon"]);
        }
      }
      // The same, asked of the icon: in no state does a rule move a part of it.
      for (const set of SETS) {
        for (const status of [null, ...STATUSES]) {
          const on = view({ animation: "loop", set, status });
          for (const chain of within(on.container)) {
            for (const rule of moving) {
              for (const property of rule.declarations.keys()) {
                if (MOVES.test(property)) {
                  expect(declared(on, chain, property)).toBeUndefined();
                }
              }
            }
          }
        }
      }
    });

    it("has one keyframes rule, tts-dots, which changes only transform and opacity", () => {
      expect([...sheet.keyframes.keys()]).toEqual(["tts-dots"]);
      expect(frames.length).toBeGreaterThan(2);
      for (const stop of frames) {
        // The easing to the next stop is not a change of the box.
        expect(
          stop.properties.filter(
            (property) => property !== "animation-timing-function",
          ),
        ).toEqual(["opacity", "transform"]);
        // A shift along the line of the dots and a size, read in full.
        expect(Number.isNaN(stop.shift) || Number.isNaN(stop.scale)).toBe(
          false,
        );
        expect([0, 1]).toContain(stop.opacity);
      }
      // And the only animation there is, is this one.
      const named = new Set(
        READ.flatMap((rule) => {
          const animation = rule.declarations.get("animation");
          return animation === undefined ? [] : [animation.split(" ")[0]];
        }),
      );
      expect([...named]).toEqual(["tts-dots"]);
    });

    it.each(HOSTS)(
      "lights the dots of a working %s under loop with two boxes",
      (host) => {
        for (const set of SETS) {
          const on = view({ animation: "loop", host, set, status: "working" });
          expect(showing(on), set).toEqual({ marks: ["dots"], symbols: [] });
          expect([hasBox(on, "before"), hasBox(on, "after")]).toEqual([
            true,
            true,
          ]);
        }
      },
    );

    it("stands the three dots still, all lit and with no box, under none and where the user asked for less motion", () => {
      const lit = (of: View): readonly (string | undefined)[] =>
        parts(markOf(of, "dots"), "tts-mk-ink").map((chain) =>
          declared(of, chain, "opacity"),
        );
      for (const host of HOSTS) {
        for (const set of SETS) {
          for (const over of [
            // The user's choice of no motion,
            { animation: "none" },
            { animation: "none", still: true },
            // and the system's, which goes before a choice of motion.
            { animation: "loop", still: true },
          ] satisfies readonly Partial<Scene>[]) {
            const on = view({ ...over, host, set, status: "working" }),
              label = `${set} ${host} ${JSON.stringify(over)}`;
            // The same mark as where it moves: three dots, and no badge.
            expect(showing(on), label).toEqual({
              marks: ["dots"],
              symbols: [],
            });
            expect(lit(on), label).toEqual([undefined, undefined, undefined]);
            expect([hasBox(on, "before"), hasBox(on, "after")], label).toEqual([
              false,
              false,
            ]);
            for (const pseudo of ["before", "after"] as const) {
              expect(
                declared(on, on.container, "animation", pseudo),
                label,
              ).toBeUndefined();
            }
          }
          // Where they move, the dots of the icon are faint under the lit ones.
          expect(
            lit(view({ animation: "loop", host, set, status: "working" })),
          ).toEqual(["0.3", "0.3", "0.3"]);
        }
      }
    });

    it("places the boxes from the drawing where the browser can, at the same distances", () => {
      for (const host of HOSTS) {
        const on = view({ animation: "loop", host, status: "working" }),
          drawing = on.icon.slice(0, -1);
        expect(declared(on, drawing, "anchor-name")).toBe("--tts-icon");
        for (const pseudo of ["before", "after"] as const) {
          const of = (property: string): string | undefined =>
            declared(on, on.container, property, pseudo);
          expect(of("position-anchor")).toBe("--tts-icon");
          expect(unitsFrom("left", of("left"))).toBe(LIT.left);
          expect(unitsFrom("top", of("top"))).toBe(LIT.top);
        }
        // An older browser has the same boxes, counted from the container.
        const old = view({
          animation: "loop",
          host,
          old: true,
          status: "working",
        });
        expect(declared(old, old.icon.slice(0, -1), "anchor-name")).toBe(
          undefined,
        );
        for (const pseudo of ["before", "after"] as const) {
          expect(
            declared(old, old.container, "position-anchor", pseudo),
          ).toBeUndefined();
          expect(units(declared(old, old.container, "left", pseudo))).toBe(
            LIT.left,
          );
        }
        // And nothing is an anchor where nothing moves.
        for (const status of [null, ...STATUSES]) {
          const rest = view({ host, status });
          expect(
            declared(rest, rest.icon.slice(0, -1), "anchor-name"),
          ).toBeUndefined();
        }
      }
    });

    it("takes the boxes out of the tab's rounded clip: where they are placed from the drawing, a working tab's container is no frame", () => {
      const found = READ.filter(
          (rule) => rule.declarations.get("position") === "static",
        ),
        rule = one(found, "the rule that declares position: static"),
        selector = one(rule.selectors, "its selector"),
        [start, ...more] = selector.compounds;
      // Inside the query for motion, in it inside the one for anchors, and
      // in that inside the one for an anchor's name kept to its own icon:
      // the boxes' frame may then hold other terminal tabs.
      expect(rule.at).toBe(`${MOTION}${INSIDE}${ANCHORS}${INSIDE}${SCOPES}`);
      expect([...rule.declarations.keys()]).toEqual(["position"]);
      // The container itself, not one of its boxes, on a real tab header only.
      expect(selector.pseudo).toBeNull();
      expect(isTab(start?.simples ?? [])).toBe(true);
      expect(start?.simples.slice(2)).toEqual([
        {
          kind: "attribute",
          name: TAB_STATUS_ATTRIBUTES.animation,
          value: "loop",
        },
        {
          kind: "attribute",
          name: TAB_STATUS_ATTRIBUTES.status,
          value: "working",
        },
      ]);
      expect(more).toEqual([
        {
          combinator: " ",
          simples: [{ kind: "class", name: "workspace-tab-header-inner-icon" }],
        },
      ]);
      expect(
        simplesOf(selector).filter(
          (simple) => simple.kind === "class" && simple.name.startsWith("tts-"),
        ),
      ).toEqual([]);

      for (const split of SPLITS) {
        for (const set of SETS) {
          const on = view({ animation: "loop", set, split, status: "working" });
          expect(
            declared(on, on.container, "position"),
            `${set} ${split}`,
          ).toBe("static");
          // The boxes are still there, placed from the drawing and not from a frame.
          for (const pseudo of ["before", "after"] as const) {
            const of = (property: string): string | undefined =>
              declared(on, on.container, property, pseudo);
            expect(of("position")).toBe("absolute");
            expect(of("position-anchor")).toBe("--tts-icon");
            expect(unitsFrom("left", of("left"))).toBe(LIT.left);
            expect(unitsFrom("top", of("top"))).toBe(LIT.top);
          }
          expect(declared(on, on.icon.slice(0, -1), "anchor-name")).toBe(
            "--tts-icon",
          );
          // And the drawing's name goes no further than its own container.
          expect(declared(on, on.container, "anchor-scope")).toBe("--tts-icon");
        }
      }
      // Nothing above the container is made a frame in its place, or a clip.
      const on = view({ animation: "loop", status: "working" });
      for (
        let length = on.header.length;
        length < on.container.length;
        length++
      ) {
        const chain = on.container.slice(0, length);
        expect(declared(on, chain, "position")).toBeUndefined();
        expect(declared(on, chain, "overflow")).toBeUndefined();
      }
    });

    it("keeps the container the frame of its boxes everywhere else", () => {
      const frame = (over: Partial<Scene>): string | undefined => {
        const on = view(over);
        return declared(on, on.container, "position");
      };
      for (const set of SETS) {
        // A preview in the settings: no rounded clip around it to leave.
        expect(
          frame({ animation: "loop", host: "preview", set, status: "working" }),
          set,
        ).toBe("relative");
      }
      for (const split of SPLITS) {
        // A browser that cannot place the boxes from the drawing counts from the container.
        expect(
          frame({ animation: "loop", old: true, split, status: "working" }),
        ).toBe("relative");
        // One that can, but would find the drawing of another tab from a wider frame.
        expect(
          frame({
            animation: "loop",
            split,
            status: "working",
            unscoped: true,
          }),
        ).toBe("relative");
        // Reduced motion: no boxes at all.
        expect(
          frame({ animation: "loop", split, status: "working", still: true }),
        ).toBe("relative");
        expect(
          frame({
            animation: "loop",
            old: true,
            split,
            status: "working",
            still: true,
          }),
        ).toBe("relative");
      }
      for (const host of HOSTS) {
        for (const status of [null, ...STATUSES]) {
          for (const animation of Settings.TAB_STATUS_ANIMATIONS) {
            if (
              host === "tab" &&
              status === "working" &&
              animation === "loop"
            ) {
              continue;
            }
            expect(
              frame({ animation, host, status }),
              `${host} ${String(status)} ${animation}`,
            ).toBe("relative");
          }
        }
      }
    });

    it("shows the boxes that left the clip always: the browser would otherwise look, on every frame, whether the drawing is still to be seen", () => {
      const found = READ.filter((rule) =>
          rule.declarations.has("position-visibility"),
        ),
        rule = one(found, "the rule that declares position-visibility");
      // Only where the container is no frame: the same three queries.
      expect(rule.at).toBe(`${MOTION}${INSIDE}${ANCHORS}${INSIDE}${SCOPES}`);
      expect([...rule.declarations]).toEqual([
        ["position-visibility", "always"],
      ]);
      // Both boxes of a real tab header, and nothing of a preview.
      expect(rule.selectors.map((selector) => selector.pseudo).sort()).toEqual([
        "after",
        "before",
      ]);
      for (const selector of rule.selectors) {
        expect(isTab(selector.compounds[0]?.simples ?? [])).toBe(true);
        expect(
          simplesOf(selector).filter(
            (simple) =>
              simple.kind === "class" && simple.name.startsWith("tts-"),
          ),
        ).toEqual([]);
      }
      const shown = (
        over: Partial<Scene>,
        pseudo: "after" | "before",
      ): string | undefined => {
        const on = view(over);
        return declared(on, on.container, "position-visibility", pseudo);
      };
      for (const pseudo of ["before", "after"] as const) {
        for (const split of SPLITS) {
          for (const set of SETS) {
            const on: Partial<Scene> = {
              animation: "loop",
              set,
              split,
              status: "working",
            };
            // Wherever the container is no frame, and nowhere else.
            expect(
              declared(view(on), view(on).container, "position"),
              `${set} ${split}`,
            ).toBe("static");
            expect(shown(on, pseudo), `${set} ${split}`).toBe("always");
          }
          for (const over of [
            { old: true },
            { unscoped: true },
            { still: true },
          ] satisfies readonly Partial<Scene>[]) {
            expect(
              shown(
                { animation: "loop", split, status: "working", ...over },
                pseudo,
              ),
              JSON.stringify(over),
            ).toBeUndefined();
          }
        }
        expect(
          shown(
            { animation: "loop", host: "preview", status: "working" },
            pseudo,
          ),
        ).toBeUndefined();
        for (const status of [null, ...STATUSES]) {
          for (const animation of Settings.TAB_STATUS_ANIMATIONS) {
            if (status === "working" && animation === "loop") {
              continue;
            }
            expect(
              shown({ animation, status }, pseudo),
              `${String(status)} ${animation}`,
            ).toBeUndefined();
          }
        }
      }
    });

    it("keeps the icon as low while its container is no frame: the drawing carries the lowering, and takes it back below", () => {
      const found = READ.filter((rule) =>
          [...rule.declarations.keys()].some((name) =>
            name.startsWith("margin"),
          ),
        ),
        rule = one(found, "the rule that declares a margin"),
        selector = one(rule.selectors, "its selector");
      // Only where the container is no frame: the same three queries.
      expect(rule.at).toBe(`${MOTION}${INSIDE}${ANCHORS}${INSIDE}${SCOPES}`);
      // As much above as is taken back below: the container stays as tall.
      expect([...rule.declarations]).toEqual([["margin-block", CARRIED]]);
      // The drawing of a real tab header, and nothing of a preview.
      expect(selector.pseudo).toBeNull();
      expect(isTab(selector.compounds[0]?.simples ?? [])).toBe(true);
      expect(selector.compounds.slice(1)).toEqual([
        {
          combinator: " ",
          simples: [{ kind: "class", name: "workspace-tab-header-inner-icon" }],
        },
        { combinator: ">", simples: [{ kind: "class", name: "svg-icon" }] },
      ]);

      // An offset counts on a positioned element only. So wherever the
      // container is none, the drawing has the lowering, and nowhere else:
      // the icon is lowered once, whatever the program reports.
      const browsers = [
        {},
        { old: true },
        { unscoped: true },
        { still: true },
        { old: true, still: true },
      ] satisfies readonly Partial<Scene>[];
      let loose = 0;
      for (const host of HOSTS) {
        for (const split of SPLITS) {
          for (const status of [null, ...STATUSES]) {
            for (const animation of Settings.TAB_STATUS_ANIMATIONS) {
              for (const browser of browsers) {
                const on = view({ animation, host, split, status, ...browser }),
                  drawing = on.icon.slice(0, -1),
                  frame = declared(on, on.container, "position"),
                  label = `${host} ${split} ${String(status)} ${animation} ${JSON.stringify(browser)}`;
                expect(["relative", "static"], label).toContain(frame);
                expect(declared(on, drawing, "margin-block"), label).toBe(
                  frame === "static" ? CARRIED : undefined,
                );
                if (frame === "static") {
                  loose++;
                  // The same lowering as the container's offset: none in a sidebar.
                  expect(inherited(on, drawing, "--tts-down"), label).toBe(
                    split === "mod-root" ? LOWERING : undefined,
                  );
                }
                // By a margin alone: a positioned or a moved drawing would be
                // painted over the box that comes before it, and a box does
                // not follow a drawing that is moved.
                for (const property of [
                  "inset",
                  "margin",
                  "margin-bottom",
                  "margin-top",
                  "position",
                  "top",
                  "transform",
                  "translate",
                  "z-index",
                ]) {
                  expect(
                    declared(on, drawing, property),
                    `${label} ${property}`,
                  ).toBeUndefined();
                }
              }
            }
          }
        }
      }
      // A working tab under the moving dots, in each of the five places.
      expect(loose).toBe(SPLITS.length);
    });

    it("keeps the name of a drawing to its own icon wherever it is an anchor", () => {
      for (const host of HOSTS) {
        for (const unscoped of [false, true]) {
          const on = view({
            animation: "loop",
            host,
            status: "working",
            unscoped,
          });
          // Declared with the anchor; a browser that does not know it drops it.
          expect(declared(on, on.container, "anchor-scope")).toBe(
            declared(on, on.icon.slice(0, -1), "anchor-name"),
          );
          for (const pseudo of ["before", "after"] as const) {
            expect(declared(on, on.container, "position-anchor", pseudo)).toBe(
              "--tts-icon",
            );
            expect(
              declared(on, on.container, "anchor-scope", pseudo),
            ).toBeUndefined();
          }
        }
        // No anchor, no scope.
        for (const over of [
          { animation: "loop", old: true, status: "working" },
          { animation: "loop", status: "working", still: true },
          { animation: "none", status: "working" },
          { animation: "loop", status: "done" },
          { animation: "loop", status: null },
        ] satisfies readonly Partial<Scene>[]) {
          const on = view({ ...over, host });
          expect(
            declared(on, on.container, "anchor-scope"),
            JSON.stringify(over),
          ).toBeUndefined();
        }
      }
      const scoped = READ.filter((rule) =>
        rule.declarations.has("anchor-scope"),
      );
      expect(one(scoped, "the rule that scopes the name").at).toBe(
        `${MOTION}${INSIDE}${ANCHORS}`,
      );
    });

    it("moves nothing for any other status, nor without loop", () => {
      for (const host of HOSTS) {
        for (const status of [null, ...STATUSES]) {
          for (const animation of Settings.TAB_STATUS_ANIMATIONS) {
            if (status === "working" && animation === "loop") {
              continue;
            }
            const on = view({ animation, host, status });
            expect(
              [hasBox(on, "before"), hasBox(on, "after")],
              `${String(status)} ${animation}`,
            ).toEqual([false, false]);
          }
          // Loop changes no mark, a working program's neither: it only sets
          // those dots moving.
          expect(showing(view({ animation: "loop", host, status }))).toEqual(
            showing(view({ animation: "none", host, status })),
          );
        }
      }
    });

    it("lays the two boxes out in the container, as large as a lit dot, around the last dot's centre", () => {
      const last = place(
        subject(one(parts(MOVING.icon, "tts-mk-dots"), "dots")),
      );
      // One unit of the drawing, at whatever size the icon is drawn; the container is the boxes' frame.
      expect(declared(MOVING, MOVING.container, "--tts-u")).toBe(
        "calc(var(--icon-size) / 24)",
      );
      expect(declared(MOVING, MOVING.container, "position")).toBe("relative");
      expect(LIT.width).toBeCloseTo(2 * dots.radius * dots.peak, 6);
      expect(LIT.height).toBe(LIT.width);
      expect(LIT.left + LIT.width / 2).toBeCloseTo(last.x, 6);
      expect(LIT.top + LIT.height / 2).toBeCloseTo(last.y, 6);
      for (const pseudo of ["before", "after"] as const) {
        const of = (property: string): string | undefined =>
          declared(MOVING, MOVING.container, property, pseudo);
        // The two are the same box.
        for (const [property, value] of Object.entries(LIT)) {
          expect(units(of(property)), property).toBe(value);
        }
        expect(of("position")).toBe("absolute");
        // A disc of the state's colour, which takes no click from the tab.
        expect(of("border-radius")).toBe("50%");
        expect(of("background")).toBe("var(--tts-st)");
        expect(inherited(MOVING, MOVING.container, "--tts-st")).toBe(ACCENT);
        expect(of("pointer-events")).toBe("none");
        // Not seen until the animation shows it.
        expect(of("opacity")).toBe("0");
      }
    });

    it("runs a round of 7.68 s for ever, the second box half a round behind the first", () => {
      const round = (pseudo: Pseudo): string | undefined =>
        declared(MOVING, MOVING.container, "animation", pseudo);
      expect(round("before")).toBe("tts-dots 7.68s infinite");
      expect(round("after")).toBe(round("before"));
      expect(
        declared(MOVING, MOVING.container, "animation-delay", "before"),
      ).toBeUndefined();
      expect(
        Number.parseFloat(
          declared(MOVING, MOVING.container, "animation-delay", "after") ?? "",
        ),
      ).toBeCloseTo(-7.68 / 2, 6);
      expect(
        declared(MOVING, MOVING.container, "animation-delay", "after"),
      ).toMatch(/^-[\d.]+s$/u);
    });

    it("steps a box one and two pitches to the left, and rests it at the size of a dot at rest", () => {
      const pitch = dots.pitch / LIT.width,
        shifts = [...new Set(frames.map((stop) => stop.shift))].sort(
          (left, right) => left - right,
        ),
        scales = [...new Set(frames.map((stop) => stop.scale))].sort(
          (left, right) => left - right,
        );
      // As a part of the box's own width, which is what a percentage in `translateX` is.
      expect(shifts).toHaveLength(3);
      expect(shifts[0]).toBeCloseTo(-2 * pitch, 4);
      expect(shifts[1]).toBeCloseTo(-pitch, 4);
      expect(shifts[2]).toBe(0);
      expect(scales).toHaveLength(2);
      expect(scales[0]).toBeCloseTo(dots.rest / dots.peak, 3);
      expect(scales[1]).toBe(1);
      // At rest a box is as large as the faint dot under it.
      const resting = number(
        one(
          subject(one(parts(MOVING.icon, "tts-mk-dots"), "dots"))
            .children.filter((child) => child.tag === "circle")
            .slice(-1),
          "last dot",
        ),
        "r",
      );
      expect(
        Math.abs(((scales[0] ?? Number.NaN) * LIT.width) / 2 - resting),
      ).toBeLessThan(0.011);
    });

    it("lights a dot at its full size, and steps to another only while the box cannot be seen", () => {
      const lit = frames.filter((stop) => stop.opacity === 1);
      // Each of the three dots once in a round.
      expect(lit.map((stop) => stop.shift).sort()).toEqual(
        [...new Set(frames.map((stop) => stop.shift))].sort(),
      );
      for (const stop of lit) {
        expect(stop.scale).toBe(1);
      }
      for (const stop of frames.filter((each) => each.opacity === 0)) {
        expect(stop.scale).toBeLessThan(1);
      }
      frames.slice(1).forEach((stop, index) => {
        const before = frames[index];
        if (before && before.shift !== stop.shift) {
          expect([before.opacity, stop.opacity], String(stop.offset)).toEqual([
            0, 0,
          ]);
        }
      });
      // A round ends as it begins.
      expect(frames[0]?.offset).toBe(0);
      expect(frames.at(-1)?.offset).toBe(100);
      expect({ ...frames.at(-1), offset: 0, properties: [] }).toEqual({
        ...frames[0],
        properties: [],
      });
    });

    it("lights the three dots in turn from the left, evenly, with the two boxes together", () => {
      const round = Number.parseFloat(
          (
            declared(MOVING, MOVING.container, "animation", "before") ?? ""
          ).split(" ")[1] ?? "",
        ),
        behind =
          -Number.parseFloat(
            declared(MOVING, MOVING.container, "animation-delay", "after") ??
              "",
          ) / round,
        lit = frames.filter((stop) => stop.opacity === 1),
        // When each dot is fully lit, as a part of a round: by the first box, and by the second.
        turns = [0, behind]
          .flatMap((ahead) =>
            lit.map((stop) => ({
              at: (((stop.offset / 100 - ahead) % 1) + 1) % 1,
              shift: stop.shift,
            })),
          )
          .sort((left, right) => left.at - right.at),
        places = [...new Set(lit.map((stop) => stop.shift))].sort(
          (left, right) => left - right,
        );
      expect(turns).toHaveLength(6);
      turns.forEach((turn, index) => {
        const next = turns[(index + 1) % turns.length];
        // A sixth of a round apart: 1.28 s from one dot to the next.
        expect(
          ((((next?.at ?? Number.NaN) - turn.at) % 1) + 1) % 1,
        ).toBeCloseTo(1 / 6, 2);
        // The dot to the right is next, and after the last the first.
        expect(next?.shift).toBe(
          places[(places.indexOf(turn.shift) + 1) % places.length],
        );
      });
    });

    it("leaves the three dots under the boxes faint", () => {
      const inks = parts(markOf(MOVING, "dots"), "tts-mk-ink");
      expect(inks).toHaveLength(3);
      for (const ink of inks) {
        const opacity = Number(declared(MOVING, ink, "opacity"));
        expect(opacity).toBeGreaterThan(0);
        expect(opacity).toBeLessThan(0.5);
      }
    });
  });

  describe("the size and the place of the icon", () => {
    const SIDES = [
      "mod-left-split",
      "mod-primary-split",
      "mod-right-split",
      "mod-secondary-split",
    ] as const;

    it("has one rule for every size the settings offer, and for no other", () => {
      const sized = READ.flatMap((rule) =>
        rule.selectors
          .flatMap(simplesOf)
          .flatMap((simple) =>
            simple.kind === "attribute" &&
            simple.name === TAB_STATUS_ATTRIBUTES.size
              ? [simple.value]
              : [],
          ),
      );
      expect(sized).toEqual(Settings.TAB_ICON_SIZES.map(String));
    });

    it.each(Settings.TAB_ICON_SIZES)(
      "draws the icon at %d px where the tab has a title, and in a preview",
      (size) => {
        for (const host of HOSTS) {
          const on = view({ host, size });
          expect(inherited(on, on.container, "--tts-size")).toBe(
            `${String(size)}px`,
          );
          // The chosen size is the icon's.
          expect(declared(on, on.container, "--icon-size")).toMatch(
            /^var\(--tts-size, /u,
          );
        }
      },
    );

    it("gives a tab nobody has written yet the default size, and a preview without a size Obsidian's and two pixels", () => {
      const tab = view({ size: null }),
        preview = view({ host: "preview", size: null });
      expect(inherited(tab, tab.container, "--tts-size")).toBe(
        `${String(Settings.DEFAULT.tabIconSize)}px`,
      );
      expect(
        inherited(preview, preview.container, "--tts-size"),
      ).toBeUndefined();
      expect(declared(preview, preview.container, "--icon-size")).toBe(
        "var(--tts-size, calc(var(--icon-xs, 14px) + 2px))",
      );
    });

    it("sets the icon a little lower beside a title, by layout", () => {
      for (const host of HOSTS) {
        const on = view({ host });
        // Layout, not a transform: the icon stays on whole device pixels.
        expect(declared(on, on.container, "--tts-down")).toBe(LOWERING);
        expect(declared(on, on.container, "top")).toBe("var(--tts-down)");
        expect(declared(on, on.container, "position")).toBe("relative");
      }
    });

    it.each(SIDES)(
      "leaves a tab in a sidebar (%s) at Obsidian's size, and tells the container that size",
      (split) => {
        // Obsidian sets `--icon-size: var(--icon-m)` on the drawing itself
        // there, in a box that cuts off anything larger. The container must
        // agree, or the two boxes are laid out for another size.
        for (const size of Settings.TAB_ICON_SIZES) {
          const on = view({ size, split });
          expect(declared(on, on.container, "--icon-size")).toBe(
            "var(--icon-m, 16px)",
          );
          expect(declared(on, on.container, "top")).toBeUndefined();
          expect(inherited(on, on.icon, "--tts-down")).toBeUndefined();
          // The boxes are still counted in units of that size.
          expect(declared(on, on.container, "--tts-u")).toBe(
            "calc(var(--icon-size) / 24)",
          );
        }
      },
    );
  });

  describe("an inactive tab", () => {
    it("fades the tile and not the mark, once the tab has a status", () => {
      for (const host of HOSTS) {
        for (const status of STATUSES) {
          const on = view({ host, status });
          // The container, which Obsidian fades, stays at full strength.
          for (const property of [
            "--icon-opacity",
            "--icon-opacity-hover",
            "--icon-opacity-active",
          ]) {
            expect(declared(on, on.container, property)).toBe("1");
          }
          // The fade is on the terminal group, and nowhere in the marks.
          expect(
            declared(on, one(parts(on.icon, "tts-t"), "terminal"), "opacity"),
          ).toBe("var(--tts-o, 1)");
          expect(inherited(on, on.icon, "--tts-o")).toBe(
            "var(--icon-opacity, 0.85)",
          );
          expect(
            declared(on, one(parts(on.icon, "tts-m"), "marks"), "opacity"),
          ).toBeUndefined();
          // A mark reaches past the icon's box and is not cut off there.
          expect(declared(on, on.icon.slice(0, -1), "overflow")).toBe(
            "visible",
          );
        }
      }
    });

    it("leaves a tab without a status to Obsidian", () => {
      for (const host of HOSTS) {
        const on = view({ host });
        expect(declared(on, on.container, "--icon-opacity")).toBeUndefined();
        expect(
          declared(on, one(parts(on.icon, "tts-t"), "terminal"), "opacity"),
        ).toBeUndefined();
        expect(declared(on, on.icon.slice(0, -1), "overflow")).toBeUndefined();
      }
    });

    it("draws the tile of the active tab at the strength Obsidian gives an active tab's icon: full in a sidebar, as the others beside a title", () => {
      for (const split of [
        "mod-primary-split",
        "mod-secondary-split",
        "mod-left-split",
        "mod-right-split",
      ] as const) {
        const on = view({ active: true, split, status: "done" });
        expect(inherited(on, on.icon, "--tts-o"), split).toBe(
          "var(--icon-opacity-active, 1)",
        );
      }
      // Beside a title Obsidian does not brighten the active tab's icon, so
      // the tile must not brighten when a status arrives.
      for (const host of HOSTS) {
        const on = view({ active: true, host, status: "done" });
        expect(inherited(on, on.icon, "--tts-o"), host).toBe(
          "var(--icon-opacity, 0.85)",
        );
      }
    });
  });
});
