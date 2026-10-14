/**
 * Tab icons: one composite SVG per icon set. Each holds the terminal icon
 * and every status mark; `tab-status.css` decides which mark shows, from the
 * `data-terminal-*` attributes on the tab header.
 *
 * Obsidian clones a registered icon into every tab, so nothing here may carry
 * an `id` or point at one: no `<defs>`, masks, gradients or `<use>`. A set
 * is a small image (`tab-skins.ts`), a square with a raised border, under
 * the prompt drawn on its face (`bezel`): an `<image>` with a data URI needs
 * no `id`. The other set, `tile`, has no image: its tile is a rounded square
 * drawn as a line.
 *
 * The marks stand on the tile's upper right corner and reach past it.
 * Nothing is cut out of the tile for them: a white ring and a dark hairline
 * around a mark set it off from whatever lies under it.
 *
 * The moon is a Phosphor Icon, fill weight (MIT, Copyright (c) 2023 Phosphor
 * Icons, https://phosphoricons.com).
 */
import { TAB_SKINS, type TabSkin, type TabSkinName } from "./tab-skins.js";
import type { Settings } from "../settings-data.js";

/** The drawing space is 24 units; Obsidian's icon view box is 100. */
export const TAB_ICON_WRAPPER_ATTRIBUTES =
  'transform="scale(4.1666667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

/**
 * The parts every set has, each as the classes one element carries: the
 * terminal group, the tile (an image, or the group of a drawn one), the
 * marks group and the four marks. The tests look for each in every set.
 */
export const TAB_ICON_CLASSES: readonly string[] = Object.freeze([
  "tts-t",
  "tts-skin",
  "tts-m",
  "tts-mk tts-mk-dot",
  "tts-mk tts-mk-eye",
  "tts-mk tts-mk-badge",
  "tts-mk tts-mk-dots",
]);

/**
 * Where the marks stand and how large they are, in units of the 24-unit
 * drawing. The numbers of the dot and the badge are the ones that were
 * chosen for the design.
 *
 * - `dot`: the small dot off the corner. Full for done and needs input; a
 *   ring with a core (the "eye") for an error.
 * - `badge`: a disc with a symbol on it: the moon of an idle program, the
 *   check of a seen one.
 * - `dots`: the three dots of a working program, on a white bar. The last
 *   stands where the dot stands, the others to its left. They are drawn
 *   `rest` of their size, and so they stand where nothing moves. Where they
 *   move they are faint, and a lit one is `peak` of its size: the
 *   stylesheet draws the lit ones over these with two boxes
 *   (`tab-status.css`, section 6), to the numbers below; a test keeps the
 *   two in step. The dots, their distance and the bar are 1.3 times the
 *   chosen radius 1.16, pitch 3.13 and margin 0.8; the hairline is the one
 *   every mark has.
 *
 * `ring` is the width of the white ring around a mark and `edge` that of
 * the dark hairline outside it.
 */
export const TAB_ICON_MARKS = Object.freeze({
  badge: Object.freeze({
    cx: 20.9,
    cy: 3.1,
    edge: 0.3,
    radius: 4.37,
    ring: 0.7,
    /** The symbols are drawn 12 units wide and brought onto the disc by this. */
    symbol: 0.515,
  }),
  dot: Object.freeze({ cx: 21, cy: 3, edge: 0.3, radius: 2.9, ring: 1 }),
  dots: Object.freeze({
    edge: 0.3,
    /** How far the white plate reaches past the dots. */
    margin: 1.04,
    peak: 1.1,
    /** From one dot's centre to the next. */
    pitch: 4.07,
    radius: 1.51,
    rest: 0.8,
  }),
});

function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

// Phosphor Icons (MIT), fill weight, 256-unit grid: `moon-fill`.
const PHOSPHOR_MOON =
  "M235.54,150.21a104.84,104.84,0,0,1-37,52.91A104,104,0,0,1,32,120,103.09,103.09,0,0,1,52.88,57.48a104.84,104.84,0,0,1,52.91-37,8,8,0,0,1,10,10,88.08,88.08,0,0,0,109.8,109.8,8,8,0,0,1,10,10Z";

/** The white ring of a round mark and the hairline outside it, around (0, 0). */
function plate(radius: number, ring: number, edge: number): string {
  return `<circle class="tts-mk-edge" r="${num(radius + ring + edge)}"/><circle class="tts-mk-ring" r="${num(radius + ring)}"/>`;
}

/** A rounded bar around the three dots, `grow` past their outline. */
function bar(grow: number): string {
  const { pitch, radius } = TAB_ICON_MARKS.dots,
    half = radius + grow;
  return `x="${num(-2 * pitch - half)}" y="${num(-half)}" width="${num(2 * pitch + 2 * half)}" height="${num(2 * half)}" rx="${num(half)}"`;
}

/**
 * Every mark. Each is whole in itself, with its own ring and hairline, so
 * the stylesheet only chooses which one shows and what colour it has.
 */
const MARKS = ((): string => {
  const { badge, dot, dots } = TAB_ICON_MARKS,
    at = (place: { readonly cx: number; readonly cy: number }): string =>
      `transform="translate(${num(place.cx)} ${num(place.cy)})"`,
    round = plate(dot.radius, dot.ring, dot.edge),
    // The ring's outer edge is the dot's; its core is what makes it an eye.
    eye = `<circle class="tts-mk-line" r="${num(dot.radius * 0.86)}" stroke-width="${num(dot.radius * 0.28)}"/><circle class="tts-mk-ink" r="${num(dot.radius * 0.42)}"/>`,
    symbols = [
      '<polyline class="tts-sym-check" points="-3.5,0.4 -1.2,2.7 3.6,-2.6"/>',
      `<path class="tts-sym-moon" transform="rotate(-10) scale(.0535) translate(-131 -124)" d="${PHOSPHOR_MOON}"/>`,
    ].join(""),
    three = [2, 1, 0]
      .map(
        (left) =>
          `<circle class="tts-mk-ink" cx="${num(-left * dots.pitch)}" r="${num(dots.radius * dots.rest)}"/>`,
      )
      .join("");
  return [
    '<g class="tts-m" stroke="none">',
    `<g class="tts-mk tts-mk-dot" ${at(dot)}>${round}<circle class="tts-mk-ink" r="${num(dot.radius)}"/></g>`,
    `<g class="tts-mk tts-mk-eye" ${at(dot)}>${round}${eye}</g>`,
    `<g class="tts-mk tts-mk-badge" ${at(badge)}>${plate(badge.radius, badge.ring, badge.edge)}<circle class="tts-mk-ink" r="${num(badge.radius)}"/><g class="tts-sym" transform="scale(${String(badge.symbol)})">${symbols}</g></g>`,
    `<g class="tts-mk tts-mk-dots" ${at(dot)}><rect class="tts-mk-edge" ${bar(dots.margin + dots.edge)}/><rect class="tts-mk-ring" ${bar(dots.margin)}/>${three}</g>`,
    "</g>",
  ].join("");
})();

/** What an icon set is made of. The marks are added to it. */
export interface TabIconParts {
  /** `<g class="tts-t">…</g>`: the icon at rest. */
  readonly terminal: string;
}

/** The box a tile fills. */
export const TAB_ICON_TILE_BOX = Object.freeze({ size: 21, x: 1.5, y: 1.3 });

/** A prompt: a chevron and an underscore, in lines `width` units wide. */
function prompt(chevron: string, underscore: string, width: number): string {
  return `<g class="tts-ink" stroke-width="${num(width)}"><path d="${chevron}"/><path d="${underscore}"/></g>`;
}

/** The prompt of a rendered tile, around the middle of the tile box. */
const SKIN_PROMPT = prompt("m7.6 8.7 3.3 3.2-3.3 3.2", "M12.7 15.1h3.8", 1.9);

/**
 * The rounded square of the set drawn in lines alone (`tile`), in units of
 * the 24-unit drawing: its line is as wide as the icon's lines (2), so its
 * outer edge is 20 wide, a little inside the tile box.
 */
export const TAB_ICON_LINE_TILE = Object.freeze({
  radius: 4.6,
  size: 18,
  x: 3,
  y: 2.6,
});

/**
 * The set drawn in lines alone: a rounded square and a prompt, both in the
 * icon's colour, and no image. The square is the set's tile: it carries the
 * tile's class (`tts-skin`), and a status colours its line where it would
 * light a rendered tile. It stands on no shadow.
 */
function tabIconLined(): TabIconParts {
  const { radius, size, x, y } = TAB_ICON_LINE_TILE;
  return {
    terminal: [
      '<g class="tts-t">',
      `<g class="tts-skin"><rect x="${num(x)}" y="${num(y)}" width="${num(size)}" height="${num(size)}" rx="${num(radius)}"/></g>`,
      prompt("m7.6 8.3 3.3 3.3-3.3 3.3", "M12.6 14.9h3.9", 2),
      "</g>",
    ].join(""),
  };
}

/**
 * A rendered tile: one image per theme under the prompt. The stylesheet
 * shows the image of the current theme. The tile is neutral; a state shows
 * as a glow around it and as a mark on its corner.
 *
 * The tile is as wide as the tile box and stands around the box's middle: a
 * square with rounded corners.
 *
 * @param name the tile
 * @returns the parts of the set
 */
export function tabIconSkinned(name: TabSkinName): TabIconParts {
  const skin: TabSkin = TAB_SKINS[name],
    { size, x, y } = TAB_ICON_TILE_BOX,
    corner = skin.radius * size,
    /** The tile's outline, `grow` outside it and `down` below it, as an open tag. */
    shape = (grow: number, down: number): string =>
      `<rect x="${num(x - grow)}" y="${num(y - grow + down)}" width="${num(size + 2 * grow)}" height="${num(size + 2 * grow)}" rx="${num(corner + grow)}"`,
    image = (theme: "dark" | "light"): string =>
      `<image class="tts-skin tts-skin-${theme}" x="${num(x)}" y="${num(y)}" width="${num(size)}" height="${num(size)}" href="${skin[theme]}"/>`,
    terminal = [
      '<g class="tts-t">',
      // The soft shadow a tile stands on, in every theme.
      `<g class="tts-skin-drop" stroke="none" fill="black">${shape(0.4, 0.7)} opacity=".06"/>${shape(0, 0.6)} opacity=".12"/></g>`,
      image("dark"),
      image("light"),
      SKIN_PROMPT,
      "</g>",
    ].join("");
  return { terminal };
}

const SETS: Readonly<Record<Settings.TabIconSet, TabIconParts>> = Object.freeze(
  {
    bezel: tabIconSkinned("bezel"),
    tile: tabIconLined(),
  },
);

/**
 * The content to register for one icon set: Obsidian wraps it in
 * `<svg viewBox="0 0 100 100" class="svg-icon …">`.
 *
 * Nothing in the icon moves. The three dots of a working program are lit by
 * two boxes that the stylesheet draws over the icon.
 */
export function composeTabIcon(set: Settings.TabIconSet): string {
  const { terminal } = SETS[set];
  return `<g class="tts tts-set-${set}" ${TAB_ICON_WRAPPER_ATTRIBUTES}>${terminal}${MARKS}</g>`;
}
