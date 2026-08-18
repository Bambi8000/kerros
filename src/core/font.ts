/**
 * Kerros stroke font.
 *
 * Engraved text goes out as polylines, not as the DXF TEXT entity: laser
 * front-ends treat TEXT inconsistently, and a layer number that renders as a
 * filled outline on one machine and nothing at all on another is worse than
 * useless. Strokes are strokes everywhere.
 *
 * Glyphs live on a 3 wide by 5 tall cell with the origin at the baseline left.
 * Digits are drawn seven-segment style, which is unambiguous at 3 mm on
 * scorched plywood in a way that a stylised 6 or 9 is not.
 *
 * DELIBERATE CONSTRAINT: no imports. Node validators load this as the real
 * module.
 */

/** Cell metrics in glyph units. */
export const GLYPH_WIDTH = 3;
export const GLYPH_HEIGHT = 5;
/** Cell width plus the gap to the next glyph. */
export const GLYPH_ADVANCE = 4;

type Stroke = number[][];

// Seven-segment building blocks.
const TOP: Stroke = [[0, 5], [3, 5]];
const MID: Stroke = [[0, 2.5], [3, 2.5]];
const BOTTOM: Stroke = [[0, 0], [3, 0]];
const TOP_LEFT: Stroke = [[0, 5], [0, 2.5]];
const TOP_RIGHT: Stroke = [[3, 5], [3, 2.5]];
const LOW_LEFT: Stroke = [[0, 2.5], [0, 0]];
const LOW_RIGHT: Stroke = [[3, 2.5], [3, 0]];

const GLYPHS: Record<string, Stroke[]> = {
  '0': [TOP, TOP_LEFT, TOP_RIGHT, LOW_LEFT, LOW_RIGHT, BOTTOM, [[0, 0], [3, 5]]],
  '1': [TOP_RIGHT, LOW_RIGHT],
  '2': [TOP, TOP_RIGHT, MID, LOW_LEFT, BOTTOM],
  '3': [TOP, TOP_RIGHT, MID, LOW_RIGHT, BOTTOM],
  '4': [TOP_LEFT, TOP_RIGHT, MID, LOW_RIGHT],
  '5': [TOP, TOP_LEFT, MID, LOW_RIGHT, BOTTOM],
  '6': [TOP, TOP_LEFT, MID, LOW_LEFT, LOW_RIGHT, BOTTOM],
  '7': [TOP, TOP_RIGHT, LOW_RIGHT],
  '8': [TOP, TOP_LEFT, TOP_RIGHT, MID, LOW_LEFT, LOW_RIGHT, BOTTOM],
  '9': [TOP, TOP_LEFT, TOP_RIGHT, MID, LOW_RIGHT, BOTTOM],

  A: [[[0, 0], [0, 4], [1.5, 5], [3, 4], [3, 0]], [[0, 2], [3, 2]]],
  B: [
    [[0, 0], [0, 5], [2.4, 5], [3, 4.4], [3, 3.1], [2.4, 2.5], [0, 2.5]],
    [[2.4, 2.5], [3, 1.9], [3, 0.6], [2.4, 0], [0, 0]],
  ],
  C: [[[3, 4], [2, 5], [1, 5], [0, 4], [0, 1], [1, 0], [2, 0], [3, 1]]],
  D: [[[0, 0], [0, 5], [2, 5], [3, 4], [3, 1], [2, 0], [0, 0]]],
  E: [[[3, 5], [0, 5], [0, 0], [3, 0]], [[0, 2.5], [2.2, 2.5]]],
  F: [[[3, 5], [0, 5], [0, 0]], [[0, 2.5], [2.2, 2.5]]],
  G: [[[3, 4], [2, 5], [1, 5], [0, 4], [0, 1], [1, 0], [2, 0], [3, 1], [3, 2.2], [1.7, 2.2]]],
  H: [[[0, 5], [0, 0]], [[3, 5], [3, 0]], [[0, 2.5], [3, 2.5]]],
  I: [[[0.5, 5], [2.5, 5]], [[1.5, 5], [1.5, 0]], [[0.5, 0], [2.5, 0]]],
  J: [[[2.2, 5], [2.2, 1], [1.2, 0], [0.2, 1]]],
  K: [[[0, 5], [0, 0]], [[3, 5], [0, 2.2]], [[0.9, 3], [3, 0]]],
  L: [[[0, 5], [0, 0], [3, 0]]],
  M: [[[0, 0], [0, 5], [1.5, 2.8], [3, 5], [3, 0]]],
  N: [[[0, 0], [0, 5], [3, 0], [3, 5]]],
  O: [[[1, 5], [2, 5], [3, 4], [3, 1], [2, 0], [1, 0], [0, 1], [0, 4], [1, 5]]],
  P: [[[0, 0], [0, 5], [2.4, 5], [3, 4.4], [3, 3.1], [2.4, 2.5], [0, 2.5]]],
  Q: [
    [[1, 5], [2, 5], [3, 4], [3, 1], [2, 0], [1, 0], [0, 1], [0, 4], [1, 5]],
    [[1.8, 1.2], [3, 0]],
  ],
  R: [
    [[0, 0], [0, 5], [2.4, 5], [3, 4.4], [3, 3.1], [2.4, 2.5], [0, 2.5]],
    [[1.4, 2.5], [3, 0]],
  ],
  S: [
    [
      [3, 4.4], [2.4, 5], [0.6, 5], [0, 4.4], [0, 3.1], [0.6, 2.5],
      [2.4, 2.5], [3, 1.9], [3, 0.6], [2.4, 0], [0.6, 0], [0, 0.6],
    ],
  ],
  T: [[[0, 5], [3, 5]], [[1.5, 5], [1.5, 0]]],
  U: [[[0, 5], [0, 1], [1, 0], [2, 0], [3, 1], [3, 5]]],
  V: [[[0, 5], [1.5, 0], [3, 5]]],
  W: [[[0, 5], [0.7, 0], [1.5, 2.8], [2.3, 0], [3, 5]]],
  X: [[[0, 5], [3, 0]], [[0, 0], [3, 5]]],
  Y: [[[0, 5], [1.5, 2.5], [3, 5]], [[1.5, 2.5], [1.5, 0]]],
  Z: [[[0, 5], [3, 5], [0, 0], [3, 0]]],

  '-': [[[0.4, 2.5], [2.6, 2.5]]],
  '.': [[[1.3, 0], [1.7, 0.2]]],
  '/': [[[0, 0], [3, 5]]],
  '+': [[[1.5, 4], [1.5, 1]], [[0, 2.5], [3, 2.5]]],
  '#': [[[0.8, 5], [0.4, 0]], [[2.2, 5], [1.8, 0]], [[0, 3.4], [3, 3.4]], [[0, 1.6], [3, 1.6]]],
  ' ': [],
};

/** Width of a rendered string in mm, excluding the trailing gap. */
export function textWidth(text: string, height: number): number {
  if (text.length === 0) return 0;
  const scale = height / GLYPH_HEIGHT;
  return (text.length * GLYPH_ADVANCE - (GLYPH_ADVANCE - GLYPH_WIDTH)) * scale;
}

/**
 * Render a string as polylines.
 *
 * `x`, `y` is the baseline left corner in mm. Unknown characters render as a
 * hyphen rather than vanishing, so a wrong label is visible instead of silent.
 */
export function textStrokes(
  text: string,
  x: number,
  y: number,
  height: number,
): number[][] {
  const scale = height / GLYPH_HEIGHT;
  const out: number[][] = [];

  for (let i = 0; i < text.length; i++) {
    const glyph = GLYPHS[text[i].toUpperCase()] ?? GLYPHS['-'];
    const originX = x + i * GLYPH_ADVANCE * scale;

    for (const stroke of glyph) {
      const flat: number[] = [];
      for (const [gx, gy] of stroke) {
        flat.push(originX + gx * scale, y + gy * scale);
      }
      out.push(flat);
    }
  }

  return out;
}

/** Characters this font can draw. Anything else falls back to a hyphen. */
export function supportedCharacters(): string[] {
  return Object.keys(GLYPHS);
}
