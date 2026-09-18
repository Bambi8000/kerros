/** Authored cubic curves in millimetres. No sampled contour owns these points. */
export type CurvePoint = [number, number];
export interface CurveNode {
  point: CurvePoint;
  /** Handle vectors relative to the anchor. */
  incoming: CurvePoint;
  outgoing: CurvePoint;
  smooth: boolean;
}
export type CurveLoop = CurveNode[];
export interface CurveKey { id: string; z: number; loops: CurveLoop[] }
export interface CurveSketch {
  base: CurveLoop[];
  keys: CurveKey[];
  nextKey: number;
}

export const CURVE_TOLERANCE = 0.02;
const point = (p: CurvePoint): CurvePoint => [p[0], p[1]];
const add = (a: CurvePoint, b: CurvePoint): CurvePoint => [a[0] + b[0], a[1] + b[1]];
const subtract = (a: CurvePoint, b: CurvePoint): CurvePoint => [a[0] - b[0], a[1] - b[1]];
const mix = (a: CurvePoint, b: CurvePoint, t: number): CurvePoint => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const copyCurveLoops = (loops: CurveLoop[]): CurveLoop[] => loops.map(loop => loop.map(node => ({
  point: point(node.point), incoming: point(node.incoming), outgoing: point(node.outgoing), smooth: node.smooth,
})));
export const copyCurveSketch = (sketch: CurveSketch): CurveSketch => ({
  base: copyCurveLoops(sketch.base), nextKey: sketch.nextKey,
  keys: sketch.keys.map(key => ({ ...key, loops: copyCurveLoops(key.loops) })),
});

/** Four cubic arcs; the circle approximation is measured by the validator. */
export function ellipseCurve(cx: number, cy: number, rx: number, ry: number): CurveLoop {
  const k = 4 * (Math.sqrt(2) - 1) / 3;
  return [
    { point: [cx + rx, cy], incoming: [0, -k * ry], outgoing: [0, k * ry], smooth: true },
    { point: [cx, cy + ry], incoming: [k * rx, 0], outgoing: [-k * rx, 0], smooth: true },
    { point: [cx - rx, cy], incoming: [0, k * ry], outgoing: [0, -k * ry], smooth: true },
    { point: [cx, cy - ry], incoming: [-k * rx, 0], outgoing: [k * rx, 0], smooth: true },
  ];
}

function segmentDistance(p: CurvePoint, a: CurvePoint, b: CurvePoint): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], square = dx * dx + dy * dy;
  const t = square ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / square)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Adaptive flattening, including collinear handles that overshoot an anchor. */
export function flattenCurve(loop: CurveLoop, tolerance = CURVE_TOLERANCE): number[] {
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) throw new Error('Curve tolerance must be positive.');
  if (loop.length < 3 || loop.length > 256) throw new Error('A closed curve needs 3–256 points.');
  for (const node of loop) for (const p of [node.point, node.incoming, node.outgoing]) {
    if (!Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v) || Math.abs(v) > 100000))
      throw new Error('Curve coordinates must be finite and within 100,000 mm.');
  }
  const out = [...loop[0].point];
  const visit = (a: CurvePoint, b: CurvePoint, c: CurvePoint, d: CurvePoint, depth: number) => {
    if (out.length > 32768) throw new Error('This curve is too detailed. Reduce its size or point count.');
    if (Math.max(segmentDistance(b, a, d), segmentDistance(c, a, d)) <= tolerance) { out.push(...d); return; }
    if (depth === 20) throw new Error('This curve could not be resolved to the drawing tolerance.');
    const ab = mix(a, b, 0.5), bc = mix(b, c, 0.5), cd = mix(c, d, 0.5);
    const abc = mix(ab, bc, 0.5), bcd = mix(bc, cd, 0.5), centre = mix(abc, bcd, 0.5);
    visit(a, ab, abc, centre, depth + 1); visit(centre, bcd, cd, d, depth + 1);
  };
  loop.forEach((node, i) => {
    const next = loop[(i + 1) % loop.length];
    visit(node.point, add(node.point, node.outgoing), add(next.point, next.incoming), next.point, 0);
  });
  out.splice(-2);
  const xs = out.filter((_, i) => i % 2 === 0), ys = out.filter((_, i) => i % 2 === 1);
  if (Math.max(...xs) - Math.min(...xs) < 0.001 || Math.max(...ys) - Math.min(...ys) < 0.001)
    throw new Error('The closed curve has no usable width or height.');
  return out;
}

export function curveSketchError(sketch: CurveSketch): string | null {
  try {
    if (!Number.isSafeInteger(sketch.nextKey) || sketch.nextKey < 1) throw new Error('The drawing has an invalid key counter.');
    if (!Array.isArray(sketch.base) || !sketch.base.length || sketch.base.length > 32 ||
        !Array.isArray(sketch.keys) || sketch.keys.length > 32) throw new Error('Use 1–32 closed loops and at most 32 morph keys.');
    sketch.base.forEach(loop => flattenCurve(loop));
    const ids = new Set<string>(), heights: number[] = [];
    for (const key of sketch.keys) {
      if (!key.id || ids.has(key.id) || !Number.isFinite(key.z) || Math.abs(key.z) > 100000 || heights.some(z => Math.abs(z - key.z) < 1e-6))
        throw new Error('Morph keys need distinct identities and heights.');
      if (!Array.isArray(key.loops) || !key.loops.length || key.loops.length > 32) throw new Error('Every morph key needs a closed drawing.');
      key.loops.forEach(loop => flattenCurve(loop)); ids.add(key.id); heights.push(key.z);
    }
    return null;
  } catch (error) { return error instanceof Error ? error.message : 'The curve drawing is invalid.'; }
}

/** Moving an anchor carries its handles; moving a smooth handle mirrors its mate. */
export function moveCurveNode(loop: CurveLoop, at: number, part: 'point' | 'incoming' | 'outgoing', to: CurvePoint): CurveLoop {
  const copy = copyCurveLoops([loop])[0], node = copy[at];
  if (!node) return copy;
  if (part === 'point') node.point = point(to);
  else {
    node[part] = subtract(to, node.point);
    if (node.smooth) node[part === 'incoming' ? 'outgoing' : 'incoming'] = [-node[part][0], -node[part][1]];
  }
  return copy;
}

/** Preserve curves exactly; straight edges gain handle-free corners for editing. */
export function splitCurve(loop: CurveLoop, at: number, t = 0.5): CurveLoop {
  const copy = copyCurveLoops([loop])[0], next = (at + 1) % copy.length;
  if (!copy[at] || copy.length >= 256 || !(t > 0 && t < 1)) return copy;
  const a = copy[at].point, b = add(a, copy[at].outgoing), d = copy[next].point, c = add(d, copy[next].incoming);
  const ab = mix(a, b, t), bc = mix(b, c, t), cd = mix(c, d, t), abc = mix(ab, bc, t), bcd = mix(bc, cd, t), centre = mix(abc, bcd, t);
  const chord = subtract(d, a), along = (p: CurvePoint) => (p[0] - a[0]) * chord[0] + (p[1] - a[1]) * chord[1];
  // Includes straight segments subdivided by older versions. Never collapse
  // collinear handles that leave the segment or reverse their control order.
  if (segmentDistance(b, a, d) <= 1e-10 && segmentDistance(c, a, d) <= 1e-10 && along(b) <= along(c)) {
    copy[at].outgoing = [0, 0]; copy[next].incoming = [0, 0];
    copy[at].smooth = false; copy[next].smooth = false;
    copy.splice(at + 1, 0, { point: centre, incoming: [0, 0], outgoing: [0, 0], smooth: false });
    return copy;
  }
  copy[at].outgoing = subtract(ab, a); copy[next].incoming = subtract(cd, d);
  copy.splice(at + 1, 0, { point: centre, incoming: subtract(abc, centre), outgoing: subtract(bcd, centre), smooth: true });
  return copy;
}

export function curveNodeMode(loop: CurveLoop, at: number, smooth: boolean): CurveLoop {
  const copy = copyCurveLoops([loop])[0], node = copy[at];
  if (!node) return copy;
  node.smooth = smooth;
  if (!smooth) { node.incoming = [0, 0]; node.outgoing = [0, 0]; }
  else {
    const prev = copy[(at + copy.length - 1) % copy.length].point, next = copy[(at + 1) % copy.length].point;
    const dx = next[0] - prev[0], dy = next[1] - prev[1], span = Math.hypot(dx, dy) || 1;
    const length = Math.min(Math.hypot(...subtract(node.point, prev)), Math.hypot(...subtract(next, node.point))) / 3;
    node.outgoing = [dx * length / span, dy * length / span]; node.incoming = [-node.outgoing[0], -node.outgoing[1]];
  }
  return copy;
}

/** Straighten only this edge, preserving the neighbouring curves and anchors. */
export function straightenCurveSegment(loop: CurveLoop, at: number): CurveLoop {
  const copy = copyCurveLoops([loop])[0], next = (at + 1) % copy.length;
  if (!copy[at] || !copy[next] || copy.length < 2) return copy;
  copy[at].outgoing = [0, 0]; copy[next].incoming = [0, 0];
  copy[at].smooth = false; copy[next].smooth = false;
  return copy;
}

/** Constrain a new line endpoint to the nearer horizontal or vertical axis. */
export function alignCurvePoint(from: CurvePoint, to: CurvePoint): CurvePoint {
  return Math.abs(to[0] - from[0]) >= Math.abs(to[1] - from[1]) ? [to[0], from[1]] : [from[0], to[1]];
}

/** Reshape the authored geometry; the distance field itself is never scaled. */
export function resizeCurveLoops(loops: CurveLoop[], width: number, height: number): CurveLoop[] {
  const bounds = curveBounds(loops), sx = Math.max(width, 0.1) / bounds.width, sy = Math.max(height, 0.1) / bounds.height;
  return loops.map(loop => loop.map(node => ({ ...node,
    point: [bounds.cx + (node.point[0] - bounds.cx) * sx, bounds.cy + (node.point[1] - bounds.cy) * sy],
    incoming: [node.incoming[0] * sx, node.incoming[1] * sy], outgoing: [node.outgoing[0] * sx, node.outgoing[1] * sy],
  })));
}

export function curveBounds(loops: CurveLoop[]) {
  if (!loops.length) throw new Error('The drawing has no closed loops.');
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const loop of loops) {
    const values = flattenCurve(loop);
    for (let i = 0; i < values.length; i += 2) {
      minX = Math.min(minX, values[i]); maxX = Math.max(maxX, values[i]);
      minY = Math.min(minY, values[i + 1]); maxY = Math.max(maxY, values[i + 1]);
    }
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/** Include every saved key in the slab; reducing height cannot silently clip one. */
export function curveHeight(sketch: CurveSketch, height: number): number {
  return Math.max(0.5, Number.isFinite(height) ? height : 100, ...sketch.keys.map(key => 2 * Math.abs(key.z) + 0.5));
}
