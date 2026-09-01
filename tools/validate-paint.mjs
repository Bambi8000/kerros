#!/usr/bin/env node
/**
 * validate-paint.mjs
 *
 * Imports the REAL src/core/paint.ts. A stroke that lands on the wrong sheet is
 * an edit somebody made appearing where they did not make it, which is worse
 * than one that does nothing.
 */

import {
  strokeHeight,
  strokeDistance,
  strokesDistance,
  strokesBounds,
  strokesByPlane,
  paintDistance,
} from '../src/core/paint.ts';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

const dot = { points: [10, 20, 45], radius: 4 };
const line = { points: [0, 0, 45, 60, 0, 45], radius: 5 };

console.log('paint: a stroke in plan');
{
  check('a stroke knows the height it was drawn at', strokeHeight(dot) === 45);
  check('and an empty one does not throw', strokeHeight({ points: [], radius: 1 }) === 0);

  check('one point is a disc', near(strokeDistance(dot, 10, 20), -4));
  check('its edge is the surface', near(strokeDistance(dot, 14, 20), 0));
  check('and outside is the exact distance', near(strokeDistance(dot, 20, 20), 6));

  check('along a line it is the radius in', near(strokeDistance(line, 30, 0), -5));
  check('across it, the exact distance', near(strokeDistance(line, 30, 12), 7));
  check('past the end it is round', near(strokeDistance(line, 68, 0), 3));
  check('and the corner past the end is the diagonal', near(strokeDistance(line, 63, 4), Math.hypot(3, 4) - 5));
  check('the radius is clamped, never zero', Number.isFinite(strokeDistance({ points: [0, 0, 0], radius: 0 }, 0, 0)));
  check('a stroke with no points is far away', strokeDistance({ points: [], radius: 4 }, 0, 0) > 1000);

  check('the nearest of several wins', near(strokesDistance([dot, line], 30, 0), -5));
  check('and none of them is far away', strokesDistance([], 0, 0) > 1000);
}

console.log('paint: the box the grid has to hold');
{
  /*
   * Additive strokes set bounds, which is the fifth time this program has had
   * to say so: material painted past the rim is cut off by the sampling grid
   * unless the grid is told to hold it.
   */
  const box = strokesBounds([dot]);
  check('the box is the stroke plus its radius', near(box.minX, 6) && near(box.maxX, 14));
  check('in both axes', near(box.minY, 16) && near(box.maxY, 24));
  check('several strokes make one box', (() => {
    const b = strokesBounds([dot, line]);
    return near(b.minX, -5) && near(b.maxX, 65);
  })());
  check('nothing to bound is null, not a box at the origin', strokesBounds([]) === null);
}

console.log('paint: which sheet a stroke belongs to');
{
  /*
   * Anchored to a height rather than a sheet number. Hand-removed pins and
   * hand-set twists key on the layer number and stop meaning what they meant
   * the moment the thickness changes; a stroke keys on the millimetre it was
   * drawn at.
   */
  const planes = [0, 10, 20, 30, 40];
  const planeAt = (z) => {
    const i = Math.round(z / 10);
    return i >= 0 && i < planes.length ? i : null;
  };

  const grouped = strokesByPlane([{ ...dot, points: [10, 20, 21] }, { ...line, points: [0, 0, 9, 60, 0, 9] }], planeAt);
  check('a stroke lands on the plane its height falls in', grouped.get(2)?.length === 1);
  check('and another on its own', grouped.get(1)?.length === 1);
  check('two on one plane share it', strokesByPlane([dot, { ...dot, points: [0, 0, 44] }], (z) => (z > 40 ? 4 : null)).get(4).length === 2);

  /*
   * A stroke outside the stack is dropped, not clamped to an end: clamping
   * would silently move somebody's edit onto a sheet they never drew on.
   */
  check('a stroke above the stack is dropped', strokesByPlane([{ ...dot, points: [10, 20, 900] }], planeAt).size === 0);
  check('and one below it too', strokesByPlane([{ ...dot, points: [10, 20, -900] }], planeAt).size === 0);
  check('an empty stroke is skipped', strokesByPlane([{ points: [], radius: 3 }], planeAt).size === 0);
}

console.log('paint: confined to its own sheet');
{
  const mid = 45;
  const half = 4.5;

  check('at the middle of the band it is the plan distance', near(paintDistance([dot], 10, 20, mid, mid, half), -4));
  check('at the band edge it is the surface', near(paintDistance([dot], 10, 20, mid + half, mid, half), 0));
  check('above the band it is the height above', near(paintDistance([dot], 10, 20, mid + half + 6, mid, half), 6));
  check('below it likewise', near(paintDistance([dot], 10, 20, mid - half - 3, mid, half), 3));
  check(
    'and past a corner it is the diagonal',
    near(paintDistance([dot], 18, 20, mid + half + 6, mid, half), Math.hypot(4, 6)),
  );

  /*
   * The point of confining it: a stroke on one sheet must not reach the next.
   * Two sheets a pitch apart, and a stroke drawn on the lower one reads as
   * empty at the upper one's own mid-plane.
   */
  check('a stroke does not reach the next sheet', paintDistance([dot], 10, 20, mid + 9, mid, half) > 0);

  /*
   * The gradient, because a stroke is unioned into the form and a smooth blend
   * only means what it says over a true distance field.
   */
  let worst = 0;
  for (let i = 0; i < 3000; i++) {
    const x = Math.sin(i * 1.1) * 40 + 10;
    const y = Math.cos(i * 1.7) * 40 + 20;
    const z = Math.sin(i * 2.3) * 20 + mid;
    const e = 1e-5;
    const at = (a, b, c) => paintDistance([dot], a, b, c, mid, half);
    const g = Math.hypot(
      (at(x + e, y, z) - at(x - e, y, z)) / (2 * e),
      (at(x, y + e, z) - at(x, y - e, z)) / (2 * e),
      (at(x, y, z + e) - at(x, y, z - e)) / (2 * e),
    );
    if (Number.isFinite(g) && g > 0.5) worst = Math.max(worst, Math.abs(g - 1));
  }
  check('the gradient is unit where it should be', worst < 0.02, `off by ${worst.toFixed(4)}`);
}

console.log('');
if (failures > 0) { console.log(`FAIL  ${failures} check(s) failed`); process.exit(1); }
console.log('OK    paint');
