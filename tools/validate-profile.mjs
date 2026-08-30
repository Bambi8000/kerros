#!/usr/bin/env node
/**
 * validate-profile.mjs
 *
 * Imports the REAL src/core/profile2d.ts. An SVG that reads slightly wrong does
 * not look wrong — it looks like a drawing somebody made — so the checks are
 * against shapes whose distances are known exactly.
 *
 *   node tools/validate-profile.mjs
 */

import {
  parseSvg,
  parsePath,
  parseTransform,
  profileDistance,
  profileBounds,
  fitProfile,
  ringArea,
  distanceToRing,
  insideRing,
  indexProfile,
  indexedDistance,
  extrudeProfile,
} from '../src/core/profile2d.ts';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${body}</svg>`;

/** A 160 mm square from (20,20), and a 60 mm square hole in the middle of it. */
const DONUT = svg('<path d="M20,20 H180 V180 H20 Z"/><path d="M70,70 H130 V130 H70 Z"/>');

console.log('profile: rings and distances');
{
  const square = [0, 0, 100, 0, 100, 100, 0, 100];
  check('area is signed, counter-clockwise positive', near(ringArea(square), 10000));
  check('and the other way round is negative', near(ringArea([0, 0, 0, 100, 100, 100, 100, 0]), -10000));

  check('distance to an edge is exact', near(distanceToRing(square, 50, 130), 30));
  check('to a corner too', near(distanceToRing(square, -30, -40), 50));
  check('and from inside it is the nearest edge', near(distanceToRing(square, 10, 50), 10));

  check('a point inside is inside', insideRing(square, 50, 50));
  check('and one outside is not', !insideRing(square, 150, 50));
}

console.log('profile: the two fill rules');
{
  const { rings } = parseSvg(DONUT);
  check('both outlines are read', rings.length === 2, `${rings.length}`);

  const outline = { rings, fill: 'outline' };
  const holes = { rings, fill: 'holes' };

  /*
   * The whole point of having two rules. In the middle of the hole, `outline`
   * says solid — it is 80 mm inside the outer square — and `holes` says empty,
   * 30 mm from the hole's edge.
   */
  check('outline fills the hole', near(profileDistance(outline, 100, -100), -80, 1e-6));
  check('holes leaves it empty', near(profileDistance(holes, 100, -100), 30, 1e-6));
  check('both agree in the wall', near(profileDistance(outline, 40, -100), -20, 1e-6));
  check('and outside', near(profileDistance(holes, 10, -100), 10, 1e-6));

  /*
   * `outline` is not a union of the rings, and this is the check that says so.
   * Unioning would put a zero level on the inner ring — a boundary in the
   * middle of solid material — and the hole's edge would show up as an edge.
   */
  /*
   * `outline` is a union, so the inner ring's boundary is interior to the
   * result and must not read as an edge. Taking the smallest magnitude and
   * signing it separately would put nearly zero here — and a shell believes
   * that and leaves a wall standing along the hole that is not there.
   */
  check(
    'outline has no boundary where the hole was',
    Math.abs(profileDistance(outline, 70, -100)) > 40,
    `${profileDistance(outline, 70, -100).toFixed(2)} on the hole's own edge`,
  );

  // A ring inside a ring inside a ring is solid again under even-odd.
  const nested = parseSvg(
    svg(
      '<path d="M0,0 H200 V200 H0 Z"/><path d="M40,40 H160 V160 H40 Z"/>' +
        '<path d="M80,80 H120 V120 H80 Z"/>',
    ),
  );
  const three = { rings: nested.rings, fill: 'holes' };
  check('even-odd makes the innermost solid again', profileDistance(three, 100, -100) < 0);
  check('and the ring around it a hole', profileDistance(three, 60, -100) > 0);
  /*
   * Three levels deep, which is where the first version went wrong. It kept a
   * ring nested inside an *even* number of others — the even-odd rule under the
   * wrong name — so it dropped the ring at depth 1 and kept the one at depth 2.
   * A shell then followed some of the inner outlines and not others, which
   * reads as a bug in the shell rather than here.
   */
  const outlineOfThree = { rings: nested.rings, fill: 'outline' };
  check('outline ignores the middle ring', profileDistance(outlineOfThree, 60, -100) < 0);
  check('and the innermost one too', profileDistance(outlineOfThree, 100, -100) < 0);
  check(
    'and there is no boundary anywhere inside it',
    (() => {
      // Walk the middle: a solid disc has no sign change until the edge.
      // Zeros are skipped: the walk lands exactly on the boundary at x = 200,
      // and `Math.sign(0)` counted one crossing as two.
      let flips = 0;
      let prev = 0;
      for (let x = 100; x <= 210; x += 1) {
        const sign = Math.sign(profileDistance(outlineOfThree, x, -100));
        if (sign === 0) continue;
        if (prev !== 0 && sign !== prev) flips++;
        prev = sign;
      }
      return flips === 1;
    })(),
  );

  check('an empty profile is far away, not near', profileDistance({ rings: [], fill: 'holes' }, 0, 0) > 1000);
}

console.log('profile: rings that cross rather than nest');
{
  /*
   * The case that showed `outline` was the wrong idea. Eleven circles laid over
   * each other, none inside another — a real drawing, not a contrived one.
   *
   * The first version kept "rings nested inside nothing", which assumed nesting:
   * given crossing rings it kept whichever happened to have their first vertex
   * outside the others and dropped the rest, so parts of the drawing went
   * missing and the outer edge came apart.
   */
  const rings = [];
  for (let c = 0; c < 6; c++) {
    const ring = [];
    const ox = Math.cos((c / 6) * Math.PI * 2) * 25;
    const oy = Math.sin((c / 6) * Math.PI * 2) * 25;
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      ring.push(ox + Math.cos(a) * 50, oy + Math.sin(a) * 50);
    }
    rings.push(ring);
  }

  const union = { rings, fill: 'outline' };
  const evenOdd = { rings, fill: 'holes' };

  const flips = (profile) => {
    let count = 0;
    let prev = 0;
    for (let x = -90; x <= 90; x += 0.5) {
      const sign = Math.sign(profileDistance(profile, x, 0));
      if (sign === 0) continue;
      if (prev !== 0 && sign !== prev) count++;
      prev = sign;
    }
    return count;
  };

  check('the union is one continuous piece', flips(union) === 2, `${flips(union)} sign changes`);
  check('and every ring is still there', profileDistance(union, 70, 0) < 0);
  check('while even-odd alternates, as it should', flips(evenOdd) > 2);

  /*
   * The interior distance is what a shell reads. Deep inside overlapping rings
   * it has to be deep, not "next to the nearest line" — otherwise the shell
   * leaves a wall standing along every ring that crosses the middle.
   */
  /*
   * Derived rather than guessed, which is the rule this project keeps having to
   * relearn: six circles of radius 50 with their centres 25 out, so from the
   * origin the nearest boundary is exactly 25 mm and the union reads −25. The
   * first version asserted "deeper than 30" from nothing at all.
   */
  check(
    'the middle is as deep as the geometry says',
    near(profileDistance(union, 0, 0), -25, 0.5),
    `${profileDistance(union, 0, 0).toFixed(2)} at the centre`,
  );
  check(
    'and not the distance to the nearest line through it',
    profileDistance(union, 0, 0) < -20,
  );
}

console.log('profile: SVG comes in the right way up');
{
  const { rings } = parseSvg(DONUT);
  const box = profileBounds({ rings, fill: 'outline' });

  /*
   * SVG's y axis points down. Flipped once on the way in, or every import is
   * silently mirrored — which looks like a drawing somebody made, not like a
   * bug, and is found after it is cut.
   */
  check('y is flipped, so the SVG top is the largest y', near(box.maxY, -20) && near(box.minY, -180));
  check('x is left alone', near(box.minX, 20) && near(box.maxX, 180));

  const upper = parseSvg(svg('<path d="M0,0 H100 V20 H0 Z"/>'));
  const b = profileBounds({ rings: upper.rings, fill: 'outline' });
  check('a bar at the top of the drawing is at the top of the profile', near(b.maxY, 0) && near(b.minY, -20));
}

console.log('profile: what an SVG can contain');
{
  check('a rect', parseSvg(svg('<rect x="10" y="10" width="30" height="20"/>')).rings.length === 1);
  check('a polygon', parseSvg(svg('<polygon points="0,0 10,0 10,10"/>')).rings.length === 1);
  check('an ellipse', parseSvg(svg('<ellipse cx="50" cy="50" rx="30" ry="10"/>')).rings.length === 1);

  // A circle drawn as an element and the same circle drawn as two arcs must
  // agree, or one of the two readers is wrong.
  const element = parseSvg(svg('<circle cx="100" cy="100" r="50"/>')).rings[0];
  const arcs = parsePath('M50,100 A50,50 0 1 0 150,100 A50,50 0 1 0 50,100 Z')[0];
  const meanRadius = (ring, cy) => {
    let sum = 0;
    for (let i = 0; i < ring.length; i += 2) sum += Math.hypot(ring[i] - 100, ring[i + 1] - cy);
    return sum / (ring.length / 2);
  };
  check('an arc and a circle element agree', near(meanRadius(element, -100), meanRadius(arcs, 100), 1e-3));
  check('and both are the radius asked for', near(meanRadius(arcs, 100), 50, 1e-3));

  const curved = parsePath('M0,0 C0,50 100,50 100,0 Z');
  check('a cubic is flattened', curved[0].length > 20);
  check('and lands on its endpoint', near(curved[0][curved[0].length - 2], 100, 1e-9));

  const quad = parsePath('M0,0 Q50,50 100,0 Z');
  check('a quadratic too', quad[0].length > 20 && near(quad[0][quad[0].length - 2], 100, 1e-9));

  check('relative commands are relative', (() => {
    const abs = parsePath('M10,10 L30,10 L30,30 Z')[0];
    const rel = parsePath('m10,10 l20,0 l0,20 z')[0];
    return abs.length === rel.length && abs.every((v, i) => near(v, rel[i]));
  })());

  const open = parseSvg(svg('<path d="M0,0 L10,0 L10,10"/>'));
  check('an open subpath is dropped', open.rings.length === 0);
  check('and says so rather than vanishing', open.warnings.some((w) => w.includes('open subpath')));

  const text = parseSvg(svg('<text x="0" y="0">L07</text>'));
  check('text is not read', text.rings.length === 0);
  check('and names itself in the warning', text.warnings.some((w) => w.includes('text')));

  check('an empty drawing says so', parseSvg(svg('')).warnings.some((w) => w.includes('No closed outlines')));
}

console.log('profile: transforms');
{
  check('translate', parseTransform('translate(5,6)').join(',') === '1,0,0,1,5,6');
  check('scale', parseTransform('scale(2)').join(',') === '2,0,0,2,0,0');
  check('matrix', parseTransform('matrix(1,2,3,4,5,6)').join(',') === '1,2,3,4,5,6');

  const rot = parseTransform('rotate(90)');
  check('rotate turns x into y', near(rot[0], 0, 1e-9) && near(rot[1], 1, 1e-9));

  /*
   * Transforms compose left to right, and a group's applies to everything
   * inside it. Getting this wrong puts an Inkscape drawing somewhere off the
   * page — visible, but only once it is imported.
   */
  const grouped = parseSvg(
    svg('<g transform="translate(10,20) scale(2)"><rect x="0" y="0" width="10" height="10"/></g>'),
  );
  const xs = grouped.rings[0].filter((_, i) => i % 2 === 0);
  check('a group transform reaches its children', Math.min(...xs) === 10 && Math.max(...xs) === 30);

  const nested = parseSvg(
    svg('<g transform="translate(100,0)"><g transform="translate(10,0)"><rect x="0" y="0" width="10" height="10"/></g></g>'),
  );
  check('and nested groups compose', Math.min(...nested.rings[0].filter((_, i) => i % 2 === 0)) === 110);

  const after = parseSvg(
    svg('<g transform="translate(100,0)"><rect x="0" y="0" width="10" height="10"/></g><rect x="0" y="0" width="10" height="10"/>'),
  );
  check(
    "a group's transform stops at its close",
    Math.min(...after.rings[1].filter((_, i) => i % 2 === 0)) === 0,
  );
}

console.log('profile: sized in millimetres');
{
  const { rings } = parseSvg(DONUT);
  const fitted = fitProfile(rings, 100);
  const box = profileBounds({ rings: fitted, fill: 'outline' });

  /*
   * The same choice mesh import made: a drawing arrives at whatever size the
   * editor left it, and the actual thought is "make this 100 mm across".
   */
  check('the longest axis becomes the size asked for', near(Math.max(box.w, box.h), 100, 1e-9));
  check('and it is centred on the origin', near((box.minX + box.maxX) / 2, 0, 1e-9) && near((box.minY + box.maxY) / 2, 0, 1e-9));
  check('scaling is uniform, so the shape survives', (() => {
    const before = profileBounds({ rings, fill: 'outline' });
    return near(box.w / box.h, before.w / before.h, 1e-9);
  })());
  check('the hole is carried along', fitted.length === 2);
  check('an empty set is not a division by zero', fitProfile([], 100).length === 0);
}

console.log('profile: the index says the same thing, faster');
{
  /*
   * Measured before it was written: the plain walk costs 17 microseconds a
   * sample, which is six seconds for one preview grid, and a real drawing has
   * thousands of segments rather than the two hundred that measured.
   *
   * An index that is subtly wrong is a shape that is subtly wrong, so it is
   * held to the exact walk rather than to a tolerance — everywhere its own
   * contract says it is exact.
   */
  const outline = [];
  for (let i = 0; i < 400; i++) {
    const a = (i / 400) * Math.PI * 2;
    const r = 80 + 25 * Math.sin(a * 7);
    outline.push(100 + r * Math.cos(a), 100 + r * Math.sin(a));
  }
  const wiggly = { rings: [outline], fill: 'outline' };
  const index = indexProfile(wiggly);

  check('the index holds every segment', index.ringOf.length === 400);
  check('and knows how far it is exact', index.reach > 0 && index.reach < 200);

  let worst = 0;
  let signs = 0;
  let compared = 0;
  for (let i = 0; i < 4000; i++) {
    const x = Math.sin(i * 1.7) * 140 + 100;
    const y = Math.cos(i * 2.3) * 140 + 100;
    const exact = profileDistance(wiggly, x, y);
    const fast = indexedDistance(index, x, y);
    if (Math.sign(exact) !== Math.sign(fast)) signs++;
    if (Math.abs(exact) > index.reach) continue;
    worst = Math.max(worst, Math.abs(exact - fast));
    compared++;
  }

  check('within the reach it is the same number', worst < 1e-9, `worst ${worst.toExponential(1)} over ${compared}`);
  check('and the sign is right everywhere, reach or no reach', signs === 0, `${signs} disagreements`);

  /*
   * The bound that ends the search was one ring too generous in the first
   * version — it stopped while a closer segment was still unexamined, and the
   * field came out up to a cell wrong. Five millimetres on a real drawing,
   * which is a shape nobody notices is wrong until it is cut.
   */
  const near0 = indexedDistance(index, 100 + 105, 100);
  check('a point just outside reads a small positive number', near0 > 0 && near0 < index.reach);

  // Beyond the reach the magnitude is clamped, never invented, and never larger
  // than the truth — the same contract a mesh import already carries.
  const far = indexedDistance(index, 600, 600);
  check('far away it clamps', near(far, index.reach, 1e-9), `${far.toFixed(3)}`);
  check('and clamps low, so it never overstates the room', far <= profileDistance(wiggly, 600, 600));
  check('a caller can ask for less', indexedDistance(index, 600, 600, 2) <= 2 + 1e-9);

  // Both rules index, and the hole has to survive it.
  const donutRings = parseSvg(DONUT).rings;
  const holesIndex = indexProfile({ rings: donutRings, fill: 'holes' });
  check('holes indexed leaves the hole empty', indexedDistance(holesIndex, 100, -100) > 0);
  const outlineIndex = indexProfile({ rings: donutRings, fill: 'outline' });
  check('outline indexed fills it', indexedDistance(outlineIndex, 100, -100) < 0);
  /*
   * Every ring is indexed whichever rule is in force — a union needs each ring's
   * own signed distance, so none can be dropped up front. What must not happen
   * is the inner ring reading as an edge.
   */
  check('both rings are indexed', outlineIndex.ringCount === 2);
  check(
    'and the inner one is not an edge',
    Math.abs(indexedDistance(outlineIndex, 70, -100)) > 20,
    `${indexedDistance(outlineIndex, 70, -100).toFixed(2)} on the hole's own outline`,
  );

  check('an empty profile indexes without throwing', indexProfile({ rings: [], fill: 'holes' }).ringOf.length === 0);
  check('and reads as far away', indexedDistance(indexProfile({ rings: [], fill: 'holes' }), 0, 0) > 1000);
}

console.log('profile: extruded');
{
  const square = { rings: [[-50, -50, 50, -50, 50, 50, -50, 50]], fill: 'outline' };
  const index = indexProfile(square);

  check('the middle is the nearest wall', near(extrudeProfile(index, 100, 0, 0, 0, 0), -50, 1e-6));
  check('the top face is the surface', near(extrudeProfile(index, 100, 0, 0, 0, 50), 0, 1e-6));
  check('above it is the height above', near(extrudeProfile(index, 100, 0, 0, 0, 70), 20, 1e-6));
  check('beside it is the distance beside', near(extrudeProfile(index, 100, 0, 70, 0, 0), 20, 1e-6));
  check(
    'and past a corner it is the diagonal',
    near(extrudeProfile(index, 100, 0, 80, 0, 80), Math.hypot(30, 30), 1e-6),
  );

  /*
   * A round takes a radius off every edge, which is the same trick `roundBox`
   * uses — shrink, then offset back out — so the result is still an exact
   * distance field rather than an approximation of one.
   */
  const rounded = extrudeProfile(index, 100, 10, 50, 0, 50);
  check('a rounded edge is outside the sharp one', rounded > extrudeProfile(index, 100, 0, 50, 0, 50));
  check('and the middle is unchanged', near(extrudeProfile(index, 100, 10, 0, 0, 0), -50, 1e-6));
  check('a round larger than the height does not invert it', Number.isFinite(extrudeProfile(index, 4, 40, 0, 0, 0)));

  /*
   * Unit gradient, sampled away from the edges. The extrusion is unioned and
   * blended with the rest of the tree, and a smooth blend only means what it
   * says over a true distance field.
   */
  let worstGradient = 0;
  for (let i = 0; i < 2000; i++) {
    const x = Math.sin(i * 1.1) * 70;
    const y = Math.cos(i * 1.7) * 70;
    const z = Math.sin(i * 2.3) * 70;
    const e = 1e-4;
    const at = (a, b, c) => extrudeProfile(index, 100, 0, a, b, c);
    const g = Math.hypot(
      (at(x + e, y, z) - at(x - e, y, z)) / (2 * e),
      (at(x, y + e, z) - at(x, y - e, z)) / (2 * e),
      (at(x, y, z + e) - at(x, y, z - e)) / (2 * e),
    );
    // Skip the medial axis, where a distance field legitimately has a crease.
    if (Number.isFinite(g) && g > 0.5) worstGradient = Math.max(worstGradient, Math.abs(g - 1));
  }
  check('the gradient is unit where it should be', worstGradient < 0.02, `off by ${worstGradient.toFixed(4)}`);
}

console.log('');
if (failures > 0) {
  console.log(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    profiles');
