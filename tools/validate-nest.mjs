#!/usr/bin/env node
/**
 * validate-nest.mjs
 *
 * Covers what M4 adds, against the real modules: the stroke font, spacer ring
 * planning, label placement on parts with holes, and shelf nesting.
 *
 *   node tools/validate-nest.mjs
 */

import {
  GLYPH_ADVANCE,
  GLYPH_HEIGHT,
  GLYPH_WIDTH,
  glyphTestDocument,
  DEFAULT_GLYPH_TEST,
  textStrokes,
  textWidth,
  supportedCharacters,
} from '../src/core/font.ts';

import {
  boundsOf,
  findLabelSpot,
  nestParts,
  countParts,
  nestByMaterial,
  applyPlacements,
  findOverlaps,
  analyseSheet,
  clampPlacement,
  partAt,
  placedBox,
  rotatePart,
  scatterRotations,
  estimateLabelWidth,
  nestTrueShape,
  rasterisePart,
  partArea,
} from '../src/core/nest.ts';

import {
  ringsPerGap,
  spacerHeightAchieved,
  spacerPlans,
  circlePoints,
  rodCutRadius,
  pinGaps,
  loosePins,
  defaultStagger,
} from '../src/core/rig.ts';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

function ring(cx, cy, r, n = 200) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return pts;
}

function rect(x, y, w, h) {
  return [x, y, x + w, y, x + w, y + h, x, y + h];
}

console.log('font: glyph coverage and metrics');
{
  const chars = supportedCharacters();
  check('all ten digits are present', '0123456789'.split('').every((c) => chars.includes(c)));
  check('the full uppercase alphabet is present', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').every((c) => chars.includes(c)));

  const every = chars.filter((c) => c !== ' ');
  let emptyGlyphs = [];
  let outOfBox = [];
  for (const c of every) {
    const strokes = textStrokes(c, 0, 0, GLYPH_HEIGHT);
    if (strokes.length === 0) emptyGlyphs.push(c);
    for (const stroke of strokes) {
      for (let i = 0; i < stroke.length; i += 2) {
        if (
          stroke[i] < -1e-9 ||
          stroke[i] > GLYPH_WIDTH + 1e-9 ||
          stroke[i + 1] < -1e-9 ||
          stroke[i + 1] > GLYPH_HEIGHT + 1e-9
        ) {
          outOfBox.push(c);
        }
      }
    }
  }
  check('no glyph is blank', emptyGlyphs.length === 0, emptyGlyphs.join(''));
  check('no glyph leaves its cell', outOfBox.length === 0, Array.from(new Set(outOfBox)).join(''));

  check('a space draws nothing', textStrokes(' ', 0, 0, 5).length === 0);
  check('an unknown character falls back rather than vanishing', textStrokes('\u00a7', 0, 0, 5).length > 0);
  check('lowercase renders as uppercase', textStrokes('l', 0, 0, 5).length === textStrokes('L', 0, 0, 5).length);

  check('every stroke has at least two points', textStrokes('KERROS 2026', 0, 0, 4).every((s) => s.length >= 4));
}

console.log('font: digits have to be told apart on a pile of parts');
{
  /*
   * The measurement that replaced an opinion.
   *
   * This file used to say seven-segment digits stay unambiguous at 3 mm on
   * scorched board. That was reasoned and never checked, and cutting a real
   * lamp disproved it: 3 and 8 could not be told apart on a pile of parts, and
   * 6 and 8 are worse — in seven segments they differ by two short verticals
   * and nothing else, so every digit is one unburnt segment from another.
   *
   * Rasterise each glyph on its own cell and compare: the closest seven-segment
   * pair differed in 2.8% of its area. The shape-led digits manage 20%. The
   * threshold below sits between the two, so this fails if anybody quietly
   * reverts to segments — and it is the only argument the new digits have.
   */
  const raster = (ch, w = 30, h = 50, pen = 0.16) => {
    const strokes = textStrokes(ch, 0, 0, GLYPH_HEIGHT);
    const segs = [];
    for (const flat of strokes) {
      for (let i = 0; i + 3 < flat.length; i += 2) {
        segs.push([flat[i], flat[i + 1], flat[i + 2], flat[i + 3]]);
      }
    }
    const cells = [];
    for (let gy = 0; gy < h; gy++) {
      for (let gx = 0; gx < w; gx++) {
        const px = ((gx + 0.5) * GLYPH_WIDTH) / w;
        const py = ((gy + 0.5) * GLYPH_HEIGHT) / h;
        let hit = false;
        for (const [ax, ay, bx, by] of segs) {
          const ex = bx - ax;
          const ey = by - ay;
          const len2 = ex * ex + ey * ey;
          let t = len2 === 0 ? 0 : ((px - ax) * ex + (py - ay) * ey) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          if (Math.hypot(px - (ax + ex * t), py - (ay + ey * t)) <= pen) {
            hit = true;
            break;
          }
        }
        cells.push(hit);
      }
    }
    return cells;
  };

  const digits = '0123456789';
  const grids = new Map(digits.split('').map((d) => [d, raster(d)]));
  const unlike = (a, b) => {
    const x = grids.get(a);
    const y = grids.get(b);
    let differ = 0;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) differ++;
    return differ / x.length;
  };

  let worst = 1;
  let worstPair = '';
  for (let i = 0; i < digits.length; i++) {
    for (let j = i + 1; j < digits.length; j++) {
      const d = unlike(digits[i], digits[j]);
      if (d < worst) {
        worst = d;
        worstPair = digits[i] + digits[j];
      }
    }
  }

  check(
    'no two digits are near-copies of each other',
    worst > 0.12,
    `the closest pair is ${worstPair} at ${(worst * 100).toFixed(1)}% — seven-segment managed 2.8%`,
  );

  // The three that were actually confused on the bench, named so a regression
  // says which one came back.
  for (const pair of ['38', '68', '08', '58']) {
    check(
      `${pair[0]} and ${pair[1]} are plainly different`,
      unlike(pair[0], pair[1]) > 0.2,
      `${(unlike(pair[0], pair[1]) * 100).toFixed(1)}%`,
    );
  }

  /*
   * The two features that carry most of that difference, pinned directly so a
   * redraw cannot quietly drop them. The 8's waist is a narrowing at the middle
   * that no other digit has; the 7's bar is what keeps it from being a 1.
   */
  const widthAt = (ch, y) => {
    const strokes = textStrokes(ch, 0, 0, GLYPH_HEIGHT);
    let lo = Infinity;
    let hi = -Infinity;
    for (const flat of strokes) {
      for (let i = 0; i + 3 < flat.length; i += 2) {
        const [ax, ay, bx, by] = [flat[i], flat[i + 1], flat[i + 2], flat[i + 3]];
        if ((ay - y) * (by - y) > 0) continue;
        const t = ay === by ? 0 : (y - ay) / (by - ay);
        const x = ax + (bx - ax) * t;
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    }
    return hi - lo;
  };

  check(
    'the 8 has a waist',
    widthAt('8', 2.6) < widthAt('8', 4) - 0.5 && widthAt('8', 2.6) < widthAt('8', 1) - 0.5,
    `${widthAt('8', 2.6).toFixed(2)} mm at the middle against ${widthAt('8', 4).toFixed(2)} above`,
  );
  check('and it is the only digit with one', (() => {
    for (const d of digits) {
      if (d === '8') continue;
      const w = widthAt(d, 2.6);
      if (Number.isFinite(w) && w < widthAt(d, 4) - 0.5 && w < widthAt(d, 1) - 0.5) return false;
    }
    return true;
  })());
  check('the 7 is crossed', textStrokes('7', 0, 0, GLYPH_HEIGHT).length === 2);
  check("the 3's middle runs left of centre", (() => {
    const strokes = textStrokes('3', 0, 0, GLYPH_HEIGHT);
    return strokes.some((flat) => {
      for (let i = 0; i < flat.length; i += 2) {
        if (Math.abs(flat[i + 1] - 2.6) < 0.01 && flat[i] < GLYPH_WIDTH / 2) return true;
      }
      return false;
    });
  })());
  check('every digit still fits its cell', digits.split('').every((d) => {
    const flat = textStrokes(d, 0, 0, GLYPH_HEIGHT).flat();
    for (let i = 0; i < flat.length; i += 2) {
      if (flat[i] < -1e-9 || flat[i] > GLYPH_WIDTH + 1e-9) return false;
      if (flat[i + 1] < -1e-9 || flat[i + 1] > GLYPH_HEIGHT + 1e-9) return false;
    }
    return true;
  }));
}

console.log('font: the figure that answers what size to use');
{
  const doc = glyphTestDocument();
  check('it draws something', doc.polylines.length > 100);
  check('and nothing round', doc.circles.length === 0);

  const cut = doc.polylines.filter((p) => p.layer === 'CUT');
  const engraved = doc.polylines.filter((p) => p.layer === 'ENGRAVE');
  check('one cut outline', cut.length === 1);
  check('the digits are engraved, not cut', engraved.length === doc.polylines.length - 1);
  check('and left open, because a stroke is not a ring', engraved.every((p) => p.closed === false));

  const xs = cut[0].points.filter((_, i) => i % 2 === 0);
  const ys = cut[0].points.filter((_, i) => i % 2 === 1);
  const w = Math.max(...xs);
  const h = Math.max(...ys);
  check('it fits a bed', w < 400 && h < 300, `${w.toFixed(0)} x ${h.toFixed(0)} mm`);
  check(
    'and everything engraved is inside the outline',
    engraved.every((p) => {
      for (let i = 0; i < p.points.length; i += 2) {
        if (p.points[i] < 0 || p.points[i] > w) return false;
        if (p.points[i + 1] < 0 || p.points[i + 1] > h) return false;
      }
      return true;
    }),
  );

  /*
   * Every size asked for has to appear, or the figure quietly answers a
   * different question than the one it was given.
   */
  const heights = new Set();
  for (const p of engraved) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 1; i < p.points.length; i += 2) {
      lo = Math.min(lo, p.points[i]);
      hi = Math.max(hi, p.points[i]);
    }
    heights.add(Math.round((hi - lo) * 100) / 100);
  }
  check(
    'a stroke exists at every size asked for',
    DEFAULT_GLYPH_TEST.sizes.every((size) =>
      [...heights].some((v) => Math.abs(v - size) < size * 0.02),
    ),
    `${DEFAULT_GLYPH_TEST.sizes.join(', ')} mm`,
  );

  const fewer = glyphTestDocument({ sizes: [3], pairs: ['38'] });
  check('fewer rows make a smaller figure', fewer.polylines.length < doc.polylines.length);
  check('and still one outline', fewer.polylines.filter((p) => p.layer === 'CUT').length === 1);
}

console.log('font: layout');
{
  const height = 4;
  const scale = height / GLYPH_HEIGHT;

  check('a single glyph is one cell wide', near(textWidth('8', height), GLYPH_WIDTH * scale, 1e-12));
  check(
    'three glyphs span two advances plus a cell',
    near(textWidth('L07', height), (2 * GLYPH_ADVANCE + GLYPH_WIDTH) * scale, 1e-12),
  );
  check('an empty string has no width', textWidth('', height) === 0);

  const strokes = textStrokes('L07', 10, 20, height);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (let i = 0; i < stroke.length; i += 2) {
      minX = Math.min(minX, stroke[i]);
      maxX = Math.max(maxX, stroke[i]);
      minY = Math.min(minY, stroke[i + 1]);
      maxY = Math.max(maxY, stroke[i + 1]);
    }
  }
  check('text starts at the anchor', near(minX, 10, 1e-9) && near(minY, 20, 1e-9));
  check('text is the height it says', near(maxY - minY, height, 1e-9));
  check(
    'rendered width matches the measured width',
    near(maxX - minX, textWidth('L07', height), 1e-9),
    `${(maxX - minX).toFixed(4)} vs ${textWidth('L07', height).toFixed(4)}`,
  );
  check(
    'scaling is linear',
    near(textWidth('LAYER 12', 8), 2 * textWidth('LAYER 12', 4), 1e-9),
  );
}

console.log('spacers: ring counting');
{
  // 3 mm here is the thickness of the **spacer** material, not the stock's. The
  // two used to be the same number; separating them is what makes thin sheet
  // usable, and this block is now about the ring material throughout.
  const base = { thickness: 3, spacerHeight: 6, kerf: 0.2, ringWidth: 4 };
  check('a 6 mm gap in 3 mm material needs two rings', ringsPerGap(base) === 2);
  check('the achieved gap is exactly two sheets', near(spacerHeightAchieved(base), 6, 1e-12));

  const awkward = { ...base, spacerHeight: 6.5 };
  check('an awkward height rounds to a whole number of rings', ringsPerGap(awkward) === 2);
  check(
    'and reports the gap you will actually get, not the one you asked for',
    near(spacerHeightAchieved(awkward), 6, 1e-12),
  );

  check('a tight stack needs no rings', ringsPerGap({ ...base, spacerHeight: 0 }) === 0);
  check('a gap thinner than the material still needs one ring', ringsPerGap({ ...base, spacerHeight: 1 }) === 1);

  // Rings out of their own material: the same 6 mm gap, six 1 mm rings.
  const thin = { ...base, spacerThickness: 1 };
  check('1 mm rings fill a 6 mm gap six deep', ringsPerGap(thin) === 6);
  check('and the gap comes out the same', near(spacerHeightAchieved(thin), 6, 1e-12));
  check(
    'the stock thickness no longer decides the ring count',
    ringsPerGap({ ...thin, thickness: 0.5 }) === 6,
  );

  const rods = [
    { id: 'a', label: 'Rod 1', size: 'M5', x: 40, y: 0, zStart: 0, zEnd: 100, diameter: 0 },
    { id: 'b', label: 'Rod 2', size: 'M8', x: -40, y: 0, zStart: 0, zEnd: 20, diameter: 0 },
    { id: 'c', label: 'Rod 3', size: 'M5', x: 0, y: 40, zStart: 500, zEnd: 600, diameter: 0 },
  ];
  // Sheets 10 mm apart at 3 mm thick leaves a 7 mm gap, which takes two 3 mm
  // rings. Rings are counted from the gap that is there, not from the one that
  // was asked for, so this is the number that matters.
  const slices = [0, 10, 20, 30, 40].map((z) => ({ z, circles: [] }));

  const plans = spacerPlans(rods, slices, base);
  check('rods that reach the stack get plans', plans.length === 2, `${plans.length} plans`);

  const full = plans.find((p) => p.rodId === 'a');
  check('a rod through five layers has four gaps', full.gaps === 4);
  check('four gaps at two rings each is eight rings', full.total === 8);
  check('and every gap takes the same two', full.ringsMin === 2 && full.ringsMax === 2);
  check(
    'the bore matches the clearance hole on the slices',
    near(full.innerR, rodCutRadius(5.3, 0.2), 1e-12),
  );
  check(
    'the outside is the ring width past the rod, plus half a kerf',
    near(full.outerR, 5.3 / 2 + 4 + 0.1, 1e-12),
  );
  check('the bore is smaller than the outside', full.innerR < full.outerR);

  const short = plans.find((p) => p.rodId === 'b');
  check('a rod through three layers has two gaps', short.gaps === 2);
  check('a rod that misses the stack gets no plan', !plans.some((p) => p.rodId === 'c'));

  const single = spacerPlans([{ ...rods[0], zStart: 0, zEnd: 0 }], slices, base);
  check('a rod reaching one layer needs no spacers', single.length === 0);

  /*
   * A tight stack means the sheets touch, so the test has to say so with the
   * slices as well as with the setting. The old version left the sheets 10 mm
   * apart and set the spacer height to zero, which is not a tight stack — it is
   * a stack with 7 mm gaps and a setting that disagrees with it. Counting from
   * the measured gap is what made the inconsistency visible.
   */
  const touching = [0, 3, 6, 9, 12].map((z) => ({ z, circles: [] }));
  check(
    'tight stacking generates no spacers at all',
    spacerPlans(rods, touching, { ...base, spacerHeight: 0 }).length === 0,
  );

  // A graded stack: gaps of 3, 6 and 9 mm from 3 mm rings.
  const graded = [0, 6, 12, 21, 33].map((z) => ({ z, circles: [] }));
  const gradedPlan = spacerPlans([rods[0]], graded, base)[0];
  check('a graded stack still gets one plan per rod', gradedPlan !== undefined);
  check('with a gap per pair of sheets', gradedPlan.gaps === 4);
  check(
    'rings counted per gap rather than multiplied out',
    gradedPlan.total === 1 + 1 + 2 + 3,
    `${gradedPlan.total} rings`,
  );
  check('and the range reported', gradedPlan.ringsMin === 1 && gradedPlan.ringsMax === 3);

  // Two sheets three pitches apart need three pitches of rings.
  const voided = [0, 27].map((z) => ({ z, circles: [] }));
  const acrossVoid = spacerPlans([rods[0]], voided, base)[0];
  check('a void along Z is filled rather than counted as one gap', acrossVoid.total === 8,
    `${acrossVoid.total} rings for a 24 mm gap of 3 mm rings`);
}

console.log('pins: one gap per pair of sheets');
{
  const pin = (patch) => ({
    id: 'p',
    label: 'Pins',
    count: 3,
    diameter: 4,
    radius: 40,
    angle: 0,
    stagger: 0,
    x: 0,
    y: 0,
    kerf: 0.2,
    ...patch,
  });

  const layers = [1, 2, 3, 4, 5, 6];
  const gaps = pinGaps(pin({}), layers);

  check('six sheets have five gaps', gaps.length === 5);
  check('each joins neighbours', gaps.every((g, i) => g.below === layers[i] && g.above === layers[i + 1]));
  check('one hole per pin', gaps.every((g) => g.holes.length === 3));
  check('cut a kerf under size, like every other hole', near(gaps[0].holes[0].r, rodCutRadius(4, 0.2), 1e-12));
  check('each hole knows which feature made it', gaps.every((g) => g.holes.every((h) => h.owner === 'p')));
  check('and they sit on the radius asked for', gaps.every((g) => g.holes.every((h) => near(Math.hypot(h.x, h.y), 40, 1e-9))));

  check('fewer than two sheets is not a stack', pinGaps(pin({}), [1]).length === 0 && pinGaps(pin({}), []).length === 0);
  check('two sheets are one gap', pinGaps(pin({}), [1, 2]).length === 1);

  /*
   * The rule the whole idea rests on.
   *
   * Gap k-1 drills sheets k-1 and k; gap k drills sheets k and k+1. Both go
   * through sheet k, so at the same angle the two pins would meet inside it.
   * Consecutive gaps must be turned apart, and the default turns them as far
   * apart as they go.
   */
  const angleOf = (h) => ((Math.atan2(h.y, h.x) * 180) / Math.PI + 360) % 360;
  const closestBetween = (a, b) => {
    let best = 360;
    for (const x of a.holes.map(angleOf)) {
      for (const y of b.holes.map(angleOf)) {
        let d = Math.abs(x - y) % 360;
        d = Math.min(d, 360 - d);
        best = Math.min(best, d);
      }
    }
    return best;
  };

  for (let i = 0; i + 1 < gaps.length; i++) {
    check(
      `gap ${i + 1} and ${i + 2} do not share an angle`,
      closestBetween(gaps[i], gaps[i + 1]) > 1e-6,
      `${closestBetween(gaps[i], gaps[i + 1]).toFixed(3)} degrees apart`,
    );
  }
  check(
    'the default turn is half a position, the furthest they go',
    near(closestBetween(gaps[0], gaps[1]), defaultStagger(3), 1e-9),
  );
  check('a stagger of zero is refused rather than obeyed', (() => {
    const zeroed = pinGaps(pin({ stagger: 0 }), layers);
    return closestBetween(zeroed[0], zeroed[1]) > 1e-6;
  })());
  check('a stagger that is asked for is used', (() => {
    const turned = pinGaps(pin({ count: 4, stagger: 15 }), layers);
    return near(closestBetween(turned[0], turned[1]), 15, 1e-9);
  })());

  // With more pins the positions are closer together, so the furthest apart
  // consecutive gaps can be is smaller.
  check('more pins leave less room to turn', defaultStagger(6) < defaultStagger(3));
}

console.log('pins: every sheet held on both sides');
{
  const pin = { id: 'p', label: 'Pins', count: 3, diameter: 4, radius: 40, angle: 0, stagger: 0, x: 0, y: 0, kerf: 0.2 };
  const gaps = pinGaps(pin, [1, 2, 3, 4, 5, 6]);

  /*
   * A pattern of holes is not a structure. If a gap's pins do not fit the
   * sheets they pass through, those two sheets are not fastened to each other,
   * and a stack that comes apart in the middle is worse than one that was never
   * pinned. So the generator is made to check its own output.
   */
  check('all pinned, nothing loose', loosePins(gaps, [3, 3, 3, 3, 3]).length === 0);
  check(
    'a gap with no pins leaves both its sheets held on one side',
    loosePins(gaps, [3, 3, 0, 3, 3]).join(',') === '3,4',
  );
  check(
    'one pin is enough to fasten a gap',
    loosePins(gaps, [3, 3, 1, 3, 3]).length === 0,
  );
  check(
    'the bottom gap empty leaves the bottom sheet held by nothing',
    loosePins(gaps, [0, 3, 3, 3, 3]).join(',') === '1,2',
  );
  check(
    'the top gap empty is the same at the other end',
    loosePins(gaps, [3, 3, 3, 3, 0]).join(',') === '5,6',
  );
  check('nothing pinned at all names every sheet', loosePins(gaps, [0, 0, 0, 0, 0]).length === 6);

  /*
   * The ends are not complained about for having one neighbour. The lowest
   * sheet has no gap below it and the highest none above, and saying so on
   * every stack would teach somebody to stop reading the warning.
   */
  const two = pinGaps(pin, [1, 2]);
  check('a two-sheet stack pinned once is complete', loosePins(two, [3]).length === 0);
  check('and unpinned names both', loosePins(two, [0]).join(',') === '1,2');
  check('no gaps at all is not a complaint', loosePins([], []).length === 0);
}

console.log('spacers: circle points');
{
  const pts = circlePoints(0, 0, 10);
  check('a circle closes with enough segments', pts.length / 2 >= 24);
  let maxError = 0;
  for (let i = 0; i < pts.length; i += 2) {
    maxError = Math.max(maxError, Math.abs(Math.hypot(pts[i], pts[i + 1]) - 10));
  }
  check('vertices sit on the circle', maxError < 1e-9);

  // Chord sag must stay under the tolerance, which is what segment count is for.
  const n = pts.length / 2;
  const sag = 10 * (1 - Math.cos(Math.PI / n));
  check('chord sag is within tolerance', sag <= 0.02 + 1e-9, `${sag.toFixed(5)} mm`);
  check('a tiny radius does not explode the segment count', circlePoints(0, 0, 0.01).length / 2 < 200);
}

console.log('nest: label placement');
{
  const annulus = {
    id: 'p1',
    label: 'L07',
    kind: 'slice',
    outer: ring(0, 0, 60),
    holes: [ring(0, 0, 35)],
    circles: [],
  };

  const spot = findLabelSpot(annulus, 12, 4);
  check('a label finds the ring band', spot !== null);
  if (spot) {
    const r = Math.hypot(spot[0] + 6, spot[1] + 2);
    check('and it is not in the central hole', r > 35, `radius ${r.toFixed(1)} mm`);
    check('and not off the outside either', r < 60);
  }

  const tightRing = {
    id: 'p2',
    label: 'L08',
    kind: 'slice',
    outer: ring(0, 0, 40),
    holes: [ring(0, 0, 39)],
    circles: [],
  };
  check('a 1 mm band has nowhere for a 4 mm label', findLabelSpot(tightRing, 12, 4) === null);

  const withRodHole = {
    id: 'p3',
    label: 'L09',
    kind: 'slice',
    outer: ring(0, 0, 40),
    holes: [],
    circles: [{ x: 0, y: 0, r: 30 }],
  };
  const avoided = findLabelSpot(withRodHole, 10, 4);
  check('a label avoids a circular hole', avoided !== null && Math.hypot(avoided[0] + 5, avoided[1] + 2) > 30);

  const disc = { id: 'p4', label: '1', kind: 'slice', outer: ring(0, 0, 50), holes: [], circles: [] };
  const centred = findLabelSpot(disc, 4, 4);
  check('on a plain disc the label lands near the centre', centred !== null && Math.hypot(centred[0], centred[1]) < 12);
}

console.log('nest: bounds follow what is actually cut');
{
  const r = 7;
  const ringPart = {
    id: 's1',
    label: 'M5',
    kind: 'spacer',
    outer: circlePoints(0, 0, r),
    outerCircle: { x: 0, y: 0, r },
    holes: [],
    circles: [{ x: 0, y: 0, r: 2.5 }],
  };

  const box = boundsOf(ringPart);
  check('a circular part is bounded by its circle', near(box.maxX - box.minX, 2 * r, 1e-12));

  // The stand-in polygon is inscribed, so its bounding box is never larger
  // than the circle's and in at least one axis is strictly smaller — vertices
  // land on the circle, but the extremes between them fall short. Bounding by
  // the polygon would let the exported CIRCLE overhang the sheet by that much.
  const pts = ringPart.outer;
  let pMinX = Infinity;
  let pMaxX = -Infinity;
  let pMinY = Infinity;
  let pMaxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    pMinX = Math.min(pMinX, pts[i]);
    pMaxX = Math.max(pMaxX, pts[i]);
    pMinY = Math.min(pMinY, pts[i + 1]);
    pMaxY = Math.max(pMaxY, pts[i + 1]);
  }
  check(
    'the polygon never reaches outside the circle',
    pMinX >= -r - 1e-9 && pMaxX <= r + 1e-9 && pMinY >= -r - 1e-9 && pMaxY <= r + 1e-9,
  );
  check(
    'and falls short of it in at least one axis',
    pMaxX - pMinX < 2 * r - 1e-9 || pMaxY - pMinY < 2 * r - 1e-9,
    `polygon ${(pMaxX - pMinX).toFixed(5)} x ${(pMaxY - pMinY).toFixed(5)}, circle ${(2 * r).toFixed(5)}`,
  );

  const nested = nestParts([ringPart], {
    sheetWidth: 2 * r,
    sheetHeight: 2 * r,
    gap: 0,
    labelHeight: 0,
  });
  check('a circular part exactly the size of the sheet still fits', nested.sheets.length === 1);
  const placed = nested.sheets[0].parts[0];
  check(
    'and its true circle lands inside the sheet',
    placed.outerCircle.x + placed.dx - r >= -1e-9 &&
      placed.outerCircle.x + placed.dx + r <= 2 * r + 1e-9,
  );
}

console.log('nest: shelf packing');
{
  const options = { sheetWidth: 720, sheetHeight: 400, gap: 4, labelHeight: 4 };

  const parts = [];
  for (let i = 0; i < 12; i++) {
    parts.push({
      id: `p${i}`,
      label: `L${String(i + 1).padStart(2, '0')}`,
      kind: 'slice',
      outer: ring(0, 0, 60 - i * 2),
      holes: [ring(0, 0, 30 - i)],
      circles: [],
      layer: i + 1,
    });
  }

  const result = nestParts(parts, options);
  check('everything is placed', result.unplaced.length === 0);
  check('all parts are accounted for', countParts(result.sheets) === parts.length);
  check('twelve small rings fit on one sheet', result.sheets.length === 1, `${result.sheets.length} sheets`);

  const sheet = result.sheets[0];
  for (const part of sheet.parts) {
    const box = boundsOf(part);
    const x0 = box.minX + part.dx;
    const y0 = box.minY + part.dy;
    const x1 = box.maxX + part.dx;
    const y1 = box.maxY + part.dy;
    check(
      `${part.label} sits inside the sheet`,
      x0 >= -1e-9 && y0 >= -1e-9 && x1 <= options.sheetWidth + 1e-9 && y1 <= options.sheetHeight + 1e-9,
    );
  }

  // No two bounding boxes may overlap, allowing for the gap.
  let overlaps = 0;
  for (let i = 0; i < sheet.parts.length; i++) {
    for (let j = i + 1; j < sheet.parts.length; j++) {
      const a = sheet.parts[i];
      const b = sheet.parts[j];
      const ax0 = a.bbox.minX + a.dx;
      const ax1 = a.bbox.maxX + a.dx;
      const ay0 = a.bbox.minY + a.dy;
      const ay1 = a.bbox.maxY + a.dy;
      const bx0 = b.bbox.minX + b.dx;
      const bx1 = b.bbox.maxX + b.dx;
      const by0 = b.bbox.minY + b.dy;
      const by1 = b.bbox.maxY + b.dy;
      const separated =
        ax1 <= bx0 + 1e-9 || bx1 <= ax0 + 1e-9 || ay1 <= by0 + 1e-9 || by1 <= ay0 + 1e-9;
      if (!separated) overlaps++;
    }
  }
  check('no two parts overlap', overlaps === 0, `${overlaps} overlapping pairs`);

  check('every part got a label spot', sheet.parts.every((p) => p.labelAt !== null));
  check('fill is reported and sane', sheet.fill > 0 && sheet.fill <= 1);

  const many = [];
  for (let i = 0; i < 60; i++) {
    many.push({ id: `q${i}`, label: `${i}`, kind: 'slice', outer: ring(0, 0, 90), holes: [], circles: [] });
  }
  const spread = nestParts(many, options);
  check('a big job spills onto several sheets', spread.sheets.length > 1, `${spread.sheets.length} sheets`);
  check('and still places everything', spread.unplaced.length === 0 && countParts(spread.sheets) === 60);
  check('sheets are numbered from one', spread.sheets.every((s, i) => s.index === i + 1));

  const oversized = nestParts(
    [{ id: 'huge', label: 'X', kind: 'slice', outer: rect(0, 0, 900, 100), holes: [], circles: [] }],
    options,
  );
  check('a part too big for the bed is reported, not silently dropped', oversized.unplaced.length === 1);
  check('and it does not create an empty sheet', oversized.sheets.length === 0);

  const empty = nestParts([], options);
  check('an empty job nests to nothing', empty.sheets.length === 0 && empty.unplaced.length === 0);

  const runA = nestParts(parts, options);
  const runB = nestParts(parts, options);
  check(
    'nesting is deterministic',
    JSON.stringify(runA.sheets.map((s) => s.parts.map((p) => [p.id, p.dx, p.dy]))) ===
      JSON.stringify(runB.sheets.map((s) => s.parts.map((p) => [p.id, p.dx, p.dy]))),
  );

  const noGap = nestParts(parts, { ...options, gap: 0 });
  const wideGap = nestParts(parts, { ...options, gap: 40 });
  check(
    'a wider part gap uses at least as much room',
    wideGap.sheets.length >= noGap.sheets.length,
  );
}

console.log('nest: manual placement');
{
  const options = { sheetWidth: 400, sheetHeight: 300, gap: 4, labelHeight: 0 };
  const parts = [0, 1, 2].map((i) => ({
    id: `m${i}`,
    label: `L${i}`,
    kind: 'slice',
    outer: ring(0, 0, 40),
    holes: [],
    circles: [],
  }));

  const auto = nestParts(parts, options);
  check('three parts nest onto one sheet', auto.sheets.length === 1);

  const untouched = applyPlacements(auto, {});
  check('no placements leaves the layout alone', untouched === auto);

  const moved = applyPlacements(auto, { m1: { sheet: 1, dx: 200, dy: 200 } });
  const target = moved.sheets[0].parts.find((p) => p.id === 'm1');
  check('a placed part moves where it was put', target.dx === 200 && target.dy === 200);
  check('and is marked pinned', target.pinned === true);
  check('its neighbours are not pinned', moved.sheets[0].parts.filter((p) => p.pinned).length === 1);
  check('part count is unchanged', countParts(moved.sheets) === 3);

  const twoSheets = nestParts(
    [0, 1, 2, 3, 4, 5].map((i) => ({
      id: `n${i}`,
      label: `${i}`,
      kind: 'slice',
      outer: ring(0, 0, 90),
      holes: [],
      circles: [],
    })),
    options,
  );
  check('six large parts need more than one sheet', twoSheets.sheets.length > 1);

  const shifted = applyPlacements(twoSheets, { n0: { sheet: 2, dx: 100, dy: 100 } });
  check(
    'a part can be moved to another sheet',
    shifted.sheets[1].parts.some((p) => p.id === 'n0') &&
      !shifted.sheets[0].parts.some((p) => p.id === 'n0'),
  );
  check('and nothing is lost in the move', countParts(shifted.sheets) === 6);

  const clamped = applyPlacements(twoSheets, { n0: { sheet: 99, dx: 0, dy: 0 } });
  check(
    'a placement naming a sheet that does not exist is clamped, not dropped',
    countParts(clamped.sheets) === 6 &&
      clamped.sheets[clamped.sheets.length - 1].parts.some((p) => p.id === 'n0'),
  );

  check('fill is recomputed after moving parts', moved.sheets[0].fill > 0 && moved.sheets[0].fill <= 1);
}

console.log('nest: overlap detection');
{
  const options = { sheetWidth: 400, sheetHeight: 300, gap: 4, labelHeight: 0 };
  const parts = [0, 1].map((i) => ({
    id: `o${i}`,
    label: `${i}`,
    kind: 'slice',
    outer: ring(0, 0, 40),
    holes: [],
    circles: [],
  }));
  const auto = nestParts(parts, options);
  check('an automatic layout has no overlaps', findOverlaps(auto.sheets[0]).length === 0);

  const stacked = applyPlacements(auto, {
    o0: { sheet: 1, dx: 40, dy: 40 },
    o1: { sheet: 1, dx: 45, dy: 40 },
  });
  const hits = findOverlaps(stacked.sheets[0]);
  check('two parts placed on top of each other are flagged', hits.length === 2);
  check('and both ids are named', hits.includes('o0') && hits.includes('o1'));

  const apart = applyPlacements(auto, {
    o0: { sheet: 1, dx: 40, dy: 40 },
    o1: { sheet: 1, dx: 300, dy: 40 },
  });
  check('parts moved clear of each other are not flagged', findOverlaps(apart.sheets[0]).length === 0);

  const touching = applyPlacements(auto, {
    o0: { sheet: 1, dx: 40, dy: 40 },
    o1: { sheet: 1, dx: 120, dy: 40 },
  });
  check('boxes that exactly touch are not an overlap', findOverlaps(touching.sheets[0]).length === 0);
}

console.log('nest: true-shape collision');
{
  const options = { sheetWidth: 400, sheetHeight: 300, gap: 4, labelHeight: 0 };

  // An L-shaped part and a square nested into its notch. Exact geometry, so
  // the measured gap is a number the test can assert on. This is the crescent
  // case from a real sheet: the bounding boxes overlap completely, the material
  // never touches, and nesting one into the other is good practice.
  const ell = {
    id: 'cA',
    label: 'A',
    kind: 'slice',
    outer: [0, 0, 40, 0, 40, 10, 10, 10, 10, 40, 0, 40],
    holes: [],
    circles: [],
  };
  const block = {
    id: 'cB',
    label: 'B',
    kind: 'slice',
    outer: [0, 0, 26, 0, 26, 26, 0, 26],
    holes: [],
    circles: [],
  };

  const auto = nestParts([ell, block], options);

  // The square sits in the L's notch with 2 mm all round.
  const nestedIn = applyPlacements(auto, {
    cA: { sheet: 1, dx: 100, dy: 100 },
    cB: { sheet: 1, dx: 112, dy: 112 },
  });
  const sheet = nestedIn.sheets[0];

  check(
    'the bounding-box check flags the nested pair',
    findOverlaps(sheet).length === 2,
    'boxes overlap completely, which is exactly why the box check is not enough',
  );

  const report = analyseSheet(sheet, 0);
  check(
    'the true-shape check does not, because the material never touches',
    report.colliding.length === 0,
    `closest ${report.closest.toFixed(3)} mm`,
  );
  check(
    'and it measures the real gap',
    Math.abs(report.closest - 2) < 1e-6,
    `got ${report.closest.toFixed(4)} mm, expected 2`,
  );
  check(
    'a 4 mm clearance requirement flags the same pair as tight',
    analyseSheet(sheet, 4).tight.length === 2,
  );

  const stacked = applyPlacements(auto, {
    cA: { sheet: 1, dx: 100, dy: 100 },
    cB: { sheet: 1, dx: 100, dy: 100 },
  });
  const crash = analyseSheet(stacked.sheets[0], 0);
  check('two parts genuinely on top of each other collide', crash.colliding.length === 2);
  check('a colliding pair reports zero distance', crash.pairs[0].distance === 0 && crash.pairs[0].colliding);

  const clear = applyPlacements(auto, {
    cA: { sheet: 1, dx: 60, dy: 150 },
    cB: { sheet: 1, dx: 330, dy: 150 },
  });
  const fine = analyseSheet(clear.sheets[0], 4);
  check('parts on opposite ends of the sheet are neither colliding nor tight', fine.colliding.length === 0 && fine.tight.length === 0);
  check('and no pairs are worth reporting', fine.pairs.length === 0);

  // Clearance: two discs 2 mm apart, with a 4 mm requirement.
  const discs = [0, 1].map((i) => ({
    id: `d${i}`,
    label: `${i}`,
    kind: 'slice',
    outer: ring(0, 0, 20),
    holes: [],
    circles: [],
  }));
  const discAuto = nestParts(discs, options);
  const near2 = applyPlacements(discAuto, {
    d0: { sheet: 1, dx: 100, dy: 150 },
    d1: { sheet: 1, dx: 142, dy: 150 },
  });
  const tightReport = analyseSheet(near2.sheets[0], 4);
  check('discs 2 mm apart are not colliding', tightReport.colliding.length === 0);
  check('but they are flagged as tight against a 4 mm clearance', tightReport.tight.length === 2);
  check(
    'and the measured gap is about 2 mm',
    Math.abs(tightReport.closest - 2) < 0.2,
    `got ${tightReport.closest.toFixed(3)} mm`,
  );
  check(
    'with no clearance required they pass',
    analyseSheet(near2.sheets[0], 0).tight.length === 0,
  );

  // A small part sitting inside a ring's hole is fine, not a collision.
  const bigRing = {
    id: 'ring',
    label: 'R',
    kind: 'slice',
    outer: ring(0, 0, 60),
    holes: [ring(0, 0, 40)],
    circles: [],
  };
  const tiny = { id: 'tiny', label: 'T', kind: 'slice', outer: ring(0, 0, 15), holes: [], circles: [] };
  const inWaste = applyPlacements(nestParts([bigRing, tiny], options), {
    ring: { sheet: 1, dx: 150, dy: 150 },
    tiny: { sheet: 1, dx: 150, dy: 150 },
  });
  const wasteReport = analyseSheet(inWaste.sheets[0], 0);
  check(
    'a small part inside a ring hole is not a collision',
    wasteReport.colliding.length === 0,
    `closest ${wasteReport.closest.toFixed(2)} mm`,
  );

  const onTop = applyPlacements(nestParts([bigRing, tiny], options), {
    ring: { sheet: 1, dx: 150, dy: 150 },
    tiny: { sheet: 1, dx: 150 + 50, dy: 150 },
  });
  check(
    'but a small part sitting on the ring band is',
    analyseSheet(onTop.sheets[0], 0).colliding.length === 2,
  );
}

console.log('nest: rotation');
{
  const bar = {
    id: 'bar',
    label: 'B',
    kind: 'slice',
    outer: [0, 0, 40, 0, 40, 10, 0, 10],
    holes: [],
    circles: [{ x: 5, y: 5, r: 2 }],
  };

  check('zero rotation returns the part untouched', rotatePart(bar, 0) === bar);

  const turned = rotatePart(bar, 90);
  const box = boundsOf(turned);
  check(
    'a 40 x 10 bar turned 90 degrees is 10 x 40',
    Math.abs(box.maxX - box.minX - 10) < 1e-9 && Math.abs(box.maxY - box.minY - 40) < 1e-9,
    `${(box.maxX - box.minX).toFixed(3)} x ${(box.maxY - box.minY).toFixed(3)}`,
  );

  const before = boundsOf(bar);
  check(
    'it turns about its own centre',
    Math.abs((box.minX + box.maxX) / 2 - (before.minX + before.maxX) / 2) < 1e-9 &&
      Math.abs((box.minY + box.maxY) / 2 - (before.minY + before.maxY) / 2) < 1e-9,
  );

  const area = (pts) => {
    let sum = 0;
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      sum += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
    }
    return sum / 2;
  };
  check('area is preserved', Math.abs(area(turned.outer) - area(bar.outer)) < 1e-9);
  check('orientation is preserved', Math.sign(area(turned.outer)) === Math.sign(area(bar.outer)));

  check('holes and circles come along', turned.circles.length === 1);
  const c = turned.circles[0];
  check('a circle keeps its radius', Math.abs(c.r - 2) < 1e-12);
  check(
    'and moves with the part',
    Math.abs(c.x - 5) > 1e-6 || Math.abs(c.y - 5) > 1e-6,
  );

  const round = rotatePart(rotatePart(bar, 90), -90);
  let worst = 0;
  for (let i = 0; i < bar.outer.length; i++) {
    worst = Math.max(worst, Math.abs(round.outer[i] - bar.outer[i]));
  }
  check('rotating there and back returns the original', worst < 1e-9, `off by ${worst.toExponential(2)}`);

  const spacer = {
    id: 'sp',
    label: 'M5',
    kind: 'spacer',
    outer: ring(0, 0, 8),
    outerCircle: { x: 0, y: 0, r: 8 },
    holes: [],
    circles: [{ x: 0, y: 0, r: 2.5 }],
  };
  const spun = rotatePart(spacer, 37);
  check('a concentric ring is unmoved by rotation', Math.hypot(spun.outerCircle.x, spun.outerCircle.y) < 1e-9);
  check('and keeps its exact circle', Math.abs(spun.outerCircle.r - 8) < 1e-12);
}

console.log('nest: rotation through placement');
{
  const options = { sheetWidth: 400, sheetHeight: 300, gap: 4, labelHeight: 4 };
  const bar = {
    id: 'r1',
    label: 'L01',
    kind: 'slice',
    outer: [0, 0, 120, 0, 120, 40, 0, 40],
    holes: [],
    circles: [],
  };
  const auto = nestParts([bar], options);
  check('the bar nests', auto.sheets.length === 1);
  check('and gets a label', auto.sheets[0].parts[0].labelAt !== null);

  const upright = applyPlacements(auto, { r1: { sheet: 1, dx: 60, dy: 60, rot: 90 } }, {
    width: options.sheetWidth,
    height: options.sheetHeight,
  });
  const part = upright.sheets[0].parts[0];
  check('the placed part records its rotation', part.rot === 90);
  check(
    'its bounding box is the rotated one',
    Math.abs(part.bbox.maxX - part.bbox.minX - 40) < 1e-9,
    `${(part.bbox.maxX - part.bbox.minX).toFixed(2)} wide`,
  );
  check('it still has a label spot on the turned material', part.labelAt !== null);

  const labelBox = {
    minX: part.labelAt[0],
    minY: part.labelAt[1],
    maxX: part.labelAt[0] + estimateLabelWidth(part.label, part.labelHeight),
    maxY: part.labelAt[1] + part.labelHeight,
  };
  check(
    'and the label sits inside the rotated bounds',
    labelBox.minX >= part.bbox.minX - 1e-6 &&
      labelBox.maxX <= part.bbox.maxX + 1e-6 &&
      labelBox.minY >= part.bbox.minY - 1e-6 &&
      labelBox.maxY <= part.bbox.maxY + 1e-6,
  );

  const pushed = applyPlacements(auto, { r1: { sheet: 1, dx: 5000, dy: 5000, rot: 45 } }, {
    width: options.sheetWidth,
    height: options.sheetHeight,
  });
  const clamped = placedBox(pushed.sheets[0].parts[0]);
  check(
    'a rotated part is clamped to the sheet, using its rotated size',
    clamped.maxX <= options.sheetWidth + 1e-9 && clamped.maxY <= options.sheetHeight + 1e-9,
  );
  check(
    'and is not pushed off the near edge either',
    clamped.minX >= -1e-9 && clamped.minY >= -1e-9,
  );
}

console.log('nest: the rotation pivot holds still');
{
  const options = { sheetWidth: 400, sheetHeight: 300, gap: 4, labelHeight: 0 };
  // A deliberately lopsided part: its bounding box centre moves under
  // rotation, so a handle hung off the box would drift away from it.
  const wedge = {
    id: 'w',
    label: 'W',
    kind: 'slice',
    outer: [0, 0, 120, 0, 120, 20, 60, 60, 0, 20],
    holes: [],
    circles: [],
  };
  const auto = nestParts([wedge], options);
  const before = auto.sheets[0].parts[0];

  check('an unrotated part has a pivot at its box centre', 
    Math.abs(before.pivot[0] - (before.bbox.minX + before.bbox.maxX) / 2) < 1e-9 &&
    Math.abs(before.pivot[1] - (before.bbox.minY + before.bbox.maxY) / 2) < 1e-9);

  const size = { width: options.sheetWidth, height: options.sheetHeight };
  const turned = applyPlacements(auto, { w: { sheet: 1, dx: 100, dy: 100, rot: 40 } }, size);
  const after = turned.sheets[0].parts[0];

  check('the pivot survives rotation unchanged',
    after.pivot[0] === before.pivot[0] && after.pivot[1] === before.pivot[1]);

  check(
    'and the rotated box centre really has moved away from it, which is why',
    Math.abs(after.pivot[0] - (after.bbox.minX + after.bbox.maxX) / 2) > 1e-6 ||
      Math.abs(after.pivot[1] - (after.bbox.minY + after.bbox.maxY) / 2) > 1e-6,
  );

  // Turning twice must equal turning once by the sum, or repeated drags creep.
  const once = applyPlacements(auto, { w: { sheet: 1, dx: 100, dy: 100, rot: 80 } }, size)
    .sheets[0].parts[0];
  const twice = applyPlacements(
    applyPlacements(auto, { w: { sheet: 1, dx: 100, dy: 100, rot: 40 } }, size),
    { w: { sheet: 1, dx: 100, dy: 100, rot: 80 } },
    size,
  ).sheets[0].parts[0];
  let worst = 0;
  for (let i = 0; i < once.outer.length; i++) {
    worst = Math.max(worst, Math.abs(once.outer[i] - twice.outer[i]));
  }
  check(
    'rotation is applied to the original geometry, so repeated turns do not creep',
    worst < 1e-9,
    `off by ${worst.toExponential(2)}`,
  );
}

console.log('nest: scattered rotations');
{
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const first = scatterRotations(ids, 1);
  const again = scatterRotations(ids, 1);
  check('the same seed gives the same angles', JSON.stringify(first) === JSON.stringify(again));

  const other = scatterRotations(ids, 2);
  check('a different seed gives different angles', JSON.stringify(first) !== JSON.stringify(other));

  check('every part gets an angle', ids.every((id) => typeof first[id] === 'number'));
  check('angles stay within range', ids.every((id) => Math.abs(first[id]) <= 180));

  const limited = scatterRotations(ids, 1, 20);
  check('a smaller limit is respected', ids.every((id) => Math.abs(limited[id]) <= 20));

  const spread = new Set(ids.map((id) => first[id]));
  check('angles actually differ from each other', spread.size === ids.length);

  const grown = scatterRotations([...ids, 'f'], 1);
  check(
    'adding a part at the end does not reshuffle the others',
    ids.every((id) => grown[id] === first[id]),
  );
}

console.log('nest: clamping and hit testing');
{
  const options = { sheetWidth: 400, sheetHeight: 300, gap: 4, labelHeight: 0 };
  const annulus = {
    id: 'h1',
    label: 'L1',
    kind: 'slice',
    outer: ring(0, 0, 60),
    holes: [ring(0, 0, 35)],
    circles: [],
  };
  const small = {
    id: 'h2',
    label: 'L2',
    kind: 'slice',
    outer: ring(0, 0, 10),
    holes: [],
    circles: [],
  };

  const auto = nestParts([annulus, small], options);
  const part = auto.sheets[0].parts.find((p) => p.id === 'h1');

  // dx is a translation, not a position: the ring's box starts at -60, so a
  // translation below 60 would push its left edge off the sheet.
  const [insideX, insideY] = clampPlacement(part, 70, 80, options.sheetWidth, options.sheetHeight);
  check('a placement fully inside the sheet is left alone', insideX === 70 && insideY === 80);
  const [tooSmallX] = clampPlacement(part, 10, 80, options.sheetWidth, options.sheetHeight);
  check(
    'a translation that would hang the part off the edge is pulled back',
    tooSmallX === 60,
    `got ${tooSmallX}`,
  );

  const [pushedX, pushedY] = clampPlacement(part, -500, -500, options.sheetWidth, options.sheetHeight);
  const pushed = { ...part, dx: pushedX, dy: pushedY };
  const box = placedBox(pushed);
  check('dragging off the left edge clamps to it', box.minX >= -1e-9 && box.minY >= -1e-9);

  const [farX, farY] = clampPlacement(part, 5000, 5000, options.sheetWidth, options.sheetHeight);
  const far = placedBox({ ...part, dx: farX, dy: farY });
  check(
    'dragging off the far edge clamps to it',
    far.maxX <= options.sheetWidth + 1e-9 && far.maxY <= options.sheetHeight + 1e-9,
  );

  const centred = applyPlacements(auto, {
    h1: { sheet: 1, dx: 200, dy: 150 },
    h2: { sheet: 1, dx: 200, dy: 150 },
  });
  const sheet = centred.sheets[0];

  check('a click on the ring band hits the ring', partAt(sheet, 200 + 47, 150).id === 'h1');
  check(
    'a click in the middle hits the small part sitting in the waste, not the ring',
    partAt(sheet, 200, 150).id === 'h2',
  );
  check('a click on empty sheet hits nothing', partAt(sheet, 5, 5) === null);
}

console.log('nest: materials never share a sheet');
{
  const options = { sheetWidth: 400, sheetHeight: 300, gap: 4, labelHeight: 0 };
  const parts = [
    { id: 'a', label: 'A', kind: 'slice', material: 'stock', outer: ring(0, 0, 40), holes: [], circles: [] },
    { id: 'b', label: 'B', kind: 'slice', material: 'stock', outer: ring(0, 0, 40), holes: [], circles: [] },
    { id: 'w', label: 'W', kind: 'window', material: 'window', outer: ring(0, 0, 20), holes: [], circles: [] },
  ];

  const nested = nestByMaterial(parts, options);
  check('two materials give two sheets', nested.sheets.length === 2, `${nested.sheets.length}`);
  check('nothing is lost', countParts(nested.sheets) === 3);
  check(
    'no sheet mixes materials',
    nested.sheets.every((sheet) =>
      sheet.parts.every((part) => (part.material ?? 'stock') === sheet.material),
    ),
  );
  check('sheets are indexed globally', nested.sheets.map((s2) => s2.index).join(',') === '1,2');
  check(
    'and numbered from one within their own material',
    nested.sheets.every((s2) => s2.ordinal === 1),
  );

  const single = nestByMaterial(
    parts.filter((p) => p.material === 'stock'),
    options,
  );
  check('one material behaves as before', single.sheets.length === 1 && single.sheets[0].material === 'stock');

  const untagged = nestByMaterial(
    [{ id: 'u', label: 'U', kind: 'slice', outer: ring(0, 0, 30), holes: [], circles: [] }],
    options,
  );
  check('an untagged part counts as stock', untagged.sheets[0].material === 'stock');

  const runA = nestByMaterial(parts, options);
  const runB = nestByMaterial([...parts].reverse(), options);
  check(
    'material order does not depend on part order',
    runA.sheets.map((s2) => s2.material).join(',') === runB.sheets.map((s2) => s2.material).join(','),
  );

  const moved = applyPlacements(nested, { w: { sheet: 2, dx: 40, dy: 40 } }, {
    width: options.sheetWidth,
    height: options.sheetHeight,
  });
  check(
    'placements keep the sheet material',
    moved.sheets.every((sheet) =>
      sheet.parts.every((part) => (part.material ?? 'stock') === sheet.material),
    ),
  );
}

console.log('nest: material area');
{
  const solid = { id: 'a', label: 'A', kind: 'slice', outer: ring(0, 0, 50), holes: [], circles: [] };
  check('a disc reports its area', Math.abs(partArea(solid) - Math.PI * 2500) / (Math.PI * 2500) < 0.01);

  const annulus = {
    id: 'b', label: 'B', kind: 'slice',
    outer: ring(0, 0, 50), holes: [ring(0, 0, 40).slice().reverse()], circles: [],
  };
  const expected = Math.PI * (2500 - 1600);
  check('a ring reports the band, not the disc',
    Math.abs(partArea(annulus) - expected) / expected < 0.02,
    `${partArea(annulus).toFixed(0)} against ${expected.toFixed(0)}`);
  check('a hole cannot make the area negative', partArea({
    id: 'c', label: 'C', kind: 'slice', outer: ring(0, 0, 10), holes: [ring(0, 0, 40)], circles: [],
  }) === 0);
}

console.log('nest: rasterising a part');
{
  const annulus = {
    id: 'r', label: 'R', kind: 'slice',
    outer: ring(0, 0, 50), holes: [ring(0, 0, 30).slice().reverse()], circles: [],
  };

  const raster = rasterisePart(annulus, 2, 0);
  const solidAt = (x, y) => {
    const i = Math.floor((x - raster.originX) / 2);
    const j = Math.floor((y - raster.originY) / 2);
    if (i < 0 || j < 0 || i >= raster.w || j >= raster.h) return false;
    return raster.cells.includes(i + j * raster.w);
  };

  check('the band is solid', solidAt(40, 0) && solidAt(-40, 0) && solidAt(0, 40));
  check('the hole is free — which is the whole point', !solidAt(0, 0));
  check('and so is the corner outside the circle', !solidAt(48, 48));
  check('the raster covers the part', raster.w * 2 >= 100 && raster.h * 2 >= 100);
  check('and it found some material', raster.cells.length > 100);

  // The gap is applied by dilating, so a gapped raster must be strictly larger.
  const gapped = rasterisePart(annulus, 2, 8);
  check('a gap makes the raster bigger', gapped.w > raster.w && gapped.h > raster.h);
  check('and marks more cells', gapped.cells.length > raster.cells.length);

  const disc = { id: 'd', label: 'D', kind: 'slice', outer: ring(0, 0, 20), holes: [], circles: [] };
  check('a plain disc has no free centre', rasterisePart(disc, 2, 0).cells.length > 200);
}

console.log('nest: true-shape packing');
{
  const options = { sheetWidth: 700, sheetHeight: 400, gap: 4, labelHeight: 4, cell: 2 };

  // Three big rings and a crowd of small parts: exactly the case bounding boxes
  // cannot handle, because the small parts belong in the rings' holes.
  const parts = [];
  for (let i = 0; i < 3; i++) {
    parts.push({
      id: `ring${i}`, label: `L0${i}`, kind: 'slice',
      outer: ring(0, 0, 105), holes: [ring(0, 0, 92).slice().reverse()], circles: [],
    });
  }
  for (let i = 0; i < 20; i++) {
    parts.push({ id: `sp${i}`, label: 'SP', kind: 'spacer', outer: ring(0, 0, 8), holes: [], circles: [] });
  }

  const boxed = nestParts(parts, options);
  const shaped = nestTrueShape(parts, options);

  check('everything is placed', countParts(shaped.sheets) === parts.length && shaped.unplaced.length === 0);
  check('on no more sheets than bounding boxes needed',
    shaped.sheets.length <= boxed.sheets.length,
    `${shaped.sheets.length} against ${boxed.sheets.length}`);

  // The safety property. If the raster is wrong, parts overlap and the sheet is
  // ruined — this is the check that matters more than any saving.
  let colliding = 0;
  let closest = Infinity;
  for (const sheet of shaped.sheets) {
    const report = analyseSheet(sheet, 0);
    colliding += report.colliding.length;
    closest = Math.min(closest, report.closest);
  }
  check('no part collides with another', colliding === 0, `${colliding} colliding`);
  check('and nothing is closer than the raster can promise',
    closest >= options.gap - options.cell * 2,
    `closest ${closest.toFixed(2)} mm against a ${options.gap} mm gap`);

  const overlaps = shaped.sheets.flatMap((sheet) => findOverlaps(sheet));
  check('bounding boxes DO overlap, which is the saving',
    overlaps.length > 0,
    'small parts sitting inside a ring have boxes inside its box');

  // And they will go inside the holes when there is nowhere easier.
  //
  // A greedy packer fills from the bottom left, so small parts sit beside the
  // rings for as long as open sheet remains — correct, and the reason this needs
  // a sheet with no room to spare to demonstrate anything.
  // A sheet the size of one ring plus its gap. The only free space on it is the
  // hole in the middle, so anything that lands there landed there on purpose.
  const snug = { ...options, sheetWidth: 214, sheetHeight: 214 };
  const tight = nestTrueShape(
    [parts[0], ...parts.filter((p) => p.kind === 'spacer')],
    snug,
  );
  const tightFirst = tight.sheets[0];
  const tightRings = tightFirst.parts.filter((p) => p.kind === 'slice');
  const tightSmalls = tightFirst.parts.filter((p) => p.kind === 'spacer');
  const nested = tightSmalls.filter((sp) =>
    tightRings.some((r) => {
      const cx = sp.dx + (sp.bbox.minX + sp.bbox.maxX) / 2;
      const cy = sp.dy + (sp.bbox.minY + sp.bbox.maxY) / 2;
      const rx = r.dx + (r.bbox.minX + r.bbox.maxX) / 2;
      const ry = r.dy + (r.bbox.minY + r.bbox.maxY) / 2;
      return Math.hypot(cx - rx, cy - ry) < 92;
    }),
  );
  check(
    'with no room to spare, small parts go inside the rings',
    nested.length > 5,
    `${nested.length} of ${tightSmalls.length} on the first sheet are inside a hole`,
  );
  let tightColliding = 0;
  for (const sheet of tight.sheets) tightColliding += analyseSheet(sheet, 0).colliding.length;
  check('and still nothing collides', tightColliding === 0, `${tightColliding} colliding`);

  const first = shaped.sheets[0];
  const rings = first.parts.filter((p) => p.kind === 'slice');
  const smalls = first.parts.filter((p) => p.kind === 'spacer');
  check('the first sheet carries both rings and small parts',
    rings.length > 0 && smalls.length > 0);

  check('fill counts material rather than boxes',
    shaped.sheets.every((sheet) => sheet.fill > 0 && sheet.fill <= 1),
    shaped.sheets.map((sh) => sh.fill.toFixed(3)).join(', '));

  const again = nestTrueShape(parts, options);
  check('packing is deterministic',
    JSON.stringify(again.sheets.map((sh) => sh.parts.map((p) => [p.id, p.dx, p.dy]))) ===
      JSON.stringify(shaped.sheets.map((sh) => sh.parts.map((p) => [p.id, p.dx, p.dy]))));

  const huge = nestTrueShape(
    [{ id: 'big', label: 'B', kind: 'slice', outer: ring(0, 0, 900), holes: [], circles: [] }],
    options,
  );
  check('a part too big for the bed is reported, not squeezed', huge.unplaced.length === 1);
  check('and makes no sheet', huge.sheets.length === 0);

  check('an empty job packs to nothing', nestTrueShape([], options).sheets.length === 0);

  // Enough rings that one sheet cannot hold them, so the cap has something to bite.
  const crowd = [];
  for (let i = 0; i < 12; i++) {
    crowd.push({
      id: `c${i}`, label: `C${i}`, kind: 'slice',
      outer: ring(0, 0, 105), holes: [ring(0, 0, 92).slice().reverse()], circles: [],
    });
  }
  const capped = nestTrueShape(crowd, { ...options, maxSheets: 1 });
  check('a sheet cap is respected', capped.sheets.length === 1);
  check('and the overflow is reported rather than dropped',
    capped.unplaced.length > 0,
    `${capped.unplaced.length} unplaced of ${crowd.length}`);
  check('nothing is lost',
    countParts(capped.sheets) + capped.unplaced.length === crowd.length);

  const viaMaterial = nestByMaterial(parts, { ...options, trueShape: true });
  check('nestByMaterial dispatches to the true-shape packer',
    viaMaterial.sheets.length === shaped.sheets.length);
}

console.log('');
if (failures > 0) {
  console.error(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    font, spacers and nesting');
