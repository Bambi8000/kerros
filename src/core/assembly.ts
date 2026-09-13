/** Upright sheet assemblies. Pure geometry; collaborators are supplied by the pipeline. */
import type { Feature } from './types.ts';
import type { Bounds, Contour, Slice, SliceSet } from './slice.ts';

export type Vec3 = [number, number, number];
export type Box2 = { minX: number; minY: number; maxX: number; maxY: number };
type Distance = (x: number, y: number) => number;
type Part = NonNullable<Slice['part']>;
type Issue = NonNullable<SliceSet['assembly']>['issues'][number];
export interface AssemblyKernel {
  trace: (sample: Distance, box: Box2, step: number, iso?: number, tolerance?: number) => Contour[];
  distance: (contours: Contour[], reach: number) => Distance;
  thin: (slice: Slice, threshold: number) => boolean;
}
export interface AssemblyOptions {
  thickness: number; kerf: number; materialName?: string;
  resolution: number; tolerance: number; minFeature: number;
}
interface WorkPart {
  meta: Part; box: Box2; source: Distance; field: Distance;
  zones: { field: Distance; box: Box2 }[];
  step: number;
}
const TAU = Math.PI * 2;
export const assemblyNumber = (f: Feature, key: string, fallback = 0): number => {
  const value = f.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};
const num = assemblyNumber;
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mul3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function unit3(a: Vec3): Vec3 { return mul3(a, 1 / Math.max(Math.hypot(...a), 1e-12)); }
export function sheetWorld(part: Pick<Part, 'origin' | 'u' | 'v' | 'n'>, x: number, y: number, z = 0): Vec3 {
  return add3(part.origin, add3(mul3(part.u, x), add3(mul3(part.v, y), mul3(part.n, z))));
}
export function sheetLocal(part: Pick<Part, 'origin' | 'u' | 'v' | 'n'>, point: Vec3): Vec3 {
  const d = add3(point, mul3(part.origin, -1));
  return [dot3(d, part.u), dot3(d, part.v), dot3(d, part.n)];
}
const rotateZ = (v: Vec3, angle: number): Vec3 => [v[0] * Math.cos(angle) - v[1] * Math.sin(angle), v[0] * Math.sin(angle) + v[1] * Math.cos(angle), v[2]];
/** The channel section and route share this basis in both cuts and gizmo edits. */
export function channelFrame(yaw: number, elevation: number, roll: number) {
  yaw *= Math.PI / 180; elevation *= Math.PI / 180; roll *= Math.PI / 180;
  const direction: Vec3 = [Math.cos(yaw) * Math.cos(elevation), Math.sin(yaw) * Math.cos(elevation), Math.sin(elevation)];
  const baseA = unit3(cross3(Math.abs(direction[2]) > 0.95 ? [0, 1, 0] : [0, 0, 1], direction));
  const baseB = cross3(direction, baseA);
  return { direction, u: add3(mul3(baseA, Math.cos(roll)), mul3(baseB, Math.sin(roll))), v: add3(mul3(baseA, -Math.sin(roll)), mul3(baseB, Math.cos(roll))) };
}
/** Recover assembly-local angles from the complete world-space section basis. */
export function channelAngles(worldU: Vec3, worldV: Vec3, layoutAngle: number) {
  const u = rotateZ(worldU, -layoutAngle * Math.PI / 180), v = rotateZ(worldV, -layoutAngle * Math.PI / 180);
  const d = unit3(cross3(u, v));
  const horizontal = Math.hypot(d[0], d[1]);
  const yaw = horizontal < 1e-12 ? 0 : Math.atan2(d[1], d[0]) * 180 / Math.PI;
  const elevation = Math.atan2(d[2], horizontal) * 180 / Math.PI;
  const base = channelFrame(yaw, elevation, 0);
  const roll = Math.atan2(dot3(u, base.v), dot3(u, base.u)) * 180 / Math.PI;
  return { yaw, elevation, roll };
}
export function rectDistance(x: number, y: number, cx: number, cy: number, w: number, h: number, r = 0): number {
  r = Math.min(r, w / 2, h / 2);
  const dx = Math.abs(x - cx) - w / 2 + r, dy = Math.abs(y - cy) - h / 2 + r;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}
const rect = (x0: number, y0: number, x1: number, y1: number): Distance =>
  (x, y) => rectDistance(x, y, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0);
function subtract(part: WorkPart, cut: Distance) {
  const before = part.field; part.field = (x, y) => Math.max(before(x, y), -cut(x, y));
}
function unite(part: WorkPart, tab: Distance) {
  const before = part.field; part.field = (x, y) => Math.min(before(x, y), tab(x, y));
}
function polyBox(points: number[]): Box2 {
  const xs = points.filter((_, i) => i % 2 === 0), ys = points.filter((_, i) => i % 2 === 1);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}
/** Convex hull of a projected prism, including its slab-clipped edges. */
export function convexHull(points: number[][]): number[] {
  const sorted = points.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 1e-8);
  if (sorted.length < 3) return [];
  const half = (list: number[][]) => {
    const out: number[][] = [];
    for (const p of list) {
      while (out.length >= 2) {
        const a = out[out.length - 2], b = out[out.length - 1];
        if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) > 1e-9) break;
        out.pop();
      }
      out.push(p);
    }
    out.pop(); return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())].flat();
}
export function prismOpening(part: Part, start: Vec3, end: Vec3, a: Vec3, b: Vec3, section: number[]): number[] {
  const count = section.length / 2;
  const vertices = [start, end].flatMap((centre) => Array.from({ length: count }, (_, i) =>
    sheetLocal(part, add3(centre, add3(mul3(a, section[2 * i]), mul3(b, section[2 * i + 1]))))));
  const points: number[][] = [];
  const half = part.thickness / 2;
  for (const p of vertices) if (Math.abs(p[2]) <= half + 1e-8) points.push(p.slice(0, 2));
  const edge = (p: Vec3, q: Vec3) => {
    if (Math.abs(p[2] - q[2]) < 1e-10) return;
    for (const z of [-half, half]) {
      const t = (z - p[2]) / (q[2] - p[2]);
      if (t >= 0 && t <= 1) points.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  };
  for (let i = 0; i < count; i++) {
    edge(vertices[i], vertices[(i + 1) % count]);
    edge(vertices[count + i], vertices[count + (i + 1) % count]);
    edge(vertices[i], vertices[count + i]);
  }
  return convexHull(points);
}
function polygonDistance(points: number[], kernel: AssemblyKernel, reach: number): Distance {
  return kernel.distance([{ points, area: 1, isHole: false }], reach);
}
function samples(box: Box2, spacing: number, visit: (x: number, y: number) => boolean): boolean {
  const nx = Math.max(1, Math.ceil((box.maxX - box.minX) / spacing));
  const ny = Math.max(1, Math.ceil((box.maxY - box.minY) / spacing));
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    if (visit(box.minX + (box.maxX - box.minX) * i / nx, box.minY + (box.maxY - box.minY) * j / ny)) return true;
  }
  return false;
}
function overlaps(part: WorkPart, field: Distance, box: Box2): boolean {
  const common = { minX: Math.max(part.box.minX, box.minX), minY: Math.max(part.box.minY, box.minY), maxX: Math.min(part.box.maxX, box.maxX), maxY: Math.min(part.box.maxY, box.maxY) };
  if (common.minX > common.maxX || common.minY > common.maxY) return false;
  return samples(common, Math.max(part.step, 0.35), (x, y) => part.field(x, y) < -0.01 && field(x, y) < -0.01);
}
function boundaryFits(points: number[], part: WorkPart, margin: number): boolean {
  for (let i = 0; i < points.length; i += 2) {
    const j = (i + 2) % points.length;
    const count = Math.max(1, Math.ceil(Math.hypot(points[j] - points[i], points[j + 1] - points[i + 1]) / part.step));
    for (let k = 0; k <= count; k++) {
      const t = k / count;
      if (part.field(points[i] + (points[j] - points[i]) * t, points[i + 1] + (points[j + 1] - points[i + 1]) * t) > -margin) return false;
    }
  }
  return true;
}
function contourBox(contours: Contour[]): Box2 { return polyBox(contours.flatMap((c) => c.points)); }

/** Two tabs in the longest continuous shoulder band, inset from its ends. */
function followingTabs(rib: WorkPart, shoulder: number, padding: number, tabH: number, bridge: number): number[] {
  const count = Math.max(1, Math.ceil((rib.box.maxY - rib.box.minY) / rib.step));
  let start: number | undefined, best: [number, number] | undefined;
  for (let i = 0; i <= count + 1; i++) {
    const z = rib.box.minY + (rib.box.maxY - rib.box.minY) * i / count;
    if (i <= count && rib.source(shoulder + bridge, z) <= -bridge / 2) start ??= z;
    else if (start !== undefined) {
      const end = z - (rib.box.maxY - rib.box.minY) / count;
      if (!best || end - start > best[1] - best[0]) best = [start, end];
      start = undefined;
    }
  }
  return best && best[1] - best[0] >= 2 * padding + 2 * tabH ? [best[0] + padding, best[1] - padding] : [];
}

/** One active layout. Disabled layouts leave the legacy layer workflow intact. */
export function activeAssembly(features: Feature[]): Feature | undefined {
  return features.find((f) => f.enabled && f.kind === 'assembly:layout');
}

export function buildAssembly(
  features: Feature[], sample: (x: number, y: number, z: number) => number,
  bounds: Bounds, options: AssemblyOptions, kernel: AssemblyKernel,
): SliceSet {
  const layout = activeAssembly(features)!;
  const children = features.filter((f) => f.params.groupId === layout.id);
  const issues: Issue[] = [], joints: NonNullable<SliceSet['assembly']>['joints'] = [];
  const channels: NonNullable<SliceSet['assembly']>['channels'] = [];
  const say = (severity: Issue['severity'], ids: string[], message: string) => issues.push({ severity, ids, message });
  const radial = layout.params.layout !== 'linear';
  const centre: Vec3 = bounds.min.map((v, i) => (v + bounds.max[i]) / 2) as Vec3;
  const radius = Math.max(bounds.max[0] - centre[0], bounds.max[1] - centre[1]);
  const height = bounds.max[2] - bounds.min[2];
  const reach = Math.max(radius * 3, height * 2, 100);
  const parts: WorkPart[] = [];
  const stockT = Math.max(options.thickness, 0.2);
  const minBridge = Math.max(options.minFeature, 0.2, 2 * options.kerf, ...children.filter((f) => f.enabled && f.params.ownMaterial === true).map((f) => 2 * num(f, 'kerf', options.kerf)));
  const makePart = (f: Feature, kind: Part['kind'], origin: Vec3, u: Vec3, v: Vec3, box: Box2, source: Distance): WorkPart => {
    const own = f.params.ownMaterial === true;
    if (own && (num(f, 'thickness', stockT) < 0.2 || num(f, 'kerf', options.kerf) < 0)) say('error', [f.id], 'Stock thickness must be at least 0.2 mm and kerf cannot be negative. The preview uses the minimum values.');
    const thickness = own ? Math.max(0.2, num(f, 'thickness', stockT)) : stockT;
    const kerf = own ? Math.max(0, num(f, 'kerf', options.kerf)) : options.kerf;
    const name = own ? String(f.params.materialName || 'Custom stock') : options.materialName || 'Stock';
    const span = Math.max(box.maxX - box.minX, box.maxY - box.minY, 1);
    const step = Math.max(span / 1400, Math.min(span / Math.max(120, options.resolution), Math.min(thickness, stockT, minBridge * 2) / 4));
    const part: WorkPart = { meta: { id: f.id, label: `${kind === 'rib' ? 'R' : kind === 'support' ? 'S' : 'B'}${f.id.slice(1)}`, kind, origin, u, v, n: cross3(u, v), thickness, kerf, material: `${name} / ${thickness} mm / kerf ${kerf} mm` }, box, source, field: source, zones: [], step };
    parts.push(part); return part;
  };
  if (num(layout, 'jointClearance', 0.1) < 0 || (radial && (num(layout, 'ribDepth', 25) <= 0 || num(layout, 'innerRadius') < 0))) say('error', [layout.id], 'Joint clearance and centre radius cannot be negative; rib depth must be positive.');
  if (features.filter((f) => f.kind === 'assembly:layout' && f.enabled).length > 1) say('error', [layout.id], 'Only one assembly layout can be active. Disable the other layout.');
  const incompatible = features.filter((f) => f.enabled && !f.kind.startsWith('assembly:') && f.stage !== 'SHAPE' && f.stage !== 'CARVE');
  if (incompatible.length) say('warning', incompatible.map((f) => f.id), 'Horizontal-layer tools are not applied to upright parts. Disable the assembly to edit their original layers.');
  for (const f of children.filter((f) => f.enabled && f.kind === 'assembly:rib')) {
    const sourceAngle = num(f, 'sourceAngle') * Math.PI / 180;
    const baseU: Vec3 = radial ? [Math.cos(sourceAngle), Math.sin(sourceAngle), 0] : [0, 1, 0];
    const pivot = radial ? num(layout, 'pivotRadius', radius * 0.7) : 0;
    const station = num(f, 'station');
    const src: Vec3 = radial ? add3(centre, mul3(baseU, pivot)) : add3(centre, [num(f, 'sourceX'), 0, 0]);
    const angle = (num(layout, 'ribAngle') + num(f, 'angle')) * Math.PI / 180;
    const origin: Vec3 = radial ? mul3(baseU, pivot) : [station * num(layout, 'spacing', 12), 0, 0];
    origin[0] += num(f, 'px'); origin[1] += num(f, 'py'); origin[2] = num(f, 'pz');
    const box: Box2 = { minX: radial ? -pivot : -radius, maxX: radial ? radius * 1.45 - pivot : radius, minY: -height / 2, maxY: height / 2 };
    const raw: Distance = (x, y) => {
      const p = add3(src, add3(mul3(baseU, x), [0, 0, y]));
      const d = sample(...p);
      return radial ? Math.max(d, -d - Math.max(1, num(layout, 'ribDepth', 25)), num(layout, 'innerRadius', radius * 0.38) - x - pivot) : d;
    };
    const sourceContours = kernel.trace(raw, box, Math.max(height, radius * 2) / Math.max(160, options.resolution), 0, options.tolerance);
    if (!sourceContours.length) { say('error', [f.id], 'The source plane contains no rib. Move its source station or change the source form.'); continue; }
    makePart(f, 'rib', origin, rotateZ(baseU, angle), [0, 0, 1], contourBox(sourceContours), kernel.distance(sourceContours, reach));
  }
  if (!parts.length) say('error', [layout.id], 'No enabled ribs intersect the source form. Add a rib or adjust the source planes.');
  for (const f of children.filter((f) => f.enabled && f.kind === 'assembly:support')) {
    const outer = num(f, 'outerDiameter', radius * 1.8) / 2, inner = num(f, 'innerDiameter', radius * 1.2) / 2;
    if (!(outer > inner + minBridge) || inner < 0) { say('error', [f.id], 'The support needs a positive outer diameter and a remaining ring wider than the minimum bridge.'); continue; }
    const source: Distance = (x, y) => Math.max(Math.hypot(x, y) - outer, inner > 0 ? inner - Math.hypot(x, y) : -Infinity);
    makePart(f, 'support', [num(f, 'px'), num(f, 'py'), num(f, 'pz')], [1, 0, 0], [0, 1, 0], { minX: -outer, minY: -outer, maxX: outer, maxY: outer }, source);
  }
  for (const f of children.filter((f) => f.enabled && f.kind === 'assembly:backplate')) {
    const w = num(f, 'width', radius * 2), h = num(f, 'height', height), z = num(f, 'pz');
    if (f.params.outline !== 'frame' && !(w > 2 * minBridge && h > 2 * minBridge)) { say('error', [f.id], 'The backplate width and height must exceed two minimum bridges.'); continue; }
    const t = f.params.ownMaterial === true ? Math.max(0.2, num(f, 'thickness', stockT)) : stockT;
    const back = makePart(f, 'backplate', [num(f, 'px'), num(f, 'py') - t / 2, z], [1, 0, 0], [0, 0, 1], { minX: -w / 2, maxX: w / 2, minY: -h / 2, maxY: h / 2 }, (x, y) => rectDistance(x, y, 0, 0, w, h, num(f, 'cornerRadius', 3)));
    back.meta.wallOffset = num(f, 'wallOffset');
  }

  const ribs = parts.filter((p) => p.meta.kind === 'rib');
  const supports = parts.filter((p) => p.meta.kind === 'support');
  const backs = parts.filter((p) => p.meta.kind === 'backplate');
  const fit = Math.max(0, num(layout, 'jointClearance', 0.1));
  // A rib enters every ring along -U. The rib's notch opens toward -U;
  // the ring's complementary notch opens toward +U. All rings stay fixed.
  for (const rib of ribs) {
    for (const support of supports) {
      const z = support.meta.origin[2] - rib.meta.origin[2];
      const along = (u: number) => sheetLocal(support.meta, sheetWorld(rib.meta, u, z));
      const x0 = rib.box.minX, x1 = rib.box.maxX;
      const hits: number[] = [];
      for (let x = x0; x <= x1; x += rib.step / 2) {
        const q = along(x);
        if (rib.source(x, z) < -minBridge / 2 && support.source(q[0], q[1]) < -minBridge / 2) hits.push(x);
      }
      if (hits.length < 2 || hits.at(-1)! - hits[0] < Math.max(2 * minBridge, stockT)) {
        say('error', [rib.meta.id, support.meta.id], 'No usable cross-slot contact. Resize or move the support, or move the rib.'); continue;
      }
      const lo = hits[0], hi = hits.at(-1)!, mid = (lo + hi) / 2;
      if (hits.some((x, i) => i > 0 && x - hits[i - 1] > rib.step)) {
        say('error', [rib.meta.id, support.meta.id], 'This support crosses the rib in separate regions; a single straight insertion cannot be resolved.'); continue;
      }
      const slotH = support.meta.thickness + fit * 2;
      const ribCut = rect(rib.box.minX - reach, z - slotH / 2, mid + fit, z + slotH / 2);
      subtract(rib, ribCut);
      const ringCut: Distance = (x, y) => {
        const p = sheetLocal(rib.meta, sheetWorld(support.meta, x, y));
        return Math.max(mid - fit - p[0], Math.abs(p[2]) - rib.meta.thickness / 2 - fit);
      };
      subtract(support, ringCut);
      rib.zones.push({ field: rect(lo, z - slotH, hi, z + slotH), box: { minX: lo, maxX: hi, minY: z - slotH, maxY: z + slotH } });
      support.zones.push({ field: (x, y) => { const p = sheetLocal(rib.meta, sheetWorld(support.meta, x, y)); return rectDistance(p[0], p[2], mid, 0, hi - lo, rib.meta.thickness + fit * 2); }, box: support.box });
      joints.push({ id: `${rib.meta.id}:${support.meta.id}`, parts: [rib.meta.id, support.meta.id], instruction: `Hold ${support.meta.label} in place; slide ${rib.meta.label} along its negative U direction into the complementary half slots. Install all supports before the ribs.` });
    }
  }

  // Each wall joint trims the rib to the front face and adds two tabs. The
  // slot in the backplate is the projection of the complete tab prism through
  // the backplate slab: both thicknesses contribute at an oblique angle.
  if (backs.length > 1) say('error', backs.map((p) => p.meta.id), 'Use one backplate per assembly; multiple-wall insertion is not resolved.');
  if (backs.length && supports.length) say('error', [...backs, ...supports].map((p) => p.meta.id), 'Wall tabs and ring slots require different insertion paths. Use one support system per assembly.');
  for (const back of backs) {
    const f = children.find((f) => f.id === back.meta.id)!;
    const follows = f.params.outline === 'frame';
    const front = back.meta.origin[1] + back.meta.thickness / 2;
    const tabH = Math.max(2, num(f, 'tabHeight', 12));
    const tabGap = Math.max(tabH * 2, num(f, 'tabSpacing', height * 0.45));
    const frameWidth = num(f, 'frameWidth', tabH + 6), inset = num(f, 'profileInset', 4);
    if (follows && (frameWidth <= tabH + fit * 2 + minBridge * 2 || inset < 0)) {
      say('error', [f.id], 'Frame width must leave material on both sides of a tab slot; increase it above tab height plus two clearances and two minimum bridges. Profile inset cannot be negative.');
      parts.splice(parts.indexOf(back), 1); continue;
    }
    const plans = ribs.flatMap((rib) => {
      const uy = rib.meta.u[1];
      if (uy < 0.25) { say('error', [rib.meta.id, back.meta.id], 'The rib must face away from the wall and cross it at 15 degrees or more. Flip or rotate this rib.'); return []; }
      const faceU = (front - rib.meta.origin[1]) / uy;
      // Both stock thicknesses contribute to the shoulder and projected slot.
      const shoulder = faceU + Math.abs(rib.meta.n[1]) * rib.meta.thickness / (2 * uy);
      const protrusion = Math.max(0, num(f, 'tabProtrusion', 0));
      const backU = faceU - (back.meta.thickness + protrusion + Math.abs(rib.meta.n[1]) * rib.meta.thickness / 2) / uy;
      const tabZ = follows ? followingTabs(rib, shoulder, frameWidth / 2 + inset, tabH, minBridge)
        : [-tabGap / 2, tabGap / 2].map((z) => z + back.meta.origin[2] - rib.meta.origin[2]);
      if (!tabZ.length) say('error', [rib.meta.id, back.meta.id], 'No continuous shoulder band fits two frame tabs. Reduce frame width, profile inset or tab height, or change the rib profile.');
      const openings = tabZ.map((z) => prismOpening(back.meta, sheetWorld(rib.meta, backU, z), sheetWorld(rib.meta, shoulder + minBridge, z), rib.meta.n, rib.meta.v, [-rib.meta.thickness / 2 - fit, -tabH / 2 - fit, rib.meta.thickness / 2 + fit, -tabH / 2 - fit, rib.meta.thickness / 2 + fit, tabH / 2 + fit, -rib.meta.thickness / 2 - fit, tabH / 2 + fit]));
      return [{ rib, shoulder, backU, tabZ, openings }];
    });
    let upper: number[][] = [];
    if (follows) {
      const pairs = plans.filter((p) => p.openings.length === 2 && p.openings.every((o) => o.length)).map((p) => p.openings.map((o) => {
        const box = polyBox(o);
        // X/Z offset moves the outline; the mating cuts remain at the ribs.
        return [(box.minX + box.maxX) / 2 + back.meta.origin[0], (box.minY + box.maxY) / 2 + back.meta.origin[2]];
      })).sort((a, b) => a[0][0] - b[0][0]);
      if (pairs.length < 2 || pairs.at(-1)![0][0] - pairs[0][0][0] <= frameWidth) {
        say('error', [f.id], 'An open frame needs at least two usable ribs spread wider than its frame width. Separate the ribs or use a solid rectangle.');
        parts.splice(parts.indexOf(back), 1); continue;
      }
      upper = pairs.map((p) => p[1]);
      const loop = [...pairs.map((p) => p[0]), ...[...upper].reverse()].flat();
      const distance = polygonDistance(loop, kernel, reach);
      const source: Distance = (x, y) => Math.abs(distance(x, y)) - frameWidth / 2;
      const box = polyBox(loop), pad = frameWidth / 2;
      back.source = back.field = source;
      back.box = { minX: box.minX - pad, maxX: box.maxX + pad, minY: box.minY - pad, maxY: box.maxY + pad };
      back.step = Math.max(back.step, (back.box.maxX - back.box.minX) / 1400, (back.box.maxY - back.box.minY) / 1400);
      if (!samples(box, Math.max(back.step, minBridge / 2), (x, y) => distance(x, y) < -pad - minBridge))
        say('error', [f.id], 'The frame has no usable centre opening. Reduce frame width or profile inset, or separate the ribs.');
    }
    for (const { rib, shoulder, backU, tabZ, openings } of plans) {
      const before = rib.field;
      rib.field = (x, y) => Math.max(before(x, y), shoulder - x);
      let made = 0;
      for (const [i, z] of tabZ.entries()) {
        const box = { minX: backU, maxX: shoulder + minBridge, minY: z - tabH / 2, maxY: z + tabH / 2 };
        if ([z - tabH / 2, z, z + tabH / 2].some((v) => rib.source(shoulder + minBridge, v) > -minBridge / 2)) {
          say('error', [rib.meta.id, back.meta.id], 'A tab has no shoulder material at its chosen height. Reduce tab spacing or change the rib profile.'); continue;
        }
        const tab = rect(box.minX, box.minY, box.maxX, box.maxY), opening = openings[i];
        if (!opening.length || !boundaryFits(opening, back, minBridge)) {
          say('error', [rib.meta.id, back.meta.id], follows ? 'A tab slot reaches the frame edge or another slot. Increase frame width, reset frame offsets or separate the ribs.' : 'A tab slot reaches the backplate edge or another slot. Enlarge the backplate or separate the ribs.'); continue;
        }
        unite(rib, tab); rib.box.minX = Math.min(rib.box.minX, backU);
        const cut = polygonDistance(opening, kernel, reach);
        subtract(back, cut);
        rib.zones.push({ field: tab, box }); back.zones.push({ field: cut, box: polyBox(opening) }); made++;
      }
      if (made === 2) joints.push({ id: `${rib.meta.id}:${back.meta.id}`, parts: [rib.meta.id, back.meta.id], instruction: `Insert ${rib.meta.label} along its negative U direction until both shoulders meet ${back.meta.label}. Dry-fit, then glue with an adhesive suitable for the chosen stock.` });
    }
    const mount = String(f.params.mount || 'screw');
    if (mount !== 'none') {
      const spacing = Math.max(0, num(f, 'mountSpacing', (back.box.maxX - back.box.minX) * 0.65));
      const z = num(f, 'mountZ', (back.box.maxY - back.box.minY) * 0.3);
      const r = Math.max(0.5, num(f, 'screwDiameter', 4) / 2);
      const headR = !follows || mount === 'keyhole' ? Math.max(r, num(f, 'headDiameter', 8) / 2) : r;
      const automatic = follows && f.params.mountPlacement !== 'manual';
      const candidates = upper.slice(1).flatMap((p, i) => [0.25, 0.5, 0.75].map((t) => [upper[i][0] + (p[0] - upper[i][0]) * t, upper[i][1] + (p[1] - upper[i][1]) * t]));
      for (const side of [-1, 1]) {
        const targetX = upper.length ? upper[0][0] + (upper.at(-1)![0] - upper[0][0]) * (side < 0 ? 0.25 : 0.75) : side * spacing / 2;
        const middleX = upper.length ? (upper[0][0] + upper.at(-1)![0]) / 2 : 0;
        const choices = automatic ? candidates.filter((p) => side * (p[0] - middleX) > 0)
          .sort((a, b) => Math.abs(a[0] - targetX) - Math.abs(b[0] - targetX))
          .flatMap(([x, z]) => [[x, z], [x, z - tabH / 2 - headR - 2 * minBridge]]) : [[side * spacing / 2, z]];
        let placed = false;
        for (const [x, centreZ] of choices) {
          const z = centreZ + (automatic && mount === 'keyhole' ? headR : 0);
          const cut: Distance = mount === 'keyhole'
            ? (u, v) => Math.min(Math.hypot(u - x, v - z + headR * 2) - headR, rectDistance(u, v, x, z - headR, 2 * r, 2 * headR + 2 * r), Math.hypot(u - x, v - z) - r)
            : (u, v) => Math.hypot(u - x, v - z) - r;
          const box = { minX: x - headR, maxX: x + headR, minY: !follows || mount === 'keyhole' ? z - headR * 3 : z - r, maxY: z + (follows ? r : headR) };
          const rings = kernel.trace(cut, box, Math.min(back.step, r / 5));
          let field = back.field, source = back.source;
          if (automatic) {
            const margin = Math.max(minBridge * 2, frameWidth / 4);
            const pad: Distance = (u, v) => rectDistance(u, v, x, (box.minY + box.maxY) / 2, box.maxX - box.minX + 2 * margin, box.maxY - box.minY + 2 * margin, margin);
            const original = source; source = (u, v) => Math.min(original(u, v), pad(u, v));
            // Preserve every earlier slot when growing a small mounting pad.
            const cuts = back.zones.map((zone) => zone.field), padded = source;
            field = (u, v) => cuts.reduce((d, cut) => Math.max(d, -cut(u, v)), padded(u, v));
          }
          if (!rings.length || !rings.every((c) => boundaryFits(c.points, { ...back, field }, minBridge))) continue;
          back.source = source; back.field = field;
          if (automatic) {
            const margin = Math.max(minBridge * 2, frameWidth / 4);
            back.box = { minX: Math.min(back.box.minX, box.minX - margin), maxX: Math.max(back.box.maxX, box.maxX + margin), minY: Math.min(back.box.minY, box.minY - margin), maxY: Math.max(back.box.maxY, box.maxY + margin) };
          }
          subtract(back, cut); back.zones.push({ field: cut, box }); placed = true; break;
        }
        if (!placed) say('error', [back.meta.id], automatic ? 'No upper-rail position fits this mounting opening clear of the tab slots. Separate ribs, reduce the opening or use manual mounting placement.' : 'A mounting opening crosses a tab slot or the backplate edge. Adjust its spacing, height or dimensions.');
      }
    }
    if (num(f, 'wallOffset') < num(f, 'tabProtrusion')) say('error', [back.meta.id], 'Wall offset is smaller than the protruding tabs. Increase the offset or shorten the tabs.');
  }

  for (const f of children.filter((f) => f.kind === 'assembly:channel')) {
    const position: Vec3 = [num(f, 'px'), num(f, 'py', radius * 0.35), num(f, 'pz')];
    const { direction, u: a, v: b } = channelFrame(num(f, 'yaw'), num(f, 'elevation'), num(f, 'roll'));
    const clearance = num(f, 'clearance', 0.25);
    const tube = f.params.shape !== 'strip';
    const width = (tube ? num(f, 'diameter', 16) : num(f, 'width', 12)) + 2 * clearance;
    const h = tube ? width : num(f, 'height', 5) + 2 * clearance;
    const targets = parts.filter((p) => f.params[`${p.meta.kind}Target`] === true || (p.meta.kind === 'rib' && f.params.ribTarget !== false));
    const selectedIds = String(f.params.targetIds || '').split(/[ ,]+/).filter(Boolean);
    const chosen = selectedIds.length ? targets.filter((p) => selectedIds.includes(p.meta.id)) : targets;
    const missingIds = selectedIds.filter((id) => !parts.some((p) => p.meta.id === id));
    if (f.enabled && missingIds.length) say('error', [f.id, ...missingIds], 'Explicit LED targets are missing or disabled. Update the target IDs.');
    let length = num(f, 'length', radius * 3);
    let low = -length / 2, high = length / 2;
    if (f.params.through !== false && chosen.length) {
      const extents = chosen.flatMap((p) => [p.box.minX, p.box.maxX].flatMap((x) => [p.box.minY, p.box.maxY].flatMap((y) => [-p.meta.thickness / 2, p.meta.thickness / 2].map((z) => dot3(add3(sheetWorld(p.meta, x, y, z), mul3(position, -1)), direction)))));
      low = Math.min(...extents) - Math.max(width, h); high = Math.max(...extents) + Math.max(width, h); length = high - low;
    }
    const start = add3(position, mul3(direction, low)), end = add3(position, mul3(direction, high));
    const result = { id: f.id, hits: [] as string[], status: '', origin: position, localOrigin: position, start, end, u: a, v: b, width, height: h };
    channels.push(result);
    if (!f.enabled) { result.status = 'Disabled; no cuts applied.'; continue; }
    const componentValid = tube ? num(f, 'diameter', 16) > 0 : num(f, 'width', 12) > 0 && num(f, 'height', 5) > 0 && num(f, 'cornerRadius') >= 0 && num(f, 'cornerRadius') <= Math.min(num(f, 'width', 12), num(f, 'height', 5)) / 2;
    if (!(length > 0 && width > 0 && h > 0 && clearance >= 0 && componentValid)) {
      result.status = 'Invalid route or cross-section.'; say('error', [f.id], 'LED component dimensions and length must be positive; clearance cannot be negative, and corner radius must fit the component.'); continue;
    }
    if (!chosen.length) { result.status = 'No enabled target parts.'; say('warning', [f.id], result.status); continue; }
    const section: number[] = [];
    // Circumscribed polygons keep the component envelope inside the opening.
    // 96 round segments bound the excess radius by 0.054% before tracing.
    if (tube) {
      const radius = width / 2 / Math.cos(Math.PI / 96);
      for (let i = 0; i < 96; i++) section.push(radius * Math.cos(TAU * i / 96), radius * Math.sin(TAU * i / 96));
    } else {
      const r = Math.min(Math.max(0, num(f, 'cornerRadius') + clearance), width / 2, h / 2);
      if (r === 0) section.push(-width / 2, -h / 2, width / 2, -h / 2, width / 2, h / 2, -width / 2, h / 2);
      else for (let quadrant = 0; quadrant < 4; quadrant++) for (let i = 0; i <= 24; i++) {
        const angle = (quadrant + i / 24) * Math.PI / 2;
        const sx = quadrant === 0 || quadrant === 3 ? 1 : -1, sy = quadrant < 2 ? 1 : -1;
        section.push(sx * (width / 2 - r) + r / Math.cos(Math.PI / 96) * Math.cos(angle), sy * (h / 2 - r) + r / Math.cos(Math.PI / 96) * Math.sin(angle));
      }
    }
    for (const part of chosen) {
      let polygon = prismOpening(part.meta, start, end, a, b, section);
      if (!polygon.length) continue;
      let box = polyBox(polygon), cut = polygonDistance(polygon, kernel, reach);
      if (!overlaps(part, cut, box)) continue;
      const edgeOpen = f.params.open === true;
      const dn = dot3(direction, part.meta.n);
      const extentN = Math.max(...section.filter((_, i) => i % 2 === 0).map((x, i) => Math.abs(x * dot3(a, part.meta.n) + section[i * 2 + 1] * dot3(b, part.meta.n))));
      const startN = sheetLocal(part.meta, start)[2], endN = sheetLocal(part.meta, end)[2];
      if (!edgeOpen && (Math.abs(dn) < 0.05 || Math.min(startN, endN) + extentN > -part.meta.thickness / 2 || Math.max(startN, endN) - extentN < part.meta.thickness / 2)) {
        say('error', [f.id, part.meta.id], 'The route ends inside this sheet or runs along its face. A closed laser opening needs a complete crossing; extend the route or choose an edge-open notch.'); continue;
      }
      if (!edgeOpen && !boundaryFits(polygon, part, minBridge)) {
        say('error', [f.id, part.meta.id], 'The closed LED opening reaches an edge, existing opening or insufficient bridge. Move it or explicitly choose an edge-open notch.'); continue;
      }
      if (edgeOpen) {
        const angle = num(f, 'openAngle', 90) * Math.PI / 180;
        const span = Math.hypot(part.box.maxX - part.box.minX, part.box.maxY - part.box.minY) + Math.hypot(box.maxX - box.minX, box.maxY - box.minY);
        const dx = Math.cos(angle) * span * 2, dy = Math.sin(angle) * span * 2;
        polygon = convexHull(polygon.reduce<number[][]>((out, x, i) => { if (i % 2 === 0) out.push([x, polygon[i + 1]], [x + dx, polygon[i + 1] + dy]); return out; }, []));
        box = polyBox(polygon); cut = polygonDistance(polygon, kernel, reach);
      }
      if (part.zones.some((zone) => samples(zone.box, Math.max(part.step, 0.5), (x, y) => zone.field(x, y) < minBridge && cut(x, y) < minBridge))) {
        say('error', [f.id, part.meta.id], 'The LED opening conflicts with a joint or mounting opening. Move the route or change its dimensions.'); continue;
      }
      subtract(part, cut); result.hits.push(part.meta.id);
    }
    for (const part of parts.filter((p) => !chosen.includes(p))) {
      const opening = prismOpening(part.meta, start, end, a, b, section);
      if (opening.length && overlaps(part, polygonDistance(opening, kernel, reach), polyBox(opening))) {
        say('error', [f.id, part.meta.id], 'An excluded part obstructs the LED component. Include it as a target or move the route. No cut was made in this part.');
      }
    }
    if (result.hits.length && f.params.open !== true) {
      const envelope = parts.flatMap((p) => [p.box.minX, p.box.maxX].flatMap((x) => [p.box.minY, p.box.maxY].map((y) => dot3(add3(sheetWorld(p.meta, x, y), mul3(position, -1)), direction))));
      const lowEnd = add3(position, mul3(direction, Math.min(...envelope, low) - length - width));
      const highEnd = add3(position, mul3(direction, Math.max(...envelope, high) + length + width));
      const blocked = (from: Vec3, to: Vec3) => parts.some((part) => {
        const opening = prismOpening(part.meta, from, to, a, b, section);
        return opening.length > 0 && overlaps(part, polygonDistance(opening, kernel, reach), polyBox(opening));
      });
      const lowBlocked = blocked(lowEnd, end), highBlocked = blocked(start, highEnd);
      if (lowBlocked && highBlocked) say('error', [f.id], 'Both straight insertion directions are obstructed. Use an edge-open notch or revise the surrounding parts.');
      else say('info', [f.id], `LED insertion: feed from the route ${!lowBlocked ? 'start' : 'end'} after dry-fitting the assembly. Component retention is a separate design decision.`);
    }
    result.status = result.hits.length ? `${result.hits.length} of ${chosen.length} targeted parts cut.` : `No cuts in ${chosen.length} targeted parts; the route misses them or the named checks refused it.`;
    if (!result.hits.length && !issues.some((i) => i.ids.includes(f.id))) say('warning', [f.id], result.status);
  }

  // Check material intersections on the actual finished nominal profiles.
  // Test a 3x3 family of slab-plane intersection lines, rather than just two
  // mid-planes, which would miss thick-sheet collisions beside a slot.
  const collision = (a: WorkPart, b: WorkPart, shift: Vec3 = [0, 0, 0]): boolean => {
    const origin = add3(a.meta.origin, shift);
    const ma = { ...a.meta, origin };
    const direction = cross3(ma.n, b.meta.n), d2 = dot3(direction, direction);
    if (d2 < 1e-8) {
      if (Math.abs(dot3(add3(origin, mul3(b.meta.origin, -1)), b.meta.n)) >= (ma.thickness + b.meta.thickness) / 2 - 0.01) return false;
      const corners = [b.box.minX, b.box.maxX].flatMap((x) => [b.box.minY, b.box.maxY].map((y) => sheetLocal(ma, sheetWorld(b.meta, x, y))));
      const bb = polyBox(corners.flatMap((p) => p.slice(0, 2)));
      const box = { minX: Math.max(a.box.minX, bb.minX), maxX: Math.min(a.box.maxX, bb.maxX), minY: Math.max(a.box.minY, bb.minY), maxY: Math.min(a.box.maxY, bb.maxY) };
      if (box.minX >= box.maxX || box.minY >= box.maxY) return false;
      return samples(box, Math.max(a.step, b.step), (x, y) => { const q = sheetLocal(b.meta, sheetWorld(ma, x, y)); return a.field(x, y) < -0.03 && b.field(q[0], q[1]) < -0.03; });
    }
    for (const da of [-0.49, 0, 0.49]) for (const db of [-0.49, 0, 0.49]) {
      const ca = dot3(ma.n, origin) + da * ma.thickness, cb = dot3(b.meta.n, b.meta.origin) + db * b.meta.thickness;
      const p = mul3(add3(mul3(cross3(b.meta.n, direction), ca), mul3(cross3(direction, ma.n), cb)), 1 / d2);
      const d = unit3(direction);
      const centreA = sheetWorld(ma, (a.box.minX + a.box.maxX) / 2, (a.box.minY + a.box.maxY) / 2);
      const middle = dot3(add3(centreA, mul3(p, -1)), d);
      const span = Math.hypot(a.box.maxX - a.box.minX, a.box.maxY - a.box.minY) / 2 + ma.thickness;
      for (let t = middle - span; t <= middle + span; t += Math.max(a.step, b.step)) {
        const q = add3(p, mul3(d, t)), qa = sheetLocal(ma, q), qb = sheetLocal(b.meta, q);
        if (a.field(qa[0], qa[1]) < -0.03 && b.field(qb[0], qb[1]) < -0.03) return true;
      }
    }
    return false;
  };
  for (let a = 0; a < parts.length; a++) for (let b = a + 1; b < parts.length; b++) {
    if (collision(parts[a], parts[b])) say('error', [parts[a].meta.id, parts[b].meta.id], 'Finished sheets intersect outside their clearances. Move the parts or revise their joints.');
  }
  // Every rib moves on its own U axis from outside the assembly. A swept
  // collision against another rib determines an insertion dependency. Cycles
  // mean there is no sequential assembly order, even if the final pose fits.
  const before = new Map<string, Set<string>>(ribs.map((r) => [r.meta.id, new Set<string>()]));
  for (const rib of ribs) {
    for (const fixed of [...supports, ...backs.filter((p) => parts.includes(p)), ...ribs.filter((r) => r !== rib)]) {
      let blocked = false;
      for (let distance = Math.max(stockT, 1); distance <= reach; distance += Math.max(stockT, reach / 28)) {
        if (collision(rib, fixed, mul3(rib.meta.u, distance))) { blocked = true; break; }
      }
      if (!blocked) continue;
      if (fixed.meta.kind === 'rib') before.get(fixed.meta.id)!.add(rib.meta.id);
      else say('error', [rib.meta.id, fixed.meta.id], 'The straight insertion sweep is blocked by this support. Move the rib or revise the support opening.');
    }
  }
  const order: string[] = [];
  while (order.length < ribs.length) {
    const next = ribs.find((r) => !order.includes(r.meta.id) && [...before.get(r.meta.id)!].every((id) => order.includes(id)));
    if (!next) break;
    order.push(next.meta.id);
  }
  if (order.length !== ribs.length) say('error', ribs.filter((r) => !order.includes(r.meta.id)).map((r) => r.meta.id), 'Rib insertion paths depend on each other in a cycle. Change placement or angles to allow sequential assembly.');
  else if (order.length && joints.length) say('info', order, `Dry-fit insertion order: ${order.map((id) => parts.find((p) => p.meta.id === id)!.meta.label).join(', ')}. Clearance and path checks are sampled; confirm the sequence with a small physical coupon.`);
  if (!supports.length && !backs.length) say('warning', ribs.map((p) => p.meta.id), 'No supports are enabled. These are loose ribs with no generated attachment.');

  const globalAngle = num(layout, 'angle') * Math.PI / 180;
  const translation: Vec3 = [centre[0] + num(layout, 'px'), centre[1] + num(layout, 'py'), centre[2] + num(layout, 'pz')];
  const world = (p: Vec3) => add3(rotateZ(p, globalAngle), translation);
  const slices: Slice[] = [];
  for (const part of parts) {
    // Redistance the finished 2D contour before applying kerf. Restricting a
    // 3D SDF to this plane would over-compensate oblique source surfaces.
    const nominal = kernel.trace(part.field, part.box, part.step, 0, Math.min(options.tolerance, part.step / 12));
    if (!nominal.length) { say('error', [part.meta.id], 'All material was removed from this part.'); continue; }
    if (nominal.filter((c) => !c.isHole).length !== 1) say('error', [part.meta.id], 'This part is disconnected. Revise its profile, slots or LED openings.');
    const exact = kernel.distance(nominal, Math.max(part.meta.kerf * 2, part.step * 4));
    const contours = part.meta.kerf > 0 ? kernel.trace(exact, part.box, part.step, part.meta.kerf / 2, Math.min(options.tolerance, part.step / 12)) : nominal;
    const meta: Part = { ...part.meta, origin: world(part.meta.origin), u: rotateZ(part.meta.u, globalAngle), v: rotateZ(part.meta.v, globalAngle), n: rotateZ(part.meta.n, globalAngle) };
    const slice: Slice = { index: slices.length + 1, z: meta.origin[2], zBottom: meta.origin[2] - meta.thickness / 2, contours, circles: [], part: meta };
    if (kernel.thin({ ...slice, contours: nominal }, minBridge)) say('warning', [meta.id], `A remaining bridge is below ${minBridge} mm. Inspect this part before cutting.`);
    slices.push(slice);
  }
  for (const channel of channels) { channel.origin = world(channel.origin); channel.start = world(channel.start); channel.end = world(channel.end); channel.u = rotateZ(channel.u, globalAngle); channel.v = rotateZ(channel.v, globalAngle); }
  const compact: Issue[] = [];
  for (const issue of issues) {
    const same = issue.severity === 'warning' && compact.find((i) => i.severity === issue.severity && i.message === issue.message);
    if (same) same.ids = [...new Set([...same.ids, ...issue.ids])];
    else compact.push(issue);
  }
  return { slices, planes: [], pitch: 0, thickness: stockT, z0: bounds.min[2], planesExamined: parts.length, step: Math.max(0, ...parts.map((p) => p.step)), kerf: options.kerf,
    assembly: { id: layout.id, cuttable: !issues.some((i) => i.severity === 'error'), issues: compact, joints, channels } };
}
