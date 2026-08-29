/**
 * Kerros stroke font.
 *
 * Engraved text goes out as polylines, not as the DXF TEXT entity: laser
 * front-ends treat TEXT inconsistently, and a layer number that renders as a
 * filled outline on one machine and nothing at all on another is worse than
 * useless. Strokes are strokes everywhere.
 *
 * Glyphs live on a 3 wide by 5 tall cell with the origin at the baseline left.
 *
 * DIGITS ARE NOT SEVEN-SEGMENT, AND THIS FILE USED TO SAY THEY SHOULD BE. The
 * claim was that seven segments stay unambiguous at 3 mm on scorched board
 * where a stylised 6 or 9 does not. It was reasoned, never measured, and it is
 * wrong: cut into cardboard, 3 and 8 could not be told apart on a pile of
 * parts, and 6 and 8 are worse.
 *
 * The reason is structural. In seven segments a 6 differs from an 8 by two
 * short verticals and nothing else, so any digit is one unburnt segment away
 * from another one. Rasterised on the cell, the closest seven-segment pair
 * differs in **2.8%** of its area. The digits below carry their differences in
 * the *shape* instead — the 8 has a waist, the 3's middle runs out to the left,
 * the 7 is crossed — and the closest pair differs in **20%**. A validator pins
 * that number, because it is the whole argument.
 *
 * Cut and read before being adopted, at 3, 4 and 5 mm. 3 mm is legible.
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

const GLYPHS: Record<string, Stroke[]> = {
  // A slash, so it can never be read as an 8.
  '0': [
    [[0.7, 0], [2.3, 0], [3, 1], [3, 4], [2.3, 5], [0.7, 5], [0, 4], [0, 1], [0.7, 0]],
    [[0.4, 1.0], [2.6, 4.0]],
  ],
  // A flag and a foot: a bare vertical is a stroke, not a digit.
  '1': [[[0.2, 3.7], [1.5, 5], [1.5, 0]], [[0.2, 0], [2.8, 0]]],
  '2': [[[0.1, 4.1], [0.9, 5], [2.2, 5], [3, 4.1], [3, 3.3], [0, 0], [3, 0]]],
  // The middle runs out to the left past the centre line, so the open left side
  // reads as deliberate rather than as a segment that failed to burn.
  '3': [
    [
      [0.1, 4.2], [0.9, 5], [2.2, 5], [3, 4.2], [3, 3.4], [2.1, 2.6],
      [3, 1.8], [3, 0.8], [2.2, 0], [0.9, 0], [0.1, 0.8],
    ],
    [[2.1, 2.6], [0.5, 2.6]],
  ],
  '4': [[[2.3, 0], [2.3, 5], [0, 1.5], [3, 1.5]]],
  '5': [
    [
      [2.9, 5], [0.6, 5], [0.45, 2.75], [1.7, 2.95], [2.4, 2.7], [3, 1.9],
      [3, 1.0], [2.2, 0], [0.9, 0], [0.1, 0.65],
    ],
  ],
  '6': [
    [
      [2.6, 5], [1.1, 4.3], [0.2, 2.4], [0.2, 1.0], [1.0, 0], [2.2, 0],
      [3, 1.0], [3, 1.9], [2.2, 2.8], [1.0, 2.8], [0.25, 2.15],
    ],
  ],
  // Crossed, or it is a 1 with a hat.
  '7': [[[0, 5], [3, 5], [1.2, 0]], [[0.75, 2.3], [2.45, 2.3]]],
  // The waist is what does the work: two loops pinched at the middle, and no
  // other digit has one. It is the whole reason 3, 6 and 0 stopped being 8s.
  '8': [
    [[1.5, 2.6], [2.5, 3.2], [2.5, 4.4], [1.5, 5], [0.5, 4.4], [0.5, 3.2], [1.5, 2.6]],
    [[1.5, 2.6], [2.9, 1.8], [2.9, 0.7], [1.5, 0], [0.1, 0.7], [0.1, 1.8], [1.5, 2.6]],
  ],
  '9': [
    [
      [2.85, 2.9], [2.0, 2.15], [0.9, 2.15], [0.15, 2.95], [0.15, 4.1],
      [0.95, 5], [2.05, 5], [2.85, 4.1], [2.85, 1.3], [2.1, 0.15], [0.8, 0],
    ],
  ],

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

/* ------------------------------------------------------------------ *
 * Glyph test figure
 *
 * Cut once per material, next to the kerf test, and read: it answers what size
 * a layer number has to be to be legible on *this* board.
 *
 * It lives here rather than beside `kerfTestDocument` in `dxf.ts` because that
 * module may not import values — it is loaded by validators as the real thing —
 * and a figure made of glyphs has to reach the font. The type import below is
 * erased, so both constraints hold.
 *
 * The question it answers has changed once already. It was built to compare two
 * fonts; the comparison is over and the seven-segment digits are gone, so what
 * is left is the part that recurs: a new board scorches differently, and 3 mm
 * on cardboard is not 3 mm on plywood.
 * ------------------------------------------------------------------ */

import type { DxfDocument, DxfPolyline } from './dxf.ts';

export interface GlyphTestOptions {
  /** Cap heights to try, mm, largest first. */
  sizes: number[];
  /** Pairs worth staring at, because they are the ones that get confused. */
  pairs: string[];
}

export const DEFAULT_GLYPH_TEST: GlyphTestOptions = {
  sizes: [5, 4, 3, 2.5, 2],
  pairs: ['38', '68', '08', '58', '69', '17', '36', '35'],
};

/**
 * Digits at several sizes, with the confusable pairs after them.
 *
 * Each row is labelled with its own height at a fixed, comfortable size, so the
 * label stays readable even on the row that turns out not to be. Nothing is
 * kerf-compensated: an engraved line has no width to compensate, and the figure
 * is a measurement.
 */
export function glyphTestDocument(
  options: GlyphTestOptions = DEFAULT_GLYPH_TEST,
): DxfDocument {
  const polylines: DxfPolyline[] = [];
  const margin = 10;
  const labelSize = 4;

  let y = margin;
  let widest = 0;

  // Bottom up, so the largest row ends up at the top of the sheet.
  for (const size of [...options.sizes].sort((a, b) => a - b)) {
    const label = `${size}`;
    for (const stroke of textStrokes(label, margin, y, labelSize)) {
      polylines.push({ points: stroke, layer: 'ENGRAVE', closed: false });
    }

    let x = margin + textWidth(label, labelSize) + labelSize * 2;
    for (const stroke of textStrokes('0123456789', x, y, size)) {
      polylines.push({ points: stroke, layer: 'ENGRAVE', closed: false });
    }

    x += textWidth('0123456789', size) + size * 2;
    for (const pair of options.pairs) {
      for (const stroke of textStrokes(pair, x, y, size)) {
        polylines.push({ points: stroke, layer: 'ENGRAVE', closed: false });
      }
      x += textWidth(pair, size) + size;
    }

    widest = Math.max(widest, x);
    y += Math.max(size, labelSize) * 2.2;
  }

  const w = widest + margin;
  const h = y + margin - options.sizes[0] * 0.6;
  polylines.push({ points: [0, 0, w, 0, w, h, 0, h], layer: 'CUT' });

  return { polylines, circles: [] };
}
