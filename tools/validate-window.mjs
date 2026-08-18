#!/usr/bin/env node
/**
 * validate-window.mjs
 *
 * The claim being tested is the one the whole feature rests on: the plug and
 * the hole it fills are the same curve, offset only by the fit clearance. That
 * is checked by slicing both through the real slicer and measuring them against
 * each other, not by inspecting the code that made them.
 *
 *   node tools/validate-window.mjs
 */

import {
  sectorDistance,
  windowHalfAngle,
  windowSpansZ,
  windowField,
  stockField,
} from '../src/core/window.ts';

import { sliceModel, signedArea } from '../src/core/slice.ts';

import {
  prepareFeatures,
  evaluatePoint,
  modelBounds,
  defaultParams,
  defaultModifierParams,
  findModule,
  shellModifier,
} from '../src/core/sdf.ts';

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
const DEG = Math.PI / 180;

function win(overrides = {}) {
  return {
    id: 'w1',
    label: 'Window 1',
    count: 4,
    width: 40,
    angle: 0,
    twist: 0,
    z: 45,
    length: 60,
    fit: 0.4,
    kerf: 0.1,
    ...overrides,
  };
}

/** A hollow cylinder, radius 60, wall 10, z from 0 to 90. */
function tube() {
  const capsule = findModule('capsule');
  const tree = [
    {
      kind: 'capsule',
      enabled: true,
      params: { ...defaultParams(capsule), op: 'union', h: 90, r: 60, pz: 45 },
    },
    { kind: 'shell', enabled: true, params: { ...defaultModifierParams(shellModifier), t: 10 } },
  ];
  const prepared = prepareFeatures(tree);
  return {
    solid: (x, y, z) => evaluatePoint(prepared, x, y, z),
    bounds: modelBounds(tree),
  };
}

console.log('window: the sector');
{
  const spec = win({ count: 4, width: 40, angle: 0 });

  check('the axis of the first window is inside it', sectorDistance(50, 0, 45, spec) < 0);
  check('halfway between two windows is outside', sectorDistance(50 * Math.cos(45 * DEG), 50 * Math.sin(45 * DEG), 45, spec) > 0);
  check('the second window is where it should be', sectorDistance(0, 50, 45, spec) < 0);
  check('the third too', sectorDistance(-50, 0, 45, spec) < 0);

  const edge = 20 * DEG;
  check(
    'the sector edge is at half the width',
    near(sectorDistance(50 * Math.cos(edge), 50 * Math.sin(edge), 45, spec), 0, 1e-9),
  );
  check(
    'just inside the edge is inside',
    sectorDistance(50 * Math.cos(edge * 0.9), 50 * Math.sin(edge * 0.9), 45, spec) < 0,
  );

  check('above the band is outside', sectorDistance(50, 0, 80, spec) > 0);
  check('below the band is outside', sectorDistance(50, 0, 10, spec) > 0);
  check('the band edge is on the surface', near(sectorDistance(50, 0, 75, spec), 0, 1e-9));
  check('the band spans what it says', windowSpansZ(spec, 45) && !windowSpansZ(spec, 76));

  const turned = win({ angle: 45 });
  check('the angle rotates the set', sectorDistance(50 * Math.cos(45 * DEG), 50 * Math.sin(45 * DEG), 45, turned) < 0);
  check('and moves it off the old place', sectorDistance(50, 0, 45, turned) > 0);

  const twisted = win({ twist: 2 });
  const atTop = sectorDistance(50 * Math.cos(30 * DEG), 50 * Math.sin(30 * DEG), 60, twisted);
  check('a twist moves the window with height', atTop < 0, `distance ${atTop.toFixed(2)}`);
  check('while the middle stays put', sectorDistance(50, 0, 45, twisted) < 0);
}

console.log('window: the width ceiling');
{
  // Windows that met would open the ring into loose arcs.
  const greedy = win({ count: 4, width: 300 });
  const half = windowHalfAngle(greedy);
  check('an impossible width is clamped', half < (Math.PI * 2) / 4 / 2);
  check('and never past a right angle', windowHalfAngle(win({ count: 1, width: 350 })) <= 89 * DEG + 1e-9);
  check(
    'clamping leaves material between windows',
    sectorDistance(50 * Math.cos(45 * DEG), 50 * Math.sin(45 * DEG), 45, greedy) > 0,
  );
  check('a sane width is left alone', near(windowHalfAngle(win({ width: 40 })), 20 * DEG, 1e-12));
  check('a single window can be wide', windowHalfAngle(win({ count: 1, width: 120 })) > 55 * DEG);
}

console.log('window: stock and plug fields');
{
  const model = tube();
  const spec = win({ count: 4, width: 40, fit: 0.4 });
  const stock = stockField(model.solid, [spec]);
  const plug = windowField(model.solid, spec);

  check('the stock keeps material between windows', stock(55 * Math.cos(45 * DEG), 55 * Math.sin(45 * DEG), 45) < 0);
  check('and has none where a window is', stock(55, 0, 45) > 0);
  check('the plug is solid where the window is', plug(55, 0, 45) < 0);
  check('and empty between windows', plug(55 * Math.cos(45 * DEG), 55 * Math.sin(45 * DEG), 45) > 0);
  check('the plug is empty outside the band', plug(55, 0, 80) > 0);
  check('no windows leaves the stock untouched', stockField(model.solid, [])(55, 0, 45) < 0);

  // The plug must be smaller than the hole by half the fit on every face.
  const holeEdge = 20 * DEG;
  const onEdge = [55 * Math.cos(holeEdge), 55 * Math.sin(holeEdge)];
  check(
    'the plug face sits half the fit inside the hole face',
    near(plug(onEdge[0], onEdge[1], 45), spec.fit / 2, 1e-6),
    `${plug(onEdge[0], onEdge[1], 45).toFixed(4)} mm, expected ${(spec.fit / 2).toFixed(4)}`,
  );
  check(
    'a zero fit makes plug and hole the same size',
    near(windowField(model.solid, win({ fit: 0 }))(onEdge[0], onEdge[1], 45), 0, 1e-9),
  );
}

console.log('window: sliced, the plug fits the hole');
{
  const model = tube();
  const spec = win({ count: 4, width: 40, fit: 0.4, kerf: 0.1 });

  const sliceOptions = {
    thickness: 3,
    spacerHeight: 6,
    resolution: 260,
    tolerance: 0.02,
    smoothing: 1,
  };

  const stockSet = sliceModel(stockField(model.solid, [spec]), model.bounds, {
    ...sliceOptions,
    kerf: 0.2,
  });
  const plugSet = sliceModel(windowField(model.solid, spec), model.bounds, {
    ...sliceOptions,
    kerf: spec.kerf,
  });

  check('the stock slices', stockSet.slices.length > 5);
  check('the windows slice too', plugSet.slices.length > 3, `${plugSet.slices.length} layers`);
  check(
    'there are fewer window layers than stock layers, the band being shorter',
    plugSet.slices.length < stockSet.slices.length,
  );

  const middle = plugSet.slices[Math.floor(plugSet.slices.length / 2)];
  check('each window layer is four separate parts', middle.contours.length === 4, `${middle.contours.length}`);
  check('all of them are solid, none a hole', middle.contours.every((c) => !c.isHole));

  // Area of one plug: a 40 degree wedge of a 60/50 annulus, less the fit.
  const nominal = ((40 * DEG) / 2) * (60 * 60 - 50 * 50);
  const measured = Math.abs(middle.contours[0].area);
  check(
    'a plug is about the wedge of the wall it came from',
    Math.abs(measured - nominal) / nominal < 0.12,
    `${measured.toFixed(0)} mm2, a clean wedge would be ${nominal.toFixed(0)}`,
  );

  // The plug must be smaller than the hole. Compare widths at mid-wall radius.
  const stockLayer = stockSet.slices.find((s) => Math.abs(s.z - middle.z) < 0.01);
  check('the same plane exists in both sets', stockLayer !== undefined);

  /**
   * Angles where a contour crosses the circle of radius R.
   *
   * Measuring by picking vertices near R does not work: simplification removes
   * every vertex along a straight radial edge, so the edge is a single segment
   * from r=50 to r=60 with nothing in between. The crossing has to be solved
   * for.
   */
  const arcAngles = (contour, R) => {
    const out = [];
    const pts = contour.points;
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = pts[i * 2];
      const ay = pts[i * 2 + 1];
      const bx = pts[j * 2];
      const by = pts[j * 2 + 1];
      const ra = Math.hypot(ax, ay);
      const rb = Math.hypot(bx, by);
      if (ra === rb) continue;
      if (ra < R !== rb < R) {
        const t = (R - ra) / (rb - ra);
        out.push(Math.atan2(ay + (by - ay) * t, ax + (bx - ax) * t));
      }
    }
    return out.sort((p2, q) => p2 - q);
  };

  const plugWedge = middle.contours.find((c) => {
    const cx = c.points[0];
    const cy = c.points[1];
    return Math.abs(Math.atan2(cy, cx)) < 30 * DEG;
  });
  check('one plug sits on the +X axis', plugWedge !== undefined);
  if (!plugWedge || !stockLayer) throw new Error('no plug to measure');

  const R = 55;
  const plugCrossings = arcAngles(plugWedge, R).filter((a) => Math.abs(a) < 40 * DEG);
  check('the plug crosses the measuring circle twice', plugCrossings.length === 2, `${plugCrossings.length}`);

  // Four windows cut the ring into four separate arcs, so the two faces of one
  // opening belong to two different parts. That is the point of the feature —
  // and a reminder that a "ring with a bite out of it" is not one contour.
  check(
    'the ring has come apart into four arcs',
    stockLayer.contours.filter((c) => !c.isHole).length === 4,
    `${stockLayer.contours.filter((c) => !c.isHole).length} parts`,
  );

  const stockCrossings = stockLayer.contours
    .flatMap((c) => arcAngles(c, R))
    .filter((a) => Math.abs(a) < 40 * DEG)
    .sort((p2, q) => p2 - q);
  check('the opening has two cut faces', stockCrossings.length === 2, `${stockCrossings.length}`);

  if (plugCrossings.length === 2 && stockCrossings.length === 2) {
    const plugArc = (plugCrossings[1] - plugCrossings[0]) * R;
    const holeArc = (stockCrossings[1] - stockCrossings[0]) * R;
    check(
      'the plug is narrower than its hole',
      plugArc < holeArc,
      `plug ${plugArc.toFixed(3)} mm, hole ${holeArc.toFixed(3)} mm`,
    );
    // What is measured here are the CUT PATHS, not the finished parts. Each
    // path is offset from its design surface by half its own kerf, in the
    // direction that makes the finished piece come out right: the opening is
    // cut narrow so it burns out to size, the plug is cut wide so it burns
    // down to size. So the paths differ by less than the fit, by exactly the
    // two kerfs — and the finished pieces differ by the fit, which is the
    // number that matters when the plexi goes into the cardboard.
    const stockKerf = 0.2;
    const cutGap = holeArc - plugArc;
    const finishedGap = cutGap + stockKerf + spec.kerf;

    check(
      'the cut paths differ by the fit less both kerfs',
      Math.abs(cutGap - (spec.fit - stockKerf - spec.kerf)) < 0.06,
      `cut gap ${cutGap.toFixed(3)} mm, expected ${(spec.fit - stockKerf - spec.kerf).toFixed(3)}`,
    );
    check(
      'so the finished plug is the fit clearance smaller than its hole',
      Math.abs(finishedGap - spec.fit) < 0.06,
      `finished gap ${finishedGap.toFixed(3)} mm, fit ${spec.fit} mm`,
    );
  }

  check(
    'every plug contour is wound as a solid',
    plugSet.slices.every((s) => s.contours.every((c) => signedArea(c.points) > 0)),
  );

  const again = sliceModel(windowField(model.solid, spec), model.bounds, {
    ...sliceOptions,
    kerf: spec.kerf,
  });
  check('window slicing is deterministic', JSON.stringify(again.slices) === JSON.stringify(plugSet.slices));
}

console.log('window: degenerate settings');
{
  const model = tube();

  const none = win({ count: 0 });
  check('a count of zero is treated as one', sectorDistance(55, 0, 45, none) < 0);

  const flat = win({ length: 0 });
  check('a zero-height band still evaluates', Number.isFinite(sectorDistance(55, 0, 45, flat)));

  const thin = win({ width: 0 });
  check('a zero width cuts nothing', sectorDistance(55, 0, 45, thin) >= 0);

  const many = win({ count: 24, width: 30 });
  check(
    'many narrow windows still leave material between them',
    sectorDistance(55 * Math.cos(7.5 * DEG), 55 * Math.sin(7.5 * DEG), 45, many) > 0,
  );

  check('the axis itself does not divide by zero', Number.isFinite(sectorDistance(0, 0, 45, win())));
}

console.log('');
if (failures > 0) {
  console.error(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    windows');
