/**
 * Raster tiles that sit under what is drawn on a tab icon's face.
 *
 * Each is a small WebP with transparency, 96 px wide, embedded as a data
 * URI so the icon stays a single self-contained SVG: Obsidian clones tab
 * icons, and anything referenced by `id` breaks when the first clone is
 * hidden. A tab icon is 12 to 24 px, so at most 53 device pixels on a 2.2x
 * display. The tile is a pair, one image per theme: the face is the same in
 * both and the border is what differs.
 *
 * The tiles are neutral on purpose. State colour comes from what the
 * stylesheet puts around and over them (the glow, the mark), and the light
 * on the face from a shape drawn over it, never from the image.
 *
 * The images were drawn and encoded by scripts that are not in this
 * repository, so the file is kept by hand: it cannot be generated again
 * from here.
 */

/**
 * The dark face inside a tile's border, the same in both images: a square
 * with rounded corners. Each number is a fraction of the tile's width.
 */
export interface TabSkinFace {
  /** How far the face's upper left corner lies inside the tile's, across and down. */
  readonly inset: number;
  /** How wide and how high the face is. */
  readonly size: number;
  /** The corner radius of the face. */
  readonly radius: number;
}

/** A tile: a square with a raised border, one image per theme. */
export interface TabSkin {
  /** Corner radius of the tile, as a fraction of its width. Both images are cut to it. */
  readonly radius: number;
  /** The width of the border drawn in the image, as a fraction of the tile's width. */
  readonly border: number;
  /**
   * The dark face inside the border, measured on the images: the edge is
   * where the brightness crosses one level per image, halfway between the
   * face and the border on its upper left side.
   */
  readonly face: TabSkinFace;
  readonly dark: string;
  readonly light: string;
}

export const TAB_SKINS = Object.freeze({
  bezel: {
    border: 0.1,
    dark: "data:image/webp;base64,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",
    /*
     * Measured on both images of 96 px: the face runs from 10.4 px to
     * 84.8 px across and from 10.4 px to 84.7 px down, with corners of
     * 12.5 px. It sits 0.4 px of the image up and to the left of the
     * middle, and is drawn where it is: centred, the light on it would
     * leave a sliver of the face dark on two sides and spill onto the
     * border on the other two. On the lower right, where the border is
     * brighter, halfway between it and the face lies 0.25 to 0.5 px further
     * out; the light stops short of that by less than a tenth of a CSS
     * pixel.
     */
    face: { inset: 0.1085, radius: 0.13, size: 0.775 },
    light:
      "data:image/webp;base64,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",
    radius: 0.245,
  },
}) satisfies Readonly<Record<string, TabSkin>>;

export type TabSkinName = keyof typeof TAB_SKINS;
