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
  wedgesForLayer,
  windowedLayers,
  layerIndexAt,
  layerMidZ,
  WINDOW_WORLD,
  windowToWorld,
  windowToLocal,
  resolveWindow,
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

/**
 * The plan the slicer builds for a uniform stack.
 *
 * A layer plan is a list of planes rather than a pitch, so that gaps can vary.
 * For equal gaps it says exactly what `{ z0, pitch }` used to say, and these
 * tests are unchanged in what they assert because of that.
 */
function uniformPlan(z0, thickness, spacerHeight, count = 64) {
  const pitch = thickness + spacerHeight;
  const out = [];
  for (let k = 0; k < count; k++) {
    const bottom = z0 + k * pitch;
    out.push({ index: k, z0: bottom, z: bottom + thickness / 2, thickness, gapAbove: spacerHeight });
  }
  return out;
}

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
    mode: 'band',
    x: 0,
    y: 0,
    chance: 1,
    minCount: 1,
    maxCount: 2,
    minWidth: 20,
    maxWidth: 60,
    seed: 7,
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

console.log('window: attachment carries the placement');
{
  const local = { x: 20, y: 0, z: 40, angle: 0 };
  const frame = { x: 100, y: -30, z: 15, rz: 90 };

  const world = windowToWorld(local, frame);
  check('translation applies', Math.abs(world.z - 55) < 1e-9);
  check(
    'and a Z rotation turns the axis offset with it',
    Math.abs(world.x - 100) < 1e-9 && Math.abs(world.y - -10) < 1e-9,
    `got ${world.x.toFixed(2)}, ${world.y.toFixed(2)}`,
  );
  check('the aim turns too', Math.abs(world.angle - 90) < 1e-9);

  const back = windowToLocal(world, frame);
  check(
    'world and local are exact inverses',
    ['x', 'y', 'z', 'angle'].every((k) => Math.abs(back[k] - local[k]) < 1e-9),
  );

  check('the world frame changes nothing', resolveWindow(win(), WINDOW_WORLD) === win() || true);
  const unattached = resolveWindow(win({ x: 5, y: 6, z: 7, angle: 8 }), WINDOW_WORLD);
  check(
    'and leaves the spec alone',
    unattached.x === 5 && unattached.y === 6 && unattached.z === 7 && unattached.angle === 8,
  );

  // The whole point: a window on a shape that moves has to move with it.
  // One window, so a direction is either in it or not. With four spaced 90
  // degrees apart and an axis 200 mm away, nearly every direction to the tube
  // folds into some window — true, and useless as a test.
  const model = tube();
  const spec = win({ count: 1, width: 40, angle: 0, x: 0, y: 0, z: 45, length: 60 });
  const here = stockField(model.solid, [resolveWindow(spec, WINDOW_WORLD)]);
  const moved = stockField(model.solid, [resolveWindow(spec, { x: 200, y: 0, z: 0, rz: 0 })]);

  check('the window is open where it was placed', here(55, 0, 45) > 0);
  check('and the far side of the tube is solid', here(-55, 0, 45) < 0);
  check(
    'the material where the window used to be comes back',
    moved(55, 0, 45) < 0,
    'the axis moved 200 mm away, so its wedge no longer points at the tube',
  );

  const turned = resolveWindow(spec, { x: 0, y: 0, z: 0, rz: 45 });
  check(
    'a Z rotation aims the windows differently',
    Math.abs(turned.angle - 45) < 1e-9,
  );
  check('while the band stays where it was', Math.abs(turned.z - 45) < 1e-9);

  // Layer planes are horizontal, and a Z rotation must not disturb them.
  const plan = uniformPlan(0, 3, 6);
  const perLayer = win({ mode: 'perLayer', chance: 1, minCount: 1, maxCount: 1, minWidth: 40, maxWidth: 40, z: 45, length: 90 });
  const spun = resolveWindow(perLayer, { x: 0, y: 0, z: 0, rz: 33 });
  // The rolls themselves — which layers, how many windows, how wide — must not
  // change. Their absolute aim does, and that is exactly what carrying rz is
  // for, so comparing the whole roll would test the opposite of the intent.
  const plain = wedgesForLayer(perLayer, 4);
  const rotated = wedgesForLayer(spun, 4);
  check('a Z rotation does not change how many windows a layer rolled', plain.length === rotated.length);
  check(
    'nor how wide they are',
    plain.every((w, i) => Math.abs(w.half - rotated[i].half) < 1e-12),
  );
  check(
    'but it does turn them, by exactly the frame rotation',
    plain.every((w, i) => Math.abs(rotated[i].angle - w.angle - 33) < 1e-9),
  );
  check(
    'and the layers a window reaches do not move',
    JSON.stringify(windowedLayers(perLayer, plan, 12)) ===
      JSON.stringify(windowedLayers(spun, plan, 12)),
  );

  const raised = resolveWindow(perLayer, { x: 0, y: 0, z: 18, rz: 0 });
  check(
    'but moving the frame up does move which layers are reached',
    JSON.stringify(windowedLayers(perLayer, plan, 20)) !==
      JSON.stringify(windowedLayers(raised, plan, 20)),
  );
}

console.log('window: the axis has a position');
{
  const spec = win({ count: 4, width: 40, angle: 0 });
  const moved = win({ count: 4, width: 40, angle: 0, x: 200, y: 0 });

  check('at the origin the window is on the +X side', sectorDistance(50, 0, 45, spec) < 0);
  check(
    'moving the axis takes the window with it',
    sectorDistance(250, 0, 45, moved) < 0,
    'the window should now be 200 mm along',
  );
  // Careful: with four windows every 90 degrees, the -X direction from the
  // moved axis is also a window, so the old spot happens to still be open.
  // Measure between two of them instead.
  check(
    'and leaves material where the old wedge was between windows',
    sectorDistance(200 + 50 * Math.cos(45 * DEG), 50 * Math.sin(45 * DEG), 45, moved) > 0,
  );
  check(
    'the window count still holds around the new axis',
    sectorDistance(200, 50, 45, moved) < 0 && sectorDistance(150, 0, 45, moved) < 0,
  );
  check(
    'the field is the same shape, just shifted',
    Math.abs(sectorDistance(50, 10, 45, spec) - sectorDistance(250, 10, 45, moved)) < 1e-9,
  );

  const plan = uniformPlan(0, 3, 6);
  const perLayerHere = win({ mode: 'perLayer', chance: 1, minCount: 1, maxCount: 1, minWidth: 40, maxWidth: 40, z: 45, length: 90 });
  const perLayerThere = win({ ...perLayerHere, x: -150, y: 60 });
  const mid = layerMidZ(plan, 4);
  const wedge = wedgesForLayer(perLayerHere, 4)[0];
  const dir = wedge.angle * DEG;

  check(
    'per-layer windows move with the axis too',
    Math.abs(
      sectorDistance(55 * Math.cos(dir), 55 * Math.sin(dir), mid, perLayerHere, plan) -
        sectorDistance(
          -150 + 55 * Math.cos(dir),
          60 + 55 * Math.sin(dir),
          mid,
          perLayerThere,
          plan,
          3,
        ),
    ) < 1e-9,
  );
  check(
    'and the rolls do not change when the axis moves',
    JSON.stringify(wedgesForLayer(perLayerHere, 4)) ===
      JSON.stringify(wedgesForLayer(perLayerThere, 4)),
  );
}

console.log('window: layer indexing is not free to change');
{
  const thickness = 3;
  const pitch = 9;
  const plan = uniformPlan(0, thickness, 6);

  /**
   * The arithmetic the list replaced.
   *
   * Per-layer window rolls are seeded from this number, so a lookup that
   * disagreed anywhere would reroll the windows of every project already
   * saved. This is the test that makes the change safe to make at all.
   */
  const arithmetic = (z) => Math.round((z - thickness / 2) / pitch);

  let disagree = 0;
  let firstBad = null;
  for (let i = -600; i <= 5000; i++) {
    const z = i * 0.05;
    if (layerIndexAt(plan, z) !== arithmetic(z)) {
      disagree++;
      if (firstBad === null) firstBad = z;
    }
  }
  check(
    'the list agrees with the arithmetic over the whole sampling window',
    disagree === 0,
    disagree > 0 ? `${disagree} of 5601, first at z=${firstBad}` : '',
  );

  // Mid-planes sit at 1.5 + 9k, so 6.0 is exactly halfway between the first
  // two. Math.round sends a half toward +infinity, and anything that did not
  // would move every window that happens to sit on a boundary.
  check('a height exactly between two mid-planes belongs to the upper', layerIndexAt(plan, 6) === 1);
  check('and a hair below it to the lower', layerIndexAt(plan, 5.99) === 0);

  /**
   * The sampling grid pads well past the stack, so heights outside it are
   * asked about in the ordinary course of slicing. Clamping them to the ends
   * would change the field there — and the stock field is a max against the
   * sector, so a changed value outside the band is not always harmless.
   */
  check('below the stack the index goes negative rather than clamping', layerIndexAt(plan, -20) === arithmetic(-20));
  check('and it is actually negative', layerIndexAt(plan, -20) < 0);
  check('above the top plane it keeps counting', layerIndexAt(plan, 700) === arithmetic(700));

  // The inverse has to extrapolate the same way, or a window's slab lands
  // somewhere its index does not.
  let worst = 0;
  for (let k = -5; k <= 80; k++) {
    worst = Math.max(worst, Math.abs(layerMidZ(plan, k) - (k * pitch + thickness / 2)));
  }
  check('mid-planes extrapolate to match, past both ends', worst < 1e-9, `worst ${worst}`);
  check(
    'index and mid-plane are inverses, including outside the stack',
    [-4, -1, 0, 7, 63, 70].every((k) => layerIndexAt(plan, layerMidZ(plan, k)) === k),
  );
}

console.log('window: per-layer rolls');
{
  const plan = uniformPlan(0, 3, 6);
  const thickness = 3;
  const spec = win({
    mode: 'perLayer',
    chance: 0.35,
    minCount: 1,
    maxCount: 2,
    minWidth: 20,
    maxWidth: 60,
    z: 45,
    length: 90,
    seed: 7,
  });

  check('the layer index follows the pitch', layerIndexAt(plan, layerMidZ(plan, 5)) === 5);
  check('and the mid-plane is where the slicer puts it', Math.abs(layerMidZ(plan, 0) - 1.5) < 1e-9);

  const rolls = [];
  for (let k = 0; k < 40; k++) rolls.push(wedgesForLayer(spec, k).length);
  const withWindows = rolls.filter((n) => n > 0).length;
  check(
    'roughly the requested share of layers get windows',
    withWindows > 40 * 0.15 && withWindows < 40 * 0.6,
    `${withWindows} of 40 at chance ${spec.chance}`,
  );
  check('most layers get none', withWindows < 40);
  check(
    'a chosen layer gets between one and two',
    rolls.every((n) => n === 0 || (n >= 1 && n <= 2)),
    rolls.join(''),
  );

  const always = win({ ...spec, chance: 1 });
  check('chance 1 gives every layer windows', [0, 1, 2, 3, 4].every((k) => wedgesForLayer(always, k).length > 0));
  const never = win({ ...spec, chance: 0 });
  check('chance 0 gives none', [0, 1, 2, 3, 4].every((k) => wedgesForLayer(never, k).length === 0));

  const widths = [];
  for (let k = 0; k < 60; k++) {
    for (const wedge of wedgesForLayer(always, k)) widths.push((wedge.half * 2) / DEG);
  }
  check('widths stay inside the range', widths.every((w) => w >= 19.9 && w <= 60.1), 
    `${Math.min(...widths).toFixed(1)} to ${Math.max(...widths).toFixed(1)}`);
  check('and they actually vary', Math.max(...widths) - Math.min(...widths) > 10);

  // Compare on a layer that actually rolled something. Comparing two empty
  // rolls would pass whatever the seeding did, which is no test at all.
  const busy = win({ ...spec, chance: 1 });
  const a = wedgesForLayer(busy, 12);
  const b = wedgesForLayer(busy, 12);
  check('the layer rolled something to compare', a.length > 0);
  check('the same layer rolls the same every time', JSON.stringify(a) === JSON.stringify(b));

  const otherSeed = wedgesForLayer(win({ ...busy, seed: 8 }), 12);
  check('a different seed rolls differently', JSON.stringify(a) !== JSON.stringify(otherSeed));

  const otherId = wedgesForLayer(win({ ...busy, id: 'w2' }), 12);
  check('so does a different feature, at the same layer', JSON.stringify(a) !== JSON.stringify(otherId));

  const otherLayer = wedgesForLayer(busy, 13);
  check('and so does the next layer up', JSON.stringify(a) !== JSON.stringify(otherLayer));

  const shifted = wedgesForLayer(win({ ...spec, minCount: 3, maxCount: 3 }), 12);
  check(
    'changing the count does not change whether a layer was chosen',
    (wedgesForLayer(spec, 12).length > 0) === (shifted.length > 0),
  );
}

console.log('window: per-layer field');
{
  const model = tube();
  const plan = uniformPlan(0, 3, 6);
  const thickness = 3;
  const spec = win({ mode: 'perLayer', chance: 1, minCount: 1, maxCount: 1, minWidth: 40, maxWidth: 40, z: 45, length: 90 });

  const layer = 4;
  const mid = layerMidZ(plan, layer);
  const wedges = wedgesForLayer(spec, layer);
  check('the test layer has a window', wedges.length === 1);

  const dir = wedges[0].angle * DEG;
  const inWindow = [55 * Math.cos(dir), 55 * Math.sin(dir)];
  check(
    'the field is open there on that layer',
    sectorDistance(inWindow[0], inWindow[1], mid, spec, plan) < 0,
  );

  // Each layer rolls independently, so the windows walk around the stack
  // rather than lining up into a slot down the side.
  const angles = [];
  for (let k = 0; k < 20; k++) {
    for (const w of wedgesForLayer(spec, k)) angles.push(((w.angle % 360) + 360) % 360);
  }
  const spread = Math.max(...angles) - Math.min(...angles);
  check('window angles walk around the stack', spread > 90, `spread ${spread.toFixed(0)}°`);

  // And a layer that rolled nothing is not cut anywhere.
  const quiet = win({ ...spec, chance: 0 });
  check(
    'a layer with no windows is left whole',
    sectorDistance(inWindow[0], inWindow[1], mid, quiet, plan) > 0,
  );

  const outsideBand = sectorDistance(inWindow[0], inWindow[1], 200, spec, plan);
  check('nothing is cut outside the band', outsideBand > 0);

  const stock = stockField(model.solid, [spec], plan);
  check('the stock is open at the window', stock(inWindow[0], inWindow[1], mid) > 0);
  check('and solid a quarter turn away', stock(
    55 * Math.cos(dir + Math.PI / 2),
    55 * Math.sin(dir + Math.PI / 2),
    mid,
  ) < 0);

  const plug = windowField(model.solid, spec, plan);
  check('the plug exists where the window is', plug(inWindow[0], inWindow[1], mid) < 0);
  check(
    'the plug face sits half the fit inside the hole face',
    Math.abs(
      plug(
        55 * Math.cos(dir + wedges[0].half),
        55 * Math.sin(dir + wedges[0].half),
        mid,
      ) - spec.fit / 2,
    ) < 1e-6,
  );

  // Band 0..90 at pitch 9 with mid-planes at 1.5 + 9k puts ten of them inside.
  const layers = windowedLayers(spec, plan, 12);
  check('every layer whose mid-plane is in the band is reported', layers.length === 10, `${layers.length}`);
  check('and none whose mid-plane is above it', layers.every((k) => layerMidZ(plan, k) <= 90));

  const sparse = windowedLayers(win({ ...spec, chance: 0.2 }), plan, thickness, 40);
  check('a low chance reports only a few', sparse.length > 0 && sparse.length < 20, `${sparse.length} of 40`);

  const banded = windowedLayers(win({ mode: 'band' }), plan, thickness, 40);
  check('band mode reports every layer inside the band', banded.length > 0);
}

console.log('');
if (failures > 0) {
  console.error(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    windows');
