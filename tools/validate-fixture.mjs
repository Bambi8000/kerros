#!/usr/bin/env node
/**
 * validate-fixture.mjs
 *
 * The lamp fixtures: socket mount, cable channel, Wago chamber. What matters
 * here is that a hole ends up the size the part in your hand needs, and that a
 * pocket too big for the layer it landed on is reported rather than cut.
 *
 *   node tools/validate-fixture.mjs
 */

import {
  FIXTURE_KINDS,
  FIXTURE_LABELS,
  SOCKET_PRESETS,
  socketDiameter,
  cutRadius,
  fixtureSpansZ,
  fixtureHolesAt,
  fixtureExtent,
  roundedRect,
} from '../src/core/fixture.ts';

import { signedArea, groupContours, polygonFitsInPart, pointInRing } from '../src/core/slice.ts';

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

function fix(overrides = {}) {
  return {
    id: 'x1',
    label: 'Socket',
    kind: 'socket',
    x: 0,
    y: 0,
    z: 10,
    length: 9,
    rot: 0,
    kerf: 0.2,
    preset: 'nipple',
    diameter: 12,
    screws: 0,
    boltCircle: 30,
    screwDiameter: 3.2,
    shape: 'round',
    slotLength: 20,
    width: 30,
    depth: 20,
    corner: 3,
    ...overrides,
  };
}

console.log('fixture: registry and presets');
{
  check('three kinds', FIXTURE_KINDS.length === 3);
  check('each is labelled', FIXTURE_KINDS.every((k) => typeof FIXTURE_LABELS[k] === 'string'));
  check('the nipple preset is an M10 clearance', near(SOCKET_PRESETS.nipple, 10.5, 1e-12));
  check('the body preset is much larger', SOCKET_PRESETS.body > 30);
  check('a known preset wins over the diameter', near(socketDiameter(fix({ preset: 'body', diameter: 5 })), 40.5, 1e-12));
  check('an unknown preset falls back to the diameter', near(socketDiameter(fix({ preset: 'custom', diameter: 17 })), 17, 1e-12));
  check('a nonsense diameter still gives something cuttable', socketDiameter(fix({ preset: 'custom', diameter: 0 })) > 0);
}

console.log('fixture: kerf');
{
  check('a hole is cut half a kerf small', near(cutRadius(10.5, 0.2), 5.15, 1e-12));
  check('zero kerf leaves it nominal', near(cutRadius(10.5, 0), 5.25, 1e-12));
  check('an absurd kerf clamps', cutRadius(1, 8) > 0);
}

console.log('fixture: the band');
{
  const spec = fix({ z: 10, length: 9 });
  check('inside the band', fixtureSpansZ(spec, 10));
  check('at the edges', fixtureSpansZ(spec, 5.5) && fixtureSpansZ(spec, 14.5));
  check('outside it', !fixtureSpansZ(spec, 15));
  check('a band shorter than a pitch reaches one layer', fixtureHolesAt(fix({ z: 10, length: 1 }), 10).circles.length === 1);
  check('and nothing on the next', fixtureHolesAt(fix({ z: 10, length: 1 }), 19).circles.length === 0);
}

console.log('fixture: socket mount');
{
  const plain = fixtureHolesAt(fix({ screws: 0 }), 10);
  check('one hole with no screws', plain.circles.length === 1);
  check('and it is the nipple clearance, kerf-compensated', near(plain.circles[0].r, cutRadius(10.5, 0.2), 1e-12));
  check('no polygons', plain.polygons.length === 0);

  const screwed = fixtureHolesAt(fix({ screws: 4, boltCircle: 30, screwDiameter: 3.2 }), 10);
  check('four screws add four holes', screwed.circles.length === 5);

  const ring30 = screwed.circles.slice(1);
  check(
    'the screws sit on the bolt circle',
    ring30.every((c) => near(Math.hypot(c.x, c.y), 15, 1e-9)),
  );
  check(
    'evenly spaced',
    near(Math.hypot(ring30[0].x - ring30[2].x, ring30[0].y - ring30[2].y), 30, 1e-9),
  );
  check('and are the screw size', ring30.every((c) => near(c.r, cutRadius(3.2, 0.2), 1e-12)));

  const turned = fixtureHolesAt(fix({ screws: 4, rot: 45 }), 10);
  check(
    'rot turns the bolt circle',
    Math.abs(turned.circles[1].x - screwed.circles[1].x) > 1,
  );

  const offset = fixtureHolesAt(fix({ screws: 2, x: 100, y: -50 }), 10);
  check('the whole set follows the position', near(offset.circles[0].x, 100, 1e-12) && near(offset.circles[0].y, -50, 1e-12));
  check(
    'including the screws',
    offset.circles.slice(1).every((c) => near(Math.hypot(c.x - 100, c.y + 50), 15, 1e-9)),
  );

  const bodyMount = fixtureHolesAt(fix({ preset: 'body' }), 10);
  check('the body preset gives a much bigger hole', bodyMount.circles[0].r > 19);
}

console.log('fixture: cable channel');
{
  const round = fixtureHolesAt(fix({ kind: 'cable', label: 'Cable', shape: 'round', diameter: 8 }), 10);
  check('a round channel is a circle', round.circles.length === 1 && round.polygons.length === 0);
  check('at the cable size', near(round.circles[0].r, cutRadius(8, 0.2), 1e-12));

  const slot = fixtureHolesAt(fix({ kind: 'cable', shape: 'slot', diameter: 8, slotLength: 24 }), 10);
  check('a slot is a polygon', slot.polygons.length === 1 && slot.circles.length === 0);
  check('wound as a hole', signedArea(slot.polygons[0]) < 0, `area ${signedArea(slot.polygons[0]).toFixed(1)}`);

  const pts = slot.polygons[0];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    minX = Math.min(minX, pts[i]);
    maxX = Math.max(maxX, pts[i]);
    minY = Math.min(minY, pts[i + 1]);
    maxY = Math.max(maxY, pts[i + 1]);
  }
  check('the slot is cut a kerf narrow', near(maxY - minY, 8 - 0.2, 1e-9), `${(maxY - minY).toFixed(3)} mm`);
  check('and a kerf short', near(maxX - minX, 24 - 0.2, 1e-9));

  const across = fixtureHolesAt(fix({ kind: 'cable', shape: 'slot', diameter: 8, slotLength: 24, rot: 90 }), 10);
  const apts = across.polygons[0];
  let aMinX = Infinity;
  let aMaxX = -Infinity;
  for (let i = 0; i < apts.length; i += 2) {
    aMinX = Math.min(aMinX, apts[i]);
    aMaxX = Math.max(aMaxX, apts[i]);
  }
  check('rot turns the slot', near(aMaxX - aMinX, 8 - 0.2, 1e-6));
}

console.log('fixture: wago chamber');
{
  const pocket = fixtureHolesAt(fix({ kind: 'chamber', label: 'Wago', width: 30, depth: 20, corner: 3 }), 10);
  check('a chamber is one polygon', pocket.polygons.length === 1 && pocket.circles.length === 0);
  check('wound as a hole', signedArea(pocket.polygons[0]) < 0);

  const pts = pocket.polygons[0];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    minX = Math.min(minX, pts[i]);
    maxX = Math.max(maxX, pts[i]);
    minY = Math.min(minY, pts[i + 1]);
    maxY = Math.max(maxY, pts[i + 1]);
  }
  check('cut a kerf under size on both axes', near(maxX - minX, 29.8, 1e-9) && near(maxY - minY, 19.8, 1e-9));
  check('the corners are rounded, not clipped', pts.length / 2 > 8);

  const sharp = fixtureHolesAt(fix({ kind: 'chamber', corner: 0 }), 10);
  check('a zero radius gives four corners', sharp.polygons[0].length / 2 === 4);

  const rect = roundedRect(0, 0, 20, 10, 20, 0);
  check('a radius larger than the box is clamped', Number.isFinite(signedArea(rect)) && signedArea(rect) < 0);
}

console.log('fixture: does it fit the layer it landed on');
{
  const solidDisc = groupContours([{ points: ring(0, 0, 60), area: 1, isHole: false }]);
  const narrowRing = groupContours([
    { points: ring(0, 0, 60), area: 1, isHole: false },
    { points: ring(0, 0, 52).slice().reverse(), area: -1, isHole: true },
  ]);

  const chamber = fixtureHolesAt(fix({ kind: 'chamber', width: 30, depth: 20 }), 10).polygons[0];

  check('a chamber fits a solid disc', polygonFitsInPart(solidDisc[0], chamber, 2));
  check(
    'and does not fit a narrow ring, where there is no material at the centre',
    !polygonFitsInPart(narrowRing[0], chamber, 2),
  );

  const huge = fixtureHolesAt(fix({ kind: 'chamber', width: 200, depth: 200 }), 10).polygons[0];
  check('a chamber bigger than the part does not fit', !polygonFitsInPart(solidDisc[0], huge, 0));

  const offCentre = fixtureHolesAt(fix({ kind: 'chamber', width: 30, depth: 20, x: 55 }), 10).polygons[0];
  check('one hanging over the rim does not fit', !polygonFitsInPart(solidDisc[0], offCentre, 0));

  // The chamber's furthest vertex is about 18 mm from the centre of a 60 mm
  // disc, so it clears the rim by roughly 42 mm. Anything under that passes.
  check('a clearance under the real gap still passes', polygonFitsInPart(solidDisc[0], chamber, 40));
  check('one over it rejects', !polygonFitsInPart(solidDisc[0], chamber, 45));
  check('a degenerate polygon is refused', !polygonFitsInPart(solidDisc[0], [0, 0], 0));

  check('the centre of the disc really is material', pointInRing(solidDisc[0].outer.points, 0, 0));
}

console.log('fixture: extents for warning ahead of time');
{
  check('a socket reports its hole', near(fixtureExtent(fix({ screws: 0 })), 10.5, 1e-12));
  check(
    'with screws it reports the bolt circle plus a screw',
    near(fixtureExtent(fix({ screws: 4, boltCircle: 30, screwDiameter: 3.2 })), 33.2, 1e-12),
  );
  check('a round cable reports its diameter', near(fixtureExtent(fix({ kind: 'cable', shape: 'round', diameter: 8 })), 8, 1e-12));
  check('a slot reports its length', near(fixtureExtent(fix({ kind: 'cable', shape: 'slot', diameter: 8, slotLength: 24 })), 24, 1e-12));
  check('a chamber reports its diagonal', near(fixtureExtent(fix({ kind: 'chamber', width: 30, depth: 40 })), 50, 1e-9));
}

console.log('');
if (failures > 0) {
  console.error(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    fixtures');
