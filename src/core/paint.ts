/**
 * Kerros layer paint.
 *
 * A brush stroke that edits **one sheet**, drawn in the slice view at true
 * scale with its neighbours visible. The thing a person actually wants when
 * they say "this layer needs to come out a bit here".
 *
 * IT IS A STROKE, NOT A DRAGGED VERTEX, and that was decided before any of this
 * was written. A contour vertex is produced by the field and has no identity
 * that survives the form changing: nudge the sphere a millimetre and every
 * vertex is somewhere else by a different amount, so there is nothing to store.
 * A stroke is a thing a person made, and it survives.
 *
 * ANCHORED TO A HEIGHT, NOT TO A SHEET NUMBER. Hand-removed pins and hand-set
 * twists key on the layer number and stop meaning what they meant the moment
 * the material thickness changes. A stroke keys on the millimetre it was drawn
 * at, so it stays where it was put and lands on whichever sheet is there.
 *
 * ONE PITCH TALL, like a per-layer window. The field stays a field: continuous
 * within a layer, stepping between layers, which is exactly what a stack of
 * separately cut sheets does.
 *
 * DELIBERATE CONSTRAINT: no imports. Node validators load this as the real
 * module.
 */

/**
 * A stroke, stored as a sculpt stroke is: flat `[x, y, z, ...]` with a radius.
 *
 * The same shape on purpose. A paint stroke is a sculpt stroke whose z never
 * changes, so the project file already knows how to write it, the parser
 * already knows how to be careful with it, and neither had to learn a second
 * kind of bulk data.
 */
export interface PaintStroke {
  points: number[];
  radius: number;
}

/** The height a stroke was drawn at. Its first point's z; the rest match. */
export function strokeHeight(stroke: PaintStroke): number {
  return stroke.points.length >= 3 ? stroke.points[2] : 0;
}

/**
 * Distance to a stroke in plan, negative inside.
 *
 * Distance to the polyline minus the radius, which is exact — no beading along
 * the length, and a single point is simply a disc. The same arithmetic sculpt
 * strokes use, in two dimensions instead of three.
 */
export function strokeDistance(stroke: PaintStroke, x: number, y: number): number {
  const p = stroke.points;
  const count = p.length / 3;
  if (count === 0) return 1e5;

  const r = Math.max(stroke.radius, 0.01);
  if (count === 1) return Math.hypot(x - p[0], y - p[1]) - r;

  let best = Infinity;
  for (let i = 0; i + 1 < count; i++) {
    const ax = p[i * 3];
    const ay = p[i * 3 + 1];
    const ex = p[(i + 1) * 3] - ax;
    const ey = p[(i + 1) * 3 + 1] - ay;
    const len2 = ex * ex + ey * ey;
    let t = len2 === 0 ? 0 : ((x - ax) * ex + (y - ay) * ey) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (ax + ex * t);
    const dy = y - (ay + ey * t);
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return Math.sqrt(best) - r;
}

/** Nearest of a set of strokes. */
export function strokesDistance(strokes: PaintStroke[], x: number, y: number): number {
  let best = 1e5;
  for (const stroke of strokes) {
    const d = strokeDistance(stroke, x, y);
    if (d < best) best = d;
  }
  return best;
}

/**
 * The box a set of strokes needs, in plan.
 *
 * **Additive strokes set bounds**, and this is the fifth time that has had to be
 * said in this program: material put outside the base shape is cut off by the
 * sampling grid unless the grid is told to hold it. A stroke painted past the
 * rim is exactly that case.
 */
export function strokesBounds(
  strokes: PaintStroke[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const stroke of strokes) {
    const r = Math.max(stroke.radius, 0.01);
    for (let i = 0; i + 2 < stroke.points.length; i += 3) {
      minX = Math.min(minX, stroke.points[i] - r);
      maxX = Math.max(maxX, stroke.points[i] + r);
      minY = Math.min(minY, stroke.points[i + 1] - r);
      maxY = Math.max(maxY, stroke.points[i + 1] + r);
    }
  }

  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Which strokes belong to which plane, by the height they were drawn at.
 *
 * `planeAt` answers "which plane is this height in", which the caller owns
 * because it is the one holding the layer plan — this module may not import it,
 * and duplicating a binary search is duplicating logic rather than a shape.
 *
 * A stroke whose height falls outside the stack is dropped rather than clamped
 * to an end: clamping would silently move somebody's edit onto a sheet they
 * never drew on.
 */
export function strokesByPlane(
  strokes: PaintStroke[],
  planeAt: (z: number) => number | null,
): Map<number, PaintStroke[]> {
  const out = new Map<number, PaintStroke[]>();
  for (const stroke of strokes) {
    if (stroke.points.length < 3) continue;
    const plane = planeAt(strokeHeight(stroke));
    if (plane === null) continue;
    const list = out.get(plane);
    if (list) list.push(stroke);
    else out.set(plane, [stroke]);
  }
  return out;
}

/**
 * A stroke's contribution at a point, confined to its layer's band.
 *
 * `mid` and `halfPitch` describe the band the sheet owns — one pitch tall,
 * centred on the plane the slice is sampled at, so the stroke reaches the whole
 * sheet and nothing above or below it.
 */
export function paintDistance(
  strokes: PaintStroke[],
  x: number,
  y: number,
  z: number,
  mid: number,
  halfPitch: number,
): number {
  const plan = strokesDistance(strokes, x, y);
  const slab = Math.max(z - (mid + halfPitch), mid - halfPitch - z);
  // Extruded exactly: inside both, the nearer face; outside, the corner.
  return Math.min(Math.max(plan, slab), 0) + Math.hypot(Math.max(plan, 0), Math.max(slab, 0));
}
