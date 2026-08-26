#!/usr/bin/env node
/**
 * validate-legs.mjs
 *
 * Imports the REAL src/core/legs.ts. A leg hole that is wrong does not look
 * wrong — it looks like a slightly oval hole — and the way you find out is that
 * the leg will not go in after everything is cut.
 *
 *   node tools/validate-legs.mjs
 */

import {
  LEG_COUNTS,
  MAX_TILT,
  legSpacing,
  legAzimuths,
  legHole,
  legHoles,
  legSections,
  sectionDistance,
  sectionsDistance,
  convexHull,
} from '../src/core/legs.ts';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const near = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;
const DEG = Math.PI / 180;

const leg = (patch) => ({
  id: 'l',
  label: 'Legs',
  count: 3,
  tilt: 45,
  diameter: 12,
  radius: 60,
  angle: 0,
  x: 0,
  y: 0,
  zRef: 0,
  kerf: 0,
  ...patch,
});

function bounds(points) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    minX = Math.min(minX, points[i]);
    maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]);
    maxY = Math.max(maxY, points[i + 1]);
  }
  return { minX, maxX, minY, maxY };
}

function area(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 2) {
    const j = (i + 2) % points.length;
    sum += points[i] * points[j + 1] - points[j] * points[i + 1];
  }
  return sum / 2;
}

function inRing(points, x, y) {
  let inside = false;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2];
    const yi = points[i * 2 + 1];
    const xj = points[j * 2];
    const yj = points[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

console.log('legs: how many and where they point');
{
  check('six counts offered', LEG_COUNTS.length === 6);
  check('three legs are 120 apart', near(legSpacing(3), 120));
  check('four are 90', near(legSpacing(4), 90));
  check('seven are 51.43', Math.abs(legSpacing(7) - 51.4285714) < 1e-6);
  check('eight are 45', near(legSpacing(8), 45));

  check('azimuths are evenly spaced', legAzimuths(leg({ count: 4 })).join(',') === '0,90,180,270');
  check('and start where the angle says', legAzimuths(leg({ count: 4, angle: 30 })).join(',') === '30,120,210,300');
  check('a fractional count rounds rather than producing NaN', legAzimuths(leg({ count: 3.4 })).length === 3);
  check('a count of zero still gives one leg', legAzimuths(leg({ count: 0 })).length === 1);
}

console.log('legs: the ellipse a tilted cylinder leaves in a plane');
{
  // Zero thickness is the plane on its own, which is the shape a naive
  // implementation would cut. Useful here precisely because it is wrong.
  const flat = legHole(leg({ tilt: 45 }), 0, 0, 0, 720);
  const b = bounds(flat);
  const r = 6;
  const major = r / Math.cos(45 * DEG);

  check('semi-major is r / cos θ along the tilt', near(b.maxX - b.minX, 2 * major, 1e-3), `${(b.maxX - b.minX).toFixed(4)}`);
  check('semi-minor is r across it', near(b.maxY - b.minY, 2 * r, 1e-3), `${(b.maxY - b.minY).toFixed(4)}`);
  check('its area is π·a·b', Math.abs(Math.abs(area(flat)) - Math.PI * major * r) / (Math.PI * major * r) < 1e-3);

  const upright = legHole(leg({ tilt: 0 }), 0, 0, 0, 720);
  const u = bounds(upright);
  check('a vertical leg is a circle', near(u.maxX - u.minX, 12, 1e-3) && near(u.maxY - u.minY, 12, 1e-3));

  const across = legHole(leg({ tilt: 45, angle: 90 }), 90, 0, 0, 720);
  const a90 = bounds(across);
  check(
    'the ellipse turns with the leg, not with the axes',
    near(a90.maxY - a90.minY, 2 * major, 1e-3) && near(a90.maxX - a90.minX, 2 * r, 1e-3),
  );
}

console.log('legs: the sweep through the sheet');
{
  const t = 3;
  const spec = leg({ tilt: 45 });
  const hole = legHole(spec, 0, 0, t, 720);
  const b = bounds(hole);
  const r = 6;
  const major = r / Math.cos(45 * DEG);
  const shift = t * Math.tan(45 * DEG);

  check('the hull is one ellipse longer by the sweep', near(b.maxX - b.minX, 2 * major + shift, 1e-3), `${(b.maxX - b.minX).toFixed(4)}`);
  check('and no wider across it', near(b.maxY - b.minY, 2 * r, 1e-3));
  check(
    'centred between the two faces, not on either',
    near((b.minX + b.maxX) / 2, spec.radius - shift / 2, 1e-3),
  );
  check('wound as a hole', area(hole) < 0);

  /*
   * The reason this module exists.
   *
   * A 45° leg moves a full sheet thickness sideways on its way through 3 mm
   * stock. Cut only the mid-plane ellipse and most of the leg's outline at the
   * top face is outside the hole — the leg does not pass through at all, and
   * you find that out with everything already cut.
   */
  const midOnly = legHole(spec, 0, t / 2, 0, 720);
  const axisAtTop = spec.radius - shift;
  let outsideMid = 0;
  let insideHull = 0;
  const samples = 720;
  for (let k = 0; k < samples; k++) {
    const th = (k / samples) * Math.PI * 2;
    const x = axisAtTop + major * Math.cos(th);
    const y = r * Math.sin(th);
    if (!inRing(midOnly, x, y)) outsideMid++;
    if (inRing(hole, x * 1 - (x - axisAtTop) * 0.001, y * 0.999)) insideHull++;
  }
  check(
    'the mid-plane ellipse alone does not admit the leg at the top face',
    outsideMid > samples / 4,
    `${outsideMid} of ${samples} points outside it`,
  );
  check('the swept hull does', insideHull === samples, `${insideHull} of ${samples}`);

  /*
   * Sampled a hair inside the leg rather than on its surface.
   *
   * The hull is built from points on those very ellipses, so a test point on
   * the surface is a polygon vertex, and asking whether a vertex is inside its
   * own polygon is a coin toss with even-odd parity. The question worth asking
   * is whether the leg's *material* clears the hole, which is the interior.
   */
  const insideLeg = 0.999;
  let insideBottom = 0;
  for (let k = 0; k < samples; k++) {
    const th = (k / samples) * Math.PI * 2;
    const x = spec.radius + major * insideLeg * Math.cos(th);
    const y = r * insideLeg * Math.sin(th);
    if (inRing(hole, x, y)) insideBottom++;
  }
  check('and at the bottom face too', insideBottom === samples, `${insideBottom} of ${samples}`);

  const upright = legHole(leg({ tilt: 0 }), 0, 0, t, 720);
  const u = bounds(upright);
  check('a vertical leg sweeps nowhere', near(u.maxX - u.minX, 12, 1e-3));
  check('and its hole is the same at any thickness', near(bounds(legHole(leg({ tilt: 0 }), 0, 0, 20, 720)).maxX - u.maxX, 0, 1e-9));
}

console.log('legs: kerf and clamping');
{
  const t = 3;
  const sharp = legHole(leg({ kerf: 0 }), 0, 0, t, 720);
  const cut = legHole(leg({ kerf: 0.4 }), 0, 0, t, 720);
  const a = bounds(sharp);
  const b = bounds(cut);

  // A hole is cut narrow and burns out to size, so the path is a kerf smaller
  // across — half a kerf off each side.
  check('the cut path is a kerf narrower across', near(a.maxY - a.minY - (b.maxY - b.minY), 0.4, 1e-6));
  check('and a kerf shorter along', near(a.maxX - a.minX - (b.maxX - b.minX), 0.4, 1e-6));
  check('an absurd kerf clamps rather than inverting', area(legHole(leg({ kerf: 40 }), 0, 0, t, 64)) < 0);

  check('tilt is clamped at the ceiling', (() => {
    const wild = bounds(legHole(leg({ tilt: 89 }), 0, 0, t, 360));
    const capped = bounds(legHole(leg({ tilt: MAX_TILT }), 0, 0, t, 360));
    return near(wild.maxX - wild.minX, capped.maxX - capped.minX, 1e-9);
  })());
  check('a negative tilt is treated as upright', (() => {
    const back = bounds(legHole(leg({ tilt: -20 }), 0, 0, t, 360));
    return near(back.maxX - back.minX, 12, 1e-3);
  })());
}

console.log('legs: the splay follows the height');
{
  const t = 3;
  const spec = leg({ tilt: 30, zRef: 0 });
  // (spec, azimuth, zBottom, thickness, segments). The first version of these
  // three lines dropped an argument and cut a 360 mm thick sheet.
  const low = bounds(legHole(spec, 0, 0, t, 360));
  const high = bounds(legHole(spec, 0, 30, t, 360));

  check(
    'a sheet higher up takes its hole further in',
    (high.minX + high.maxX) / 2 < (low.minX + low.maxX) / 2,
    `${((high.minX + high.maxX) / 2).toFixed(2)} against ${((low.minX + low.maxX) / 2).toFixed(2)}`,
  );
  check(
    'by exactly the height times the tangent',
    near(
      (low.minX + low.maxX) / 2 - (high.minX + high.maxX) / 2,
      30 * Math.tan(30 * DEG),
      1e-3,
    ),
  );
  check('an upright leg does not wander with height', (() => {
    const s = leg({ tilt: 0 });
    const atFloor = bounds(legHole(s, 0, 0, t, 360));
    const atCeiling = bounds(legHole(s, 0, 90, t, 360));
    return near(
      (atFloor.minX + atFloor.maxX) / 2,
      (atCeiling.minX + atCeiling.maxX) / 2,
      1e-9,
    );
  })());
}

console.log('legs: a set of them');
{
  const t = 3;
  const holes = legHoles(leg({ count: 5 }), 0, t, 64);
  check('one hole per leg', holes.length === 5);
  check('all wound as holes', holes.every((h) => area(h) < 0));
  check('all the same size', (() => {
    const areas = holes.map((h) => Math.abs(area(h)));
    return Math.max(...areas) - Math.min(...areas) < 1e-6;
  })());
  check('spread around the axis', (() => {
    const centres = holes.map((h) => {
      const b = bounds(h);
      return Math.hypot((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    });
    return Math.max(...centres) - Math.min(...centres) < 1e-6;
  })());
  check('and off the axis', (() => {
    const b = bounds(holes[0]);
    return Math.hypot((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2) > 40;
  })());

  const moved = legHoles(leg({ count: 5, x: 100, y: -40 }), 0, t, 64);
  check('the whole set follows the axis', (() => {
    const b = bounds(moved[0]);
    const c = bounds(holes[0]);
    return near((b.minX + b.maxX) / 2 - (c.minX + c.maxX) / 2, 100, 1e-9);
  })());
}

console.log('legs: the hull itself');
{
  const square = [0, 0, 10, 0, 10, 10, 0, 10, 5, 5];
  const hull = convexHull(square);
  check('an interior point is dropped', hull.length / 2 === 4);
  check('the hull is counter-clockwise', area(hull) > 0);
  check('two points are returned unchanged', convexHull([0, 0, 1, 1]).length === 4);
  check('collinear points do not break it', convexHull([0, 0, 5, 0, 10, 0, 10, 10, 0, 10]).length / 2 === 4);
}

console.log('legs: the field says the same thing the hull did');
{
  /*
   * The hull is the proven one — 4096 sides, checked against the analytic
   * ellipse and the sweep. The field replaced it so that a leg over the rim
   * takes a bite instead of being refused, and the way to make that change
   * safely is to show it changes nothing about the shape itself.
   */
  const cases = [
    [45, 3, 6, 60, 1],
    [15, 3, 6, 38, 3],
    [0, 3, 6, 50, 4],
    [60, 0.5, 4, 30, 3],
  ];

  for (const [tilt, t, r, radius, count] of cases) {
    const spec = leg({ tilt, diameter: r * 2, radius, count });
    const sections = legSections(spec, 0, t);
    const polygons = legAzimuths(spec).map((az) => legHole(spec, az, 0, t, 2048));

    let disagreements = 0;
    let samples = 0;
    const reach = radius + 25;
    for (let i = 0; i < 200; i++) {
      for (let j = 0; j < 200; j++) {
        const x = -reach + (i / 199) * 2 * reach;
        const y = -reach + (j / 199) * 2 * reach;
        const inField = sectionsDistance(sections, x, y) < 0;
        const inHull = polygons.some((poly) => inRing(poly, x, y));
        samples++;
        if (inField !== inHull) disagreements++;
      }
    }
    check(
      `tilt ${tilt}, ${count} leg(s): the field's zero level is the hull`,
      disagreements === 0,
      `${disagreements} of ${samples}`,
    );
  }

  // One section per leg, and the geometry it carries.
  const spec = leg({ tilt: 45, count: 3 });
  const sections = legSections(spec, 0, 3);
  check('one section per leg', sections.length === 3);
  check('the semi-minor is the leg radius', near(sections[0].b, 6, 1e-12));
  check('the semi-major is r / cos θ', near(sections[0].a, 6 / Math.cos(45 * DEG), 1e-12));
  check('the sweep is t · tan θ', near(sections[0].shift, 3 * Math.tan(45 * DEG), 1e-12));
  check('the centre is the spread at the sheet bottom', near(sections[0].cx, 60, 1e-12));

  /*
   * No kerf in the section, deliberately. The slicer takes its contour at
   * +kerf/2 and that shrinks a hole on its own; doing it here as well would cut
   * every leg hole a full kerf small and no leg would go in.
   */
  const kerfed = legSections(leg({ tilt: 45, kerf: 0.4 }), 0, 3);
  check('the section carries no kerf of its own', near(kerfed[0].b, sections[0].b, 1e-12));

  // Inside is negative, outside positive, and the surface is where it says.
  check('the centre of a leg is inside', sectionDistance(sections[0], 60, 0) < 0);
  check('the axis is one radius in', near(sectionDistance(sections[0], 60, 0), -6, 0.02));
  check('a point far away is far away', near(sectionDistance(sections[0], 60, 40), 34, 0.2));
  check('and the sign is right there', sectionDistance(sections[0], 60, 40) > 0);

  // A sheet higher up: the leg has leaned in.
  const higher = legSections(leg({ tilt: 30 }), 30, 3);
  check(
    'a section higher up sits closer to the axis',
    higher[0].cx < legSections(leg({ tilt: 30 }), 0, 3)[0].cx,
  );
  check(
    'by the height times the tangent',
    near(legSections(leg({ tilt: 30 }), 0, 3)[0].cx - higher[0].cx, 30 * Math.tan(30 * DEG), 1e-9),
  );

  check('an empty set of sections is far away, not near', sectionsDistance([], 0, 0) > 1000);
}

console.log('');
if (failures > 0) {
  console.log(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    legs');
