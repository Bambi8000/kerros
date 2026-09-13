#!/usr/bin/env node
/**
 * validate-rig-export.mjs
 *
 * Covers the three things M3 adds, against the real modules: kerf
 * compensation through the field, rod clearance holes and their Z-spans, and
 * the DXF R12 writer.
 *
 *   node tools/validate-rig-export.mjs
 */

import {
  sliceModel,
  signedArea,
  minFeatureGap,
  circleFitsInPart,
  groupContours,
} from '../src/core/slice.ts';
import {
  ROD_SIZES,
  ROD_CLEARANCE,
  rodDiameter,
  rodSpan,
  rodSpansZ,
  rodCutRadius,
  rodHolesAt,
  applyRods,
  rodLayerCount,
} from '../src/core/rig.ts';
import {
  LAYER_CUT,
  LAYER_ENGRAVE,
  writeDxfR12,
  kerfTestDocument,
  DEFAULT_KERF_TEST,
} from '../src/core/dxf.ts';
import {
  prepareFeatures,
  evaluatePoint,
  modelBounds,
  defaultParams,
  findModule,
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

function rod(overrides = {}) {
  return {
    id: 'r1',
    label: 'rod',
    size: 'M5',
    x: 0,
    y: 0,
    zStart: 0,
    zEnd: 100,
    diameter: 0,
    ...overrides,
  };
}

/** A hollow cylinder: outer radius 50, inner radius 30, from z=0 to z=90. */
function tubeTree() {
  const sphere = findModule('sphere');
  const capsule = findModule('capsule');
  return [
    {
      kind: 'capsule',
      enabled: true,
      params: { ...defaultParams(capsule), op: 'union', h: 90, r: 50, pz: 45 },
    },
    {
      kind: 'capsule',
      enabled: true,
      params: { ...defaultParams(capsule), op: 'subtract', h: 200, r: 30, pz: 45 },
    },
    { kind: 'sphere', enabled: true, params: { ...defaultParams(sphere), op: 'union', r: 0.5, pz: -1000 } },
  ].slice(0, 2);
}

console.log('kerf: iso-level compensation');
{
  const tree = tubeTree();
  const prepared = prepareFeatures(tree);
  const sample = (x, y, z) => evaluatePoint(prepared, x, y, z);
  const bounds = modelBounds(tree);
  const base = { thickness: 3, spacerHeight: 6, resolution: 260, tolerance: 0.02, smoothing: 1 };

  const raw = sliceModel(sample, bounds, { ...base, kerf: 0 });
  const compensated = sliceModel(sample, bounds, { ...base, kerf: 0.4 });

  check('both runs produce the same layer count', raw.slices.length === compensated.slices.length);
  check('the set records the kerf it used', near(compensated.kerf, 0.4, 1e-12));

  const pick = (set) => set.slices[Math.floor(set.slices.length / 2)];
  const a = pick(raw);
  const b = pick(compensated);
  check('the layer has an outer ring and a hole', a.contours.length === 2 && b.contours.length === 2);

  const outerOf = (slice) => slice.contours.find((c) => !c.isHole);
  const holeOf = (slice) => slice.contours.find((c) => c.isHole);

  const radiusOf = (contour) => {
    let sum = 0;
    const n = contour.points.length / 2;
    for (let i = 0; i < n; i++) {
      sum += Math.hypot(contour.points[i * 2], contour.points[i * 2 + 1]);
    }
    return sum / n;
  };

  const outerGrowth = radiusOf(outerOf(b)) - radiusOf(outerOf(a));
  const holeShrink = radiusOf(holeOf(a)) - radiusOf(holeOf(b));

  check(
    'the outer boundary grows by half a kerf',
    near(outerGrowth, 0.2, 0.01),
    `grew ${outerGrowth.toFixed(4)} mm, expected 0.2`,
  );
  check(
    'the hole shrinks by half a kerf',
    near(holeShrink, 0.2, 0.01),
    `shrank ${holeShrink.toFixed(4)} mm, expected 0.2`,
  );
  check(
    'compensation moves the two rings in opposite directions',
    Math.abs(outerOf(b).area) > Math.abs(outerOf(a).area) &&
      Math.abs(holeOf(b).area) < Math.abs(holeOf(a).area),
  );
  check('orientation survives compensation', outerOf(b).area > 0 && holeOf(b).area < 0);

  // A wall thinner than the kerf must disappear, not self-intersect.
  const thinTree = [
    {
      kind: 'capsule',
      enabled: true,
      params: { ...defaultParams(findModule('capsule')), op: 'union', h: 40, r: 30, pz: 20 },
    },
    {
      kind: 'capsule',
      enabled: true,
      params: { ...defaultParams(findModule('capsule')), op: 'subtract', h: 200, r: 29.9, pz: 20 },
    },
  ];
  const thinPrepared = prepareFeatures(thinTree);
  const thin = sliceModel(
    (x, y, z) => evaluatePoint(thinPrepared, x, y, z),
    modelBounds(thinTree),
    { ...base, kerf: 0.6 },
  );
  check(
    'a wall thinner than the kerf vanishes instead of self-intersecting',
    thin.slices.every((s) => s.contours.every((c) => Number.isFinite(signedArea(c.points)))),
  );
}

console.log('rig: rod sizes and clearance');
{
  check('five metric sizes', ROD_SIZES.length === 5);
  check('every size has a clearance', ROD_SIZES.every((s) => ROD_CLEARANCE[s] > 0));
  check('M5 clearance is 5.3', near(ROD_CLEARANCE.M5, 5.3, 1e-12));
  check('clearance grows with size', ROD_SIZES.every((s, i, all) => i === 0 || ROD_CLEARANCE[s] > ROD_CLEARANCE[all[i - 1]]));

  check('table value is used by default', near(rodDiameter(rod({ size: 'M6' })), 6.4, 1e-12));
  check('an override wins', near(rodDiameter(rod({ size: 'M6', diameter: 7 })), 7, 1e-12));
  check('an unknown size falls back rather than producing NaN', Number.isFinite(rodDiameter(rod({ size: 'M99' }))));
}

console.log('rig: z-span');
{
  const r = rod({ zStart: 20, zEnd: 80 });
  check('inside the span', rodSpansZ(r, 50));
  check('the low end is inclusive', rodSpansZ(r, 20));
  check('the high end is inclusive', rodSpansZ(r, 80));
  check('below the span', !rodSpansZ(r, 19.9));
  check('above the span', !rodSpansZ(r, 80.1));

  const backwards = rod({ zStart: 80, zEnd: 20 });
  check('a span entered backwards still works', rodSpansZ(backwards, 50));
  check('the span comes back ordered', rodSpan(backwards)[0] === 20 && rodSpan(backwards)[1] === 80);

  const degenerate = rod({ zStart: 40, zEnd: 40 });
  check('a zero-length span covers only its own plane', rodSpansZ(degenerate, 40) && !rodSpansZ(degenerate, 41));
}

console.log('rig: cut radius and holes');
{
  check(
    'the cut path is half a kerf smaller than the finished hole',
    near(rodCutRadius(5.3, 0.4), 5.3 / 2 - 0.2, 1e-12),
  );
  check('zero kerf leaves the nominal radius', near(rodCutRadius(5.3, 0), 2.65, 1e-12));
  check('an absurd kerf clamps rather than going negative', rodCutRadius(1, 10) > 0);

  const rods = [
    rod({ id: 'a', x: 30, y: 0, zStart: 0, zEnd: 50 }),
    rod({ id: 'b', x: -30, y: 0, zStart: 40, zEnd: 100, size: 'M8' }),
  ];

  const low = rodHolesAt(rods, 10, 0.4);
  check('only the rod spanning z=10 is drilled', low.length === 1 && near(low[0].x, 30, 1e-12));

  const overlap = rodHolesAt(rods, 45, 0.4);
  check('both rods are drilled where their spans overlap', overlap.length === 2);
  check('the holes carry their size in the label', overlap.some((h) => h.label.startsWith('M8')));

  /*
   * And who made them.
   *
   * The slice view lets a person point at a hole and move the thing that cut
   * it, which only works if the hole remembers its author. Worked out from
   * geometry afterwards it would be a guess; stamped when the hole is made it
   * is a fact, and this is what keeps it one.
   */
  check('every hole knows which rod made it', overlap.every((h) => typeof h.owner === 'string'));
  check('and names the right one', overlap.map((h) => h.owner).sort().join(',') === 'a,b');


  const high = rodHolesAt(rods, 90, 0.4);
  check('above the first rod only the second is drilled', high.length === 1 && near(high[0].x, -30, 1e-12));

  const slices = [{ z: 10, circles: [] }, { z: 45, circles: [] }, { z: 90, circles: [] }];
  const annotated = applyRods(slices, rods, 0.4);
  check('applying rods does not mutate the input', slices.every((s) => s.circles.length === 0));
  check('each slice gets its own holes', annotated.map((s) => s.circles.length).join(',') === '1,2,1');

  check(
    'and every hole on a slice knows its rod',
    annotated.every((slice) => slice.circles.every((h) => typeof h.owner === 'string')),
  );

  const rerun = applyRods(annotated, rods, 0.4);
  check(
    'the owner survives re-running, like the holes themselves',
    rerun.every((slice) => slice.circles.every((h) => typeof h.owner === 'string')),
  );
  check(
    're-running replaces holes instead of accumulating them',
    rerun.map((s) => s.circles.length).join(',') === '1,2,1',
  );

  check('layer counting agrees with the spans', rodLayerCount(rods[0], slices) === 2);
  check('a rod that misses the stack reports zero layers', rodLayerCount(rod({ zStart: 500, zEnd: 600 }), slices) === 0);
}

console.log('checks: thin features');
{
  const contour = (points) => ({ points, area: signedArea(points), isHole: false });
  const rectangle = (x, y, w, h) => contour([x, y, x + w, y, x + w, y + h, x, y + h]);
  const outer = rectangle(-40, -40, 80, 80);
  const hole = rectangle(38.5, -2, 1, 4);
  const sparse = minFeatureGap({ contours: [outer, hole], circles: [] }, 1);
  check('a hole beside the middle of a long edge is measured', near(sparse.minGap, 40 - (38.5 + 1), 1e-9));
  const circleEdge = minFeatureGap({ contours: [outer], circles: [{ x: 38, y: 0, r: 1.5 }] }, 1);
  check('a circular hole beside a long edge is measured', near(circleEdge.minGap, 40 - 38 - 1.5, 1e-9));
  check('a four-vertex thin rectangle has a narrow interior',
    near(minFeatureGap({ contours: [rectangle(0, 0, 80, 0.6)], circles: [] }, 1).minGap, 0.6, 1e-9));
  check('a circular cut crossing a long edge has zero clearance',
    minFeatureGap({ contours: [outer], circles: [{ x: 39, y: 0, r: 2 }] }, 1).minGap === 0);
  check('an ordinary four-vertex box has no narrow neck', !minFeatureGap({ contours: [outer], circles: [] }, 1).tooThin);
  check('densifying a smooth ring does not create a narrow neck',
    !minFeatureGap({ contours: [contour(ringPoints(0, 0, 50, 4000))], circles: [] }, 1).tooThin);
  const wideRing = {
    contours: [
      { points: ringPoints(0, 0, 50, 200), area: 1, isHole: false },
      { points: ringPoints(0, 0, 20, 120), area: -1, isHole: true },
    ],
    circles: [],
  };
  const report = minFeatureGap(wideRing, 3);
  check('a 30 mm wall is not flagged', !report.tooThin, `min gap ${report.minGap}`);

  const thinRing = {
    contours: [
      { points: ringPoints(0, 0, 50, 400), area: 1, isHole: false },
      { points: ringPoints(0, 0, 49.2, 400), area: -1, isHole: true },
    ],
    circles: [],
  };
  const thinReport = minFeatureGap(thinRing, 3);
  check('a 0.8 mm wall is flagged', thinReport.tooThin);
  check('the reported gap is about 0.8 mm', near(thinReport.minGap, 0.8, 0.05), `got ${thinReport.minGap.toFixed(3)}`);
  check('the flag comes with a location', thinReport.at !== null);

  const holeNearEdge = {
    contours: [{ points: ringPoints(0, 0, 20, 200), area: 1, isHole: false }],
    circles: [{ x: 18, y: 0, r: 1.6, label: 'M3 rod' }],
  };
  const edgeReport = minFeatureGap(holeNearEdge, 3);
  check('a rod hole 0.4 mm from the edge is flagged', edgeReport.tooThin && edgeReport.minGap < 0.5);

  const twoHoles = {
    contours: [{ points: ringPoints(0, 0, 40, 200), area: 1, isHole: false }],
    circles: [
      { x: -2, y: 0, r: 1.6, label: 'a' },
      { x: 2, y: 0, r: 1.6, label: 'b' },
    ],
  };
  check('two rod holes 0.8 mm apart are flagged', minFeatureGap(twoHoles, 3).tooThin);

  check(
    'adjacent points on one ring are not mistaken for a narrow neck',
    !minFeatureGap({ contours: [{ points: ringPoints(0, 0, 50, 400), area: 1, isHole: false }], circles: [] }, 1)
      .tooThin,
  );
}

function ringPoints(cx, cy, r, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return pts;
}

console.log('checks: circle fits in part');
{
  const annulus = groupContours([
    { points: ringPoints(0, 0, 50, 240), area: 1, isHole: false },
    { points: ringPoints(0, 0, 30, 200), area: -1, isHole: true },
  ]);
  check('the annulus groups as one part with one hole', annulus.length === 1 && annulus[0].holes.length === 1);

  const wallCentre = { x: 40, y: 0, r: 2 };
  check('a hole in the middle of the wall fits', circleFitsInPart(annulus[0], wallCentre));

  check(
    'a hole crossing the inner contour does not fit',
    !circleFitsInPart(annulus[0], { x: 31, y: 0, r: 2.5 }),
  );
  check(
    'a hole crossing the outer contour does not fit',
    !circleFitsInPart(annulus[0], { x: 49, y: 0, r: 2.5 }),
  );
  check(
    'a hole floating in the central void does not fit',
    !circleFitsInPart(annulus[0], { x: 0, y: 0, r: 2 }),
  );
  check(
    'a hole outside the part entirely does not fit',
    !circleFitsInPart(annulus[0], { x: 90, y: 0, r: 2 }),
  );
  check(
    'clearance tightens the test',
    circleFitsInPart(annulus[0], { x: 40, y: 0, r: 2 }, 5) === false ||
      circleFitsInPart(annulus[0], { x: 40, y: 0, r: 2 }, 20) === false,
  );
  check(
    'a hole exactly on the wall centreline with room to spare still fits with clearance',
    circleFitsInPart(annulus[0], { x: 40, y: 0, r: 2 }, 3),
  );
}

console.log('dxf: R12 structure');
{
  const doc = {
    polylines: [{ points: [0, 0, 10, 0, 10, 10, 0, 10], layer: LAYER_CUT }],
    circles: [{ x: 5, y: 5, r: 2, layer: LAYER_CUT }],
  };
  const text = writeDxfR12(doc);
  const lines = text.split('\n');

  check('declares R12', text.includes('AC1009'));
  check('ends with EOF', lines[lines.length - 2] === 'EOF');
  check('has a header, tables and entities section', (text.match(/\nSECTION\n/g) || []).length === 3);
  check('sections are balanced', (text.match(/\nENDSEC\n/g) || []).length === 3);
  check('defines the CUT layer', text.includes(`\n${LAYER_CUT}\n`));
  check('defines the ENGRAVE layer', text.includes(`\n${LAYER_ENGRAVE}\n`));
  check('never emits LWPOLYLINE', !text.includes('LWPOLYLINE'));
  check('writes POLYLINE with vertices-follow', text.includes('\nPOLYLINE\n') && text.includes('\n66\n1\n'));
  check('closes the ring', text.includes('\n70\n1\n'));
  check('emits one VERTEX per point', (text.match(/\nVERTEX\n/g) || []).length === 4);
  check('terminates the polyline', (text.match(/\nSEQEND\n/g) || []).length === 1);
  check('emits the circle as a CIRCLE', (text.match(/\nCIRCLE\n/g) || []).length === 1);

  // Every group code must be followed by exactly one value line.
  let wellFormed = lines.length % 2 === 1;
  for (let i = 0; i < lines.length - 1; i += 2) {
    if (!/^-?\d+$/.test(lines[i])) {
      wellFormed = false;
      break;
    }
  }
  check('every line pairs a group code with a value', wellFormed);

  check('extents cover the geometry', text.includes('$EXTMAX'));
  check('no exponent notation leaks into coordinates', !/\d[eE][+-]\d/.test(text));

  const negativeZero = writeDxfR12({
    polylines: [{ points: [-1e-9, 0, 1, 0, 1, 1], layer: LAYER_CUT }],
    circles: [],
  });
  check('negative zero is written as zero', !negativeZero.includes('-0.0000'));

  const empty = writeDxfR12({ polylines: [], circles: [] });
  check('an empty document is still a valid file', empty.includes('AC1009') && empty.trimEnd().endsWith('EOF'));

  const degenerate = writeDxfR12({
    polylines: [{ points: [1, 1], layer: LAYER_CUT }],
    circles: [],
  });
  check('a single-point polyline is dropped', !degenerate.includes('\nPOLYLINE\n'));
}

console.log('dxf: kerf test figure');
{
  const doc = kerfTestDocument();
  const text = writeDxfR12(doc);

  check(
    'has both squares, both tiles and the slot ladder',
    doc.polylines.length === 3 + DEFAULT_KERF_TEST.slotWidths.length,
    `${doc.polylines.length} polylines`,
  );
  check('has exactly one round hole', doc.circles.length === 1);
  check('everything is on the CUT layer', doc.polylines.every((p) => p.layer === LAYER_CUT));
  check('it writes', text.includes('AC1009'));

  // The figure must be uncompensated: that is what makes it a measurement.
  const outer = doc.polylines[0].points;
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    minX = Math.min(minX, outer[i]);
    maxX = Math.max(maxX, outer[i]);
  }
  check(
    'the outer square is exactly nominal, not kerf-compensated',
    near(maxX - minX, DEFAULT_KERF_TEST.outerSize, 1e-12),
  );

  const slotWidths = doc.polylines.slice(3).map((p) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 1; i < p.points.length; i += 2) {
      lo = Math.min(lo, p.points[i]);
      hi = Math.max(hi, p.points[i]);
    }
    return hi - lo;
  });
  check(
    'slot widths match the requested ladder',
    slotWidths.every((w, i) => near(w, DEFAULT_KERF_TEST.slotWidths[i], 1e-12)),
    slotWidths.join(', '),
  );

  const tiles = doc.polylines.slice(0, 3);
  const centres = tiles.map((p) => p.points[0]);
  check('the two tiles do not overlap', Math.abs(centres[2] - centres[0]) >= DEFAULT_KERF_TEST.outerSize);
}

console.log('');
if (failures > 0) {
  console.error(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    rig and export');
