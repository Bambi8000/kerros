/** Linked upright ribs and independent 3D plates. Pure geometry supplied by the pipeline. */
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
const RAD = Math.PI / 180;
export const assemblyNumber = (f: Feature, key: string, fallback = 0): number => {
  const value = f.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};
const num = assemblyNumber;
export type RibAngleScope = 'selected' | 'odd' | 'even' | 'all';
/** Sequence numbers are independent of persistent feature IDs and tree order. */
export const ribAngleGroup = (rib: Feature): 'odd' | 'even' => Math.max(0, Math.floor(num(rib, 'ordinal'))) % 2 === 0 ? 'odd' : 'even';
export const ribAngleKey = (scope: Exclude<RibAngleScope, 'selected'>) => scope === 'all' ? 'ribAngle' : scope === 'odd' ? 'oddAngle' : 'evenAngle';
export const ribAngleValue = (rib: Feature, layout: Feature, scope: RibAngleScope) => scope === 'selected' ? num(rib, 'angle') : num(layout, ribAngleKey(scope));
/** Used by both the gizmo preview and its target highlighting. */
export function ribAngleTargets(features: Feature[], id: string, scope: RibAngleScope): string[] {
  const selected = features.find((f) => f.id === id && f.kind === 'assembly:rib' && !isFreePlate(f));
  if (!selected) return [];
  return features.filter((f) => f.enabled && f.kind === 'assembly:rib' && !isFreePlate(f) && f.params.groupId === selected.params.groupId
    && (scope === 'all' || (scope === 'selected' ? f.id === id : ribAngleGroup(f) === scope))).map((f) => f.id);
}
/** Fan is an additive linear-layout component. Hidden ribs retain their slots. */
export function ribPlacementAngles(features: Feature[], layout: Feature): Map<string, number> {
  const ribs = features.filter((f) => f.kind === 'assembly:rib' && f.params.groupId === layout.id);
  const x = (f: Feature) => num(f, 'station') * num(layout, 'spacing', 12) + num(f, 'px');
  ribs.sort((a, b) => x(a) - x(b) || num(a, 'ordinal') - num(b, 'ordinal') || a.id.localeCompare(b.id));
  const fan = layout.params.layout === 'linear' ? num(layout, 'fanAngle') : 0;
  return new Map(ribs.map((rib, i) => [rib.id, num(rib, 'angle') + num(layout, 'ribAngle')
    + num(layout, ribAngleKey(ribAngleGroup(rib))) + (ribs.length > 1 ? fan * (1 - 2 * i / (ribs.length - 1)) : 0)]));
}
/** Repose retained cuts for linked rib angles and independent plate poses.
 * Returns null for source, membership, joint or other geometry changes.
 * Callers must also enforce project/import ownership. This never supplies cuts.
 */
export function ribAnglePreview(set: SliceSet | null, before: Feature[] | null, after: Feature[]): Map<string, Part> | null {
  const layout = activeAssembly(after);
  if (!set?.assembly || !before || !layout || set.assembly.id !== layout.id || before.length !== after.length) return null;
  for (let i = 0; i < after.length; i++) {
    const a = before[i], b = after[i];
    if (a === b) continue;
    const allowed = b.id === layout.id ? ['ribAngle', 'oddAngle', 'evenAngle', 'fanAngle']
      : isFreePlate(b) && b.params.groupId === layout.id ? ['plateX', 'plateY', 'plateZ', 'plateRx', 'plateRy', 'plateRz']
      : b.kind === 'assembly:rib' && b.params.groupId === layout.id ? ['angle'] : [];
    if (!allowed.length) return null;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (key !== 'params' && a[key as keyof Feature] !== b[key as keyof Feature]) return null;
    }
    for (const key of new Set([...Object.keys(a.params), ...Object.keys(b.params)])) {
      if (!allowed.includes(key) && a.params[key] !== b.params[key]) return null;
    }
  }
  const oldLayout = activeAssembly(before);
  if (!oldLayout || oldLayout.id !== layout.id) return null;
  const oldAngles = ribPlacementAngles(before, oldLayout), angles = ribPlacementAngles(after, layout);
  return new Map(set.slices.flatMap((slice) => {
    const part = slice.part;
    if (part?.kind === 'plate' && set.assembly?.origin) {
      const feature = after.find((f) => f.id === part.id && f.enabled && isFreePlate(f));
      if (!feature) return [];
      const a = num(layout, 'angle') * RAD;
      const frame = freePlateFrame(num(feature, 'plateRx'), num(feature, 'plateRy'), num(feature, 'plateRz'));
      return [[part.id, { ...part, origin: add3(rotateZ([num(feature, 'plateX'), num(feature, 'plateY'), num(feature, 'plateZ')], a), set.assembly.origin),
        u: rotateZ(frame.u, a), v: rotateZ(frame.v, a), n: rotateZ(frame.n, a) }]];
    }
    if (part?.kind !== 'rib' || !angles.has(part.id) || !oldAngles.has(part.id)) return [];
    const delta = (angles.get(part.id)! - oldAngles.get(part.id)!) * Math.PI / 180;
    return [[part.id, { ...part, u: rotateZ(part.u, delta), n: rotateZ(part.n, delta) }]];
  }));
}
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
export const isFreePlate = (f: Feature) => f.kind === 'assembly:plate' || (['assembly:rib', 'assembly:support', 'assembly:backplate'].includes(f.kind) && f.params.freePlacement === true);
export function freePlateFrame(rx: number, ry: number, rz: number) {
  const a = rx * RAD, b = ry * RAD, c = rz * RAD;
  const rotate = ([x, y, z]: Vec3): Vec3 => {
    const y1 = y * Math.cos(a) - z * Math.sin(a), z1 = y * Math.sin(a) + z * Math.cos(a);
    return rotateZ([x * Math.cos(b) + z1 * Math.sin(b), y1, -x * Math.sin(b) + z1 * Math.cos(b)], c);
  };
  return { u: rotate([1, 0, 0]), v: rotate([0, 1, 0]), n: rotate([0, 0, 1]) };
}
/** Recover local Euler angles after a world-space gizmo quaternion delta. */
export function freePlateAngles(worldU: Vec3, worldV: Vec3, layoutAngle: number) {
  const u = rotateZ(worldU, -layoutAngle * RAD), v = rotateZ(worldV, -layoutAngle * RAD);
  const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const ry = Math.asin(Math.max(-1, Math.min(1, -u[2])));
  const regular = Math.abs(u[2]) < 1 - 1e-12;
  return { plateRx: (regular ? Math.atan2(v[2], n[2]) : 0) / RAD, plateRy: ry / RAD,
    plateRz: (regular ? Math.atan2(u[1], u[0]) : Math.atan2(-v[0], v[1])) / RAD };
}
/** Never snapshot compensated paths: doing so would apply kerf twice. */
export function snapshotPlate(source: Feature, slice: Slice, layout: Feature, assemblyOrigin: Vec3, id: string, duplicate: boolean): Feature | null {
  const part = slice.part;
  if (!source.enabled || !part || part.id !== source.id || !slice.nominalContours?.length) return null;
  const angle = Number(layout.params.angle || 0);
  const position = rotateZ(part.origin.map((v, i) => v - assemblyOrigin[i]) as Vec3, -angle * RAD);
  if (duplicate) {
    const normal = rotateZ(part.n, -angle * RAD), gap = part.thickness + 10;
    position.forEach((_, i) => { position[i] += normal[i] * gap; });
  }
  const pose = { plateX: position[0], plateY: position[1], plateZ: position[2], ...freePlateAngles(part.u, part.v, angle) };
  return {
    ...(duplicate ? { id, kind: 'assembly:plate', stage: 'SLICE' as const, name: `${source.name} copy`, enabled: true } : source),
    params: { ...(duplicate ? { groupId: layout.id, ownMaterial: true, materialName: part.stockName || part.material, thickness: part.thickness, kerf: part.kerf } : source.params),
      ...pose, freePlacement: true, plateShape: 'snapshot' },
    plateOutline: slice.nominalContours.map((c) => [...c.points]),
  };
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

/** Fit full-height tabs to the longest shoulder band, including short end ribs. */
function followingTabs(rib: WorkPart, shoulder: number, padding: number, tabH: number, bridge: number, fit: number): { heights: number[]; adjusted: boolean } {
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
  if (!best || best[1] - best[0] < tabH) return { heights: [], adjusted: false };
  const span = best[1] - best[0];
  // Leave a real bridge between the two clearance slots, with one sample of
  // slack. Rail bands may merge locally at a short rib; the centre stays open
  // wherever the rest of the profile allows it.
  const gap = tabH + 2 * fit + bridge + rib.step;
  if (span < tabH + gap) return { heights: [(best[0] + best[1]) / 2], adjusted: true };
  const actualPadding = Math.min(padding, (span - gap) / 2);
  return { heights: [best[0] + actualPadding, best[1] - actualPadding], adjusted: actualPadding < padding };
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
  const say = (severity: Issue['severity'], ids: string[], message: string, ribCollision?: [string, string]) => issues.push({ severity, ids: [...new Set(ids)], message, ...(ribCollision ? { ribCollision } : {}) });
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
    const part: WorkPart = { meta: { id: f.id, label: `${kind === 'rib' ? 'R' : kind === 'support' ? 'S' : kind === 'plate' ? 'P' : 'B'}${f.id.slice(1)}`, kind, origin, u, v, n: cross3(u, v), thickness, kerf, stockName: name, material: `${name} / ${thickness} mm / kerf ${kerf} mm` }, box, source, field: source, zones: [], step };
    parts.push(part); return part;
  };
  if (num(layout, 'jointClearance', 0.1) < 0 || (radial && (num(layout, 'ribDepth', 25) <= 0 || num(layout, 'innerRadius') < 0))) say('error', [layout.id], 'Joint clearance and centre radius cannot be negative; rib depth must be positive.');
  if (features.filter((f) => f.kind === 'assembly:layout' && f.enabled).length > 1) say('error', [layout.id], 'Only one assembly layout can be active. Disable the other layout.');
  const incompatible = features.filter((f) => f.enabled && !f.kind.startsWith('assembly:') && f.stage !== 'SHAPE' && f.stage !== 'CARVE');
  if (incompatible.length) say('warning', incompatible.map((f) => f.id), 'Horizontal-layer tools are not applied to upright parts. Disable the assembly to edit their original layers.');
  const placementAngles = ribPlacementAngles(features, layout);
  for (const f of children.filter((f) => f.enabled && f.kind === 'assembly:rib' && !isFreePlate(f))) {
    const sourceAngle = num(f, 'sourceAngle') * Math.PI / 180;
    const sourceY = !radial && f.params.sourceAxis === 'y';
    const baseU: Vec3 = radial ? [Math.cos(sourceAngle), Math.sin(sourceAngle), 0] : sourceY ? [1, 0, 0] : [0, 1, 0];
    const pivot = radial ? num(layout, 'pivotRadius', radius * 0.7) : 0;
    const station = num(f, 'station');
    const src: Vec3 = radial ? add3(centre, mul3(baseU, pivot)) : add3(centre, sourceY ? [0, num(f, 'sourceX'), 0] : [num(f, 'sourceX'), 0, 0]);
    const angle = placementAngles.get(f.id)! * Math.PI / 180;
    const origin: Vec3 = radial ? mul3(baseU, pivot) : sourceY ? [0, station * num(layout, 'spacing', 12), 0] : [station * num(layout, 'spacing', 12), 0, 0];
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
  for (const f of children.filter((f) => f.enabled && f.kind === 'assembly:support' && !isFreePlate(f))) {
    const outer = num(f, 'outerDiameter', radius * 1.8) / 2, inner = num(f, 'innerDiameter', radius * 1.2) / 2;
    if (!(outer > inner + minBridge) || inner < 0) { say('error', [f.id], 'The support needs a positive outer diameter and a remaining ring wider than the minimum bridge.'); continue; }
    const source: Distance = (x, y) => Math.max(Math.hypot(x, y) - outer, inner > 0 ? inner - Math.hypot(x, y) : -Infinity);
    makePart(f, 'support', [num(f, 'px'), num(f, 'py'), num(f, 'pz')], [1, 0, 0], [0, 1, 0], { minX: -outer, minY: -outer, maxX: outer, maxY: outer }, source);
  }
  for (const f of children.filter((f) => f.enabled && f.kind === 'assembly:backplate' && !isFreePlate(f))) {
    const w = num(f, 'width', radius * 2), h = num(f, 'height', height), z = num(f, 'pz');
    if (f.params.outline !== 'frame' && f.params.outline !== 'solid' && !(w > 2 * minBridge && h > 2 * minBridge)) { say('error', [f.id], 'The backplate width and height must exceed two minimum bridges.'); continue; }
    const t = f.params.ownMaterial === true ? Math.max(0.2, num(f, 'thickness', stockT)) : stockT;
    const back = makePart(f, 'backplate', [num(f, 'px'), num(f, 'py') - t / 2, z], [1, 0, 0], [0, 0, 1], { minX: -w / 2, maxX: w / 2, minY: -h / 2, maxY: h / 2 }, (x, y) => rectDistance(x, y, 0, 0, w, h, num(f, 'cornerRadius', 3)));
    back.meta.wallOffset = num(f, 'wallOffset');
  }

  for (const f of children.filter((f) => f.enabled && isFreePlate(f))) {
    const frame = freePlateFrame(num(f, 'plateRx'), num(f, 'plateRy'), num(f, 'plateRz'));
    let box: Box2, source: Distance;
    if (f.params.plateShape === 'snapshot') {
      const rings = f.plateOutline;
      if (!rings?.length || !rings.every((r) => r.length >= 6 && r.length % 2 === 0 && r.every(Number.isFinite))) {
        say('error', [f.id], 'This free plate has no valid saved outline. Restore its linked source or replace the plate.'); continue;
      }
      const contours = rings.map((points) => ({ points, area: 1, isHole: false }));
      box = contourBox(contours); source = kernel.distance(contours, reach);
    } else {
      const w = num(f, 'plateWidth', 80), h = num(f, 'plateHeight', 120), r = num(f, 'plateRadius', 3);
      if (!(w > 0 && h > 0 && r >= 0 && r <= Math.min(w, h) / 2)) {
        say('error', [f.id], 'Plate width and height must be positive; corner radius must fit inside the plate.'); continue;
      }
      box = { minX: -w / 2, maxX: w / 2, minY: -h / 2, maxY: h / 2 };
      source = (x, y) => rectDistance(x, y, 0, 0, w, h, r);
    }
    makePart(f, 'plate', [num(f, 'plateX'), num(f, 'plateY'), num(f, 'plateZ')], frame.u, frame.v, box, source);
  }
  if (!parts.length) say('error', [layout.id], 'No enabled plates could be built. Add a free plate, enable a rib or adjust its source plane.');
  const free = parts.filter((p) => p.meta.kind === 'plate');
  if (free.length) say('warning', free.map((p) => p.meta.id), 'Free plates have independent outlines and no generated attachments. Saved slots and holes stay with the plate; they are not live joints. Collision checks include them. Plan their mounting and insertion separately from the linked ribs.');

  const ribs = parts.filter((p) => p.meta.kind === 'rib');
  const supports = parts.filter((p) => p.meta.kind === 'support');
  const backs = parts.filter((p) => p.meta.kind === 'backplate');
  const fit = Math.max(0, num(layout, 'jointClearance', 0.1));
  const socketSupports = supports.filter(p => children.find(f => f.id === p.meta.id)?.params.jointStyle === 'sockets');
  const openSupports = supports.filter(p => !socketSupports.includes(p));
  const socketSign = (part: WorkPart) => children.find(f => f.id === part.meta.id)?.params.socketSide === 'bottom' ? -1 : 1;
  const expectedRibs = children.filter(f => f.enabled && f.kind === 'assembly:rib' && !isFreePlate(f));
  // Socket supports are end caps. Leave them off while assembling the ribs,
  // then slide each cap onto flush-ended tabs along Z. Trim before cross slots
  // so a later ring cannot claim contact with material the cap removed.
  const repeatedCaps = [1, -1].flatMap(sign => {
    const caps = socketSupports.filter(p => socketSign(p) === sign);
    return caps.length > 1 ? caps : [];
  });
  if (repeatedCaps.length) say('error', repeatedCaps.map(p => p.meta.id), 'Use at most one closed-socket end plate from above and one from below. Use Cross slots for intermediate supports.');
  for (const support of socketSupports) {
    if (repeatedCaps.includes(support)) continue;
    const f = children.find(f => f.id === support.meta.id)!, sign = socketSign(support);
    const stockSize = f.params.socketSizing === 'stock', relief = num(f, 'socketRelief', 0.5);
    const requested = String(f.params.socketCount ?? '1'), automatic = requested === 'auto';
    const requestedCount = automatic ? 1 : Number(requested);
    if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 4) {
      say('error', [f.id], 'Tabs per rib must be Automatic or a whole count from 1 to 4.'); continue;
    }
    const widths = ribs.map(r => stockSize ? r.meta.thickness : num(f, 'socketWidth', 8));
    if (!(widths.every(width => width >= minBridge) && relief >= 0 && relief <= Math.min(...widths, ...ribs.map(r => r.meta.thickness)) / 2)) {
      say('error', [f.id], 'Tab width must be at least the minimum bridge. Socket corner relief must be nonnegative and no larger than half the tab width or rib thickness.'); continue;
    }
    // A coarse marching cell can chamfer away a small square socket's corner
    // clearance. Resolve it before fitting and tracing, including rotated ribs.
    if (fit + relief > 0) support.step = Math.min(support.step, Math.max(0.05, 2 * (fit + relief)));
    const trial = { ...support };
    const plans: { rib: WorkPart; width: number; shoulder: number; end: number; tabs: { tab: Distance; tabBox: Box2; cut: Distance; cutBox: Box2 }[] }[] = [];
    for (const rib of ribs) {
      const width = stockSize ? rib.meta.thickness : num(f, 'socketWidth', 8);
      const shoulder = support.meta.origin[2] - sign * support.meta.thickness / 2 - rib.meta.origin[2];
      const end = shoulder + sign * support.meta.thickness;
      const seat = shoulder - sign * minBridge;
      const opening = (x: number, along: number, across: number) => sheetLocal(support.meta, sheetWorld(rib.meta, x + along, shoulder, across)).slice(0, 2);
      const half = width / 2 + fit, normal = rib.meta.thickness / 2 + fit;
      const candidate = (x: number) => {
        const body = { minX: x - width / 2 - minBridge, maxX: x + width / 2 + minBridge,
          minY: Math.min(seat, seat - sign * minBridge), maxY: Math.max(seat, seat - sign * minBridge) };
        if (samples(body, Math.max(rib.step, 0.35), (u, v) => rib.field(u, v) > -minBridge / 2)) return false;
        // A circumscribing rectangle also protects the optional round corner relief.
        const guard = [[-1, -1], [1, -1], [1, 1], [-1, 1]].flatMap(([a, b]) => opening(x, a * (half + relief), b * (normal + relief)));
        return boundaryFits(guard, trial, minBridge);
      };
      let start: number | undefined, best: [number, number] | undefined;
      const count = Math.max(1, Math.ceil((rib.box.maxX - rib.box.minX) / (rib.step / 2)));
      const step = (rib.box.maxX - rib.box.minX) / count;
      for (let i = 0; i <= count + 1; i++) {
        const x = rib.box.minX + i * step;
        if (i <= count && candidate(x)) start ??= x;
        else if (start !== undefined) {
          const finish = x - step;
          if (!best || finish - start > best[1] - best[0]) best = [start, finish];
          start = undefined;
        }
      }
      if (!best) { say('error', [rib.meta.id, f.id], `No ${width} mm tab fits with a full shoulder and an enclosed socket. Move this end plate into the rib, enlarge the plate or reduce its inner diameter.${stockSize ? ' Matched tabs keep the rib stock thickness.' : ' You can also reduce Tab width.'}`); continue; }
      // Spread small tabs rather than perforating the entire shoulder densely.
      // Relief, clearance and sampling slack all count toward the intact bridge.
      const pitch = Math.max(automatic ? 3 * width : 0, 2 * (half + relief) + minBridge + 2 * rib.step);
      const capacity = Math.min(4, 1 + Math.floor((best[1] - best[0]) / pitch));
      const countTabs = automatic ? capacity : requestedCount;
      if (countTabs > capacity) {
        say('error', [rib.meta.id, f.id], `Requested ${countTabs} tabs of ${width} mm; only ${capacity} fit in the widest continuous shoulder band with clear sockets. Reduce Tabs per rib, choose Automatic or move the end plate into a wider part of the rib.`); continue;
      }
      const tabs: typeof plans[number]['tabs'] = [];
      for (let i = 0; i < countTabs; i++) {
        const mid = countTabs === 1 ? (best[0] + best[1]) / 2 : best[0] + (best[1] - best[0]) * i / (countTabs - 1);
        const tabBox = { minX: mid - width / 2, maxX: mid + width / 2, minY: Math.min(seat, end), maxY: Math.max(seat, end) };
        const tab = rect(tabBox.minX, tabBox.minY, tabBox.maxX, tabBox.maxY);
        const cut: Distance = (x, y) => {
          const p = sheetLocal(rib.meta, sheetWorld(support.meta, x, y));
          let d = rectDistance(p[0], p[2], mid, 0, half * 2, normal * 2);
          if (relief > 0) for (const a of [-1, 1]) for (const b of [-1, 1]) d = Math.min(d, Math.hypot(p[0] - mid - a * half, p[2] - b * normal) - relief);
          return d;
        };
        const cutBox = polyBox([[-1, -1], [1, -1], [1, 1], [-1, 1]].flatMap(([a, b]) => opening(mid, a * (half + relief), b * (normal + relief))));
        tabs.push({ tab, tabBox, cut, cutBox }); subtract(trial, cut);
      }
      plans.push({ rib, width, shoulder, end, tabs });
    }
    // Do not make a plausible cap with one or more unattached ribs.
    if (!expectedRibs.length || plans.length !== expectedRibs.length) {
      say('error', [f.id, ...expectedRibs.filter(r => !plans.some(p => p.rib.meta.id === r.id)).map(r => r.id)], `Closed sockets: ${plans.length} of ${expectedRibs.length} enabled ribs could be fitted. No joints from this end plate were applied; resolve the named contacts.`); continue;
    }
    support.field = trial.field;
    for (const { rib, width, shoulder, end, tabs } of plans) {
      const before = rib.field;
      rib.field = (x, y) => Math.max(before(x, y), sign * (y - shoulder));
      for (const { tab, tabBox, cut, cutBox } of tabs) {
        unite(rib, tab);
        rib.zones.push({ field: tab, box: tabBox }); support.zones.push({ field: cut, box: cutBox });
      }
      if (sign > 0) rib.box.maxY = end; else rib.box.minY = end;
      joints.push({ id: `${rib.meta.id}:${support.meta.id}`, parts: [rib.meta.id, support.meta.id], instruction: `After fitting the ribs into any open-slot supports, fit ${support.meta.label} from ${sign > 0 ? 'above along -Z' : 'below along +Z'} onto ${tabs.length === 1 ? 'the' : tabs.length} ${width} mm ${stockSize ? 'square ' : ''}tab${tabs.length === 1 ? '' : 's'} of ${rib.meta.label}. ${tabs.length === 1 ? 'The tab finishes' : 'The tabs finish'} flush with the outer face. Dry-fit, then glue with an adhesive suitable for the stock.` });
    }
    say('info', [f.id], `Closed sockets: all ${plans.length} enabled ribs have flush tab joints (${plans.reduce((sum, plan) => sum + plan.tabs.length, 0)} tabs total). Ribs are trimmed ${sign > 0 ? 'above the lower' : 'below the upper'} face of ${support.meta.label}. Keep this end plate off until the ribs are assembled.`);
  }
  if (socketSupports.length) for (const rib of ribs) rib.source = rib.field;
  // A rib enters every ring along -U. The rib's notch opens toward -U;
  // the ring's complementary notch opens toward +U. All rings stay fixed.
  for (const rib of ribs) {
    for (const support of openSupports) {
      const z = support.meta.origin[2] - rib.meta.origin[2];
      const along = (u: number) => sheetLocal(support.meta, sheetWorld(rib.meta, u, z));
      const x0 = rib.box.minX, x1 = rib.box.maxX;
      const hits: number[] = [];
      for (let x = x0; x <= x1; x += rib.step / 2) {
        const q = along(x);
        if (rib.source(x, z) < -minBridge / 2 && support.source(q[0], q[1]) < -minBridge / 2) hits.push(x);
      }
      if (hits.length < 2 || hits.at(-1)! - hits[0] < Math.max(2 * minBridge, stockT)) {
        say('error', [rib.meta.id, support.meta.id], 'No usable cross-slot contact at this plate height. For a top or bottom end plate, select this support and choose Joint type: Closed sockets to trim the rib and fit tabs. For an intermediate support, move it farther into the rib or resize it. Visible overlap alone is not a complete joint.'); continue;
      }
      const lo = hits[0], hi = hits.at(-1)!, mid = (lo + hi) / 2;
      if (hits.some((x, i) => i > 0 && x - hits[i - 1] > rib.step)) {
        say('error', [rib.meta.id, support.meta.id], 'This support crosses the rib in separate regions; a single straight insertion cannot be resolved.'); continue;
      }
      const slotH = support.meta.thickness + fit * 2;
      const ribCut = rect(rib.box.minX - reach, z - slotH / 2, mid + fit, z + slotH / 2);
      if (socketSupports.length && rib.zones.some(zone => samples(zone.box, Math.max(rib.step, 0.35), (x, y) => zone.field(x, y) < minBridge && ribCut(x, y) < minBridge))) {
        say('error', [rib.meta.id, support.meta.id], 'This cross slot would damage an existing tab or support joint. Separate the supports or move the end plate.'); continue;
      }
      subtract(rib, ribCut);
      const ringCut: Distance = (x, y) => {
        const p = sheetLocal(rib.meta, sheetWorld(support.meta, x, y));
        return Math.max(mid - fit - p[0], Math.abs(p[2]) - rib.meta.thickness / 2 - fit);
      };
      subtract(support, ringCut);
      rib.zones.push({ field: rect(lo, z - slotH, hi, z + slotH), box: { minX: lo, maxX: hi, minY: z - slotH, maxY: z + slotH } });
      support.zones.push({ field: (x, y) => { const p = sheetLocal(rib.meta, sheetWorld(support.meta, x, y)); return rectDistance(p[0], p[2], mid, 0, hi - lo, rib.meta.thickness + fit * 2); }, box: support.box });
      joints.push({ id: `${rib.meta.id}:${support.meta.id}`, parts: [rib.meta.id, support.meta.id], instruction: `Hold ${support.meta.label} in place; slide ${rib.meta.label} along its negative U direction into the complementary half slots. ${socketSupports.length ? 'Install open-slot supports before the ribs; leave closed-socket end plates off until afterwards.' : 'Install all supports before the ribs.'}` });
    }
  }

  // Each wall joint trims the rib to the front face and adds fitted tabs. The
  // slot in the backplate is the projection of the complete tab prism through
  // the backplate slab: both thicknesses contribute at an oblique angle.
  if (backs.length > 1) say('error', backs.map((p) => p.meta.id), 'Use one backplate per assembly; multiple-wall insertion is not resolved.');
  if (backs.length && supports.length) say('error', [...backs, ...supports].map((p) => p.meta.id), 'Wall tabs and ring slots require different insertion paths. Use one support system per assembly.');
  for (const back of backs) {
    const f = children.find((f) => f.id === back.meta.id)!;
    const filled = f.params.outline === 'solid';
    const follows = f.params.outline === 'frame' || filled;
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
      const placement = follows ? followingTabs(rib, shoulder, frameWidth / 2 + inset, tabH, minBridge, fit)
        : { heights: [-tabGap / 2, tabGap / 2].map((z) => z + back.meta.origin[2] - rib.meta.origin[2]), adjusted: false };
      const tabZ = placement.heights;
      if (!tabZ.length) say('error', [rib.meta.id, back.meta.id], 'No shoulder band fits even one full-height frame tab. Reduce tab height, move the wall plane or change this rib profile.');
      else if (placement.adjusted) say('info', [rib.meta.id, back.meta.id], tabZ.length === 1
        ? 'This short rib uses one centred glue tab at the requested height; two separate tabs do not fit. Test the joint in the chosen stock.'
        : 'Rail inset is reduced locally to fit two full-height tabs on this short rib.');
      const openings = tabZ.map((z) => prismOpening(back.meta, sheetWorld(rib.meta, backU, z), sheetWorld(rib.meta, shoulder + minBridge, z), rib.meta.n, rib.meta.v, [-rib.meta.thickness / 2 - fit, -tabH / 2 - fit, rib.meta.thickness / 2 + fit, -tabH / 2 - fit, rib.meta.thickness / 2 + fit, tabH / 2 + fit, -rib.meta.thickness / 2 - fit, tabH / 2 + fit]));
      return [{ rib, shoulder, backU, tabZ, openings }];
    });
    let upper: number[][] = [];
    if (follows) {
      if (plans.length !== ribs.length || plans.some((p) => !p.openings.length || p.openings.some((o) => !o.length))) {
        say('error', [f.id], 'The frame cannot reach every rib with a valid tab. Fix the named ribs; a partial frame has not been generated.');
        parts.splice(parts.indexOf(back), 1); continue;
      }
      const pairs = plans.map((p) => [p.openings[0], p.openings.at(-1)!].map((o) => {
        const box = polyBox(o);
        // X/Z offset moves the outline; the mating cuts remain at the ribs.
        return [(box.minX + box.maxX) / 2 + back.meta.origin[0], (box.minY + box.maxY) / 2 + back.meta.origin[2]];
      })).sort((a, b) => a[0][0] - b[0][0]);
      if (pairs.length < 2 || pairs.at(-1)![0][0] - pairs[0][0][0] <= frameWidth) {
        say('error', [f.id], `${filled ? 'A minimal solid backplate' : 'An open frame'} needs at least two usable ribs spread wider than its frame width. Separate the ribs or use a solid rectangle.`);
        parts.splice(parts.indexOf(back), 1); continue;
      }
      upper = pairs.map((p) => p[1]);
      const loop = [...pairs.map((p) => p[0]), ...[...upper].reverse()].flat();
      const distance = polygonDistance(loop, kernel, reach);
      // Both outlines share their outer offset. Fill before applying any slots
      // or mounting holes so switching modes cannot fill a functional opening.
      const source: Distance = (x, y) => (filled ? distance(x, y) : Math.abs(distance(x, y))) - frameWidth / 2;
      const box = polyBox(loop), pad = frameWidth / 2;
      back.source = back.field = source;
      back.box = { minX: box.minX - pad, maxX: box.maxX + pad, minY: box.minY - pad, maxY: box.maxY + pad };
      back.step = Math.max(back.step, (back.box.maxX - back.box.minX) / 1400, (back.box.maxY - back.box.minY) / 1400);
      if (!filled && !samples(box, Math.max(back.step, minBridge / 2), (x, y) => distance(x, y) < -pad - minBridge))
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
      if (made > 0 && made === tabZ.length) joints.push({ id: `${rib.meta.id}:${back.meta.id}`, parts: [rib.meta.id, back.meta.id], instruction: `Insert ${rib.meta.label} along its negative U direction until ${made === 1 ? 'the shoulders around its single centred tab' : 'both shoulders'} meet ${back.meta.label}. Dry-fit, then glue with an adhesive suitable for the chosen stock.` });
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

  // Count enabled feature IDs, including ribs whose source plane was empty.
  // A plausible partial support must never be reported as a complete assembly.
  for (const f of children.filter((f) => f.enabled && f.kind === 'assembly:backplate' && !isFreePlate(f))) {
    const expected = children.filter((r) => r.enabled && r.kind === 'assembly:rib' && !isFreePlate(r));
    const missing = expected.filter((r) => !joints.some((j) => j.parts.includes(f.id) && j.parts.includes(r.id)));
    say(missing.length ? 'error' : 'info', [f.id, ...missing.map((r) => r.id)], `Wall attachment: ${expected.length - missing.length} of ${expected.length} enabled ribs have complete tab joints.${missing.length ? ' The named ribs are unattached; resolve their checks before export.' : ''}`);
  }

  // Plan every rib operation from the same profiles, after wall/ring joints
  // but before rib cuts. A previous cut must not shrink the next cutter.
  const ribBases = new Map(ribs.map((r) => [r.meta.id, { ...r, box: { ...r.box }, zones: [...r.zones] }]));
  const ribOperations = children.filter((f) => f.enabled && f.kind === 'assembly:joint');
  const usedPairs = new Set<string>();
  let crossJoints = 0;
  const strip = (a: WorkPart, b: WorkPart) => {
    const sine = dot3(a.meta.u, b.meta.n), cosine = dot3(a.meta.n, b.meta.n);
    const delta = add3(a.meta.origin, mul3(b.meta.origin, -1));
    return { x: -dot3(delta, b.meta.n) / sine,
      half: (b.meta.thickness / 2 + fit + Math.abs(cosine) * a.meta.thickness / 2) / Math.abs(sine), sine, cosine };
  };
  for (const f of ribOperations) {
    const a = ribs.find((r) => r.meta.id === f.params.ribA), b = ribs.find((r) => r.meta.id === f.params.ribB);
    const ids = [f.id, String(f.params.ribA || ''), String(f.params.ribB || '')].filter(Boolean);
    if (a && a === b) { say('error', ids, 'Both references select the same rib. Choose two different ribs for an intersection.'); continue; }
    if (!a || !b) { say('error', ids, 'A referenced rib is missing, disabled, in free placement or has no source profile. Choose two linked upright ribs in this assembly, or disable the operation.'); continue; }
    const key = [a.meta.id, b.meta.id].sort().join(':');
    if (usedPairs.has(key)) { say('error', ids, 'This rib pair has more than one enabled operation. Keep one cross joint or clearance cut.'); continue; }
    usedPairs.add(key);
    const aa = ribBases.get(a.meta.id)!, bb = ribBases.get(b.meta.id)!;
    const sa = strip(aa, bb), sb = strip(bb, aa);
    if (Math.abs(sa.sine) < 0.25) { say('error', ids, 'Rib operations need a crossing angle of at least about 15 degrees. Separate nearly parallel ribs or change their angles.'); continue; }
    const operation = String(f.params.operation || 'cross');
    if (!['cross', 'clearance'].includes(operation)) { say('error', ids, 'Unknown rib operation. Choose Cross joint or Clearance cut.'); continue; }
    if (operation === 'cross' && supports.length) { say('error', ids, 'Rib cross joints require a wall-mounted or loose-rib layout in this version. Horizontal ring supports use a different insertion path.'); continue; }
    const cuts: { part: WorkPart; cut: Distance; box: Box2 }[] = [];
    let instruction = '';
    if (operation === 'cross') {
      const lo = Math.max(aa.box.minY + aa.meta.origin[2], bb.box.minY + bb.meta.origin[2]);
      const hi = Math.min(aa.box.maxY + aa.meta.origin[2], bb.box.maxY + bb.meta.origin[2]);
      const step = Math.max(aa.step, bb.step), count = Math.max(1, Math.ceil((hi - lo) / step));
      const bands: [number, number][] = [];
      let start: number | undefined;
      for (let i = 0; i <= count + 1; i++) {
        const z = lo + (hi - lo) * i / count;
        const inside = hi > lo && i <= count && aa.field(sa.x, z - aa.meta.origin[2]) < -minBridge / 2 && bb.field(sb.x, z - bb.meta.origin[2]) < -minBridge / 2;
        if (inside) start ??= z;
        else if (start !== undefined) { bands.push([start, z - (hi - lo) / count]); start = undefined; }
      }
      if (bands.length !== 1 || bands[0][1] - bands[0][0] < 2 * minBridge) { say('error', ids, 'A cross joint needs one continuous shared band of rib material. These ribs miss, cross separate regions or have too little overlap.'); continue; }
      const split = num(f, 'split', 50), relief = num(f, 'reliefRadius', 0.5);
      if (!(split > 0 && split < 100) || relief < 0 || relief > Math.min(sa.half, sb.half)) { say('error', ids, 'Joint split must be between 0 and 100 percent; tip relief must be nonnegative and no larger than half the slot width.'); continue; }
      const z = bands[0][0] + (bands[0][1] - bands[0][0]) * split / 100;
      const upper = f.params.upper === 'a' ? a : f.params.upper === 'b' ? b : Number(a.meta.id.slice(1)) < Number(b.meta.id.slice(1)) ? a : b;
      let supported = true;
      for (const [part, base, s] of [[a, aa, sa], [b, bb, sb]] as const) {
        const localZ = z - part.meta.origin[2];
        // The closed end and both side bridges must sit in real material.
        if ([s.x - s.half - relief, s.x, s.x + s.half + relief].some((x) => [localZ - fit - relief, localZ + fit + relief].some((y) => base.field(x, y) > -minBridge))) supported = false;
        const opensUp = part === upper, tip = localZ + (opensUp ? -fit : fit);
        const box = { minX: s.x - s.half - relief, maxX: s.x + s.half + relief,
          minY: opensUp ? tip - relief : part.box.minY - step, maxY: opensUp ? part.box.maxY + step : tip + relief };
        const slot = rect(s.x - s.half, opensUp ? tip : box.minY, s.x + s.half, opensUp ? box.maxY : tip);
        const cut: Distance = relief > 0 ? (x, y) => Math.min(slot(x, y), Math.hypot(x - s.x - s.half, y - tip) - relief, Math.hypot(x - s.x + s.half, y - tip) - relief) : slot;
        cuts.push({ part, cut, box });
      }
      if (!supported) { say('error', ids, 'The slot ends would leave too little shoulder or side material. Change the split, reduce tip relief, or move the crossing away from the rib edge.'); continue; }
      const lower = upper === a ? b : a;
      instruction = `${upper.meta.label} opens upward and ${lower.meta.label} downward at assembly Z ${z.toFixed(2)} mm. Fit the complementary full-thickness slots using the checked assembly order. Dry-fit before gluing.`;
    } else {
      const delta = add3(aa.meta.origin, mul3(bb.meta.origin, -1));
      const u0 = dot3(delta, bb.meta.u), ux = dot3(aa.meta.u, bb.meta.u), un = dot3(aa.meta.n, bb.meta.u);
      const n0 = dot3(delta, bb.meta.n), halfA = aa.meta.thickness / 2, halfB = bb.meta.thickness / 2 + fit;
      const slack = Math.max(aa.step, bb.step, Math.abs(un) * aa.meta.thickness / 64);
      const box = { minX: sa.x - sa.half, maxX: sa.x + sa.half, minY: bb.box.minY + bb.meta.origin[2] - aa.meta.origin[2] - fit - slack, maxY: bb.box.maxY + bb.meta.origin[2] - aa.meta.origin[2] + fit + slack };
      const cut: Distance = (x, y) => {
        const band = Math.abs(x - sa.x) - sa.half;
        if (band > 0 || y < box.minY || y > box.maxY) return Math.max(band, box.minY - y, y - box.maxY);
        let low = -halfA, high = halfA;
        if (Math.abs(sa.cosine) > 1e-8) {
          const s0 = (-halfB - n0 - sa.sine * x) / sa.cosine, s1 = (halfB - n0 - sa.sine * x) / sa.cosine;
          low = Math.max(low, Math.min(s0, s1)); high = Math.min(high, Math.max(s0, s1));
        }
        if (low > high) return Math.max(band, 1e-9);
        const first = u0 + ux * x + un * low, last = u0 + ux * x + un * high;
        const count = Math.max(1, Math.min(64, Math.ceil(Math.abs(last - first) / Math.max(aa.step, bb.step))));
        let d = Infinity;
        for (let i = 0; i <= count; i++) d = Math.min(d, bb.field(first + (last - first) * i / count, y + aa.meta.origin[2] - bb.meta.origin[2]));
        // A 1-Lipschitz sheet field bounds what lies between thickness samples.
        // This conservative slack avoids leaving material in the other slab.
        return Math.max(band, d - fit - Math.abs(last - first) / (2 * count));
      };
      if (!overlaps(aa, cut, box)) { say('error', ids, 'The clearance cut misses the selected rib. Move the ribs or disable this operation.'); continue; }
      cuts.push({ part: a, cut, box });
    }
    let valid = true;
    for (const { part, cut, box } of cuts) {
      if (part.zones.some((zone) => samples(zone.box, Math.max(part.step, 0.5), (x, y) => zone.field(x, y) < minBridge && cut(x, y) < minBridge))) {
        say('error', [f.id, part.meta.id], 'This rib cut conflicts with an existing wall tab, support slot or rib joint. Move the crossing or revise the joint.'); valid = false; continue;
      }
      const candidate: Distance = (x, y) => Math.max(part.field(x, y), -cut(x, y));
      const contours = kernel.trace(candidate, part.box, part.step, 0, Math.min(options.tolerance, part.step / 12));
      if (contours.filter((c) => !c.isHole).length !== 1) { say('error', [f.id, part.meta.id], 'The rib would not remain one connected piece after this cut. Change the crossing, choose the other rib, or use a cross joint. No cuts from this operation were applied.'); valid = false; }
      if (!overlaps(part, cut, box)) { say('error', [f.id, part.meta.id], 'This rib operation has no remaining material to cut. Disable the redundant operation.'); valid = false; }
    }
    if (!valid) continue;
    for (const { part, cut, box } of cuts) { subtract(part, cut); part.zones.push({ field: cut, box: { minX: Math.max(box.minX, part.box.minX), maxX: Math.min(box.maxX, part.box.maxX), minY: Math.max(box.minY, part.box.minY), maxY: Math.min(box.maxY, part.box.maxY) } }); }
    if (operation === 'cross') { crossJoints++; joints.push({ id: f.id, parts: [a.meta.id, b.meta.id], instruction }); say('info', ids, instruction); }
    else say('info', ids, `Clearance cut applied to ${a.meta.label} around ${b.meta.label}. No rib-to-rib attachment was created.`);
  }

  for (const f of children.filter((f) => f.kind === 'assembly:channel')) {
    const componentName = f.params.rod === true ? 'Rod' : 'LED';
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
    if (f.enabled && missingIds.length) say('error', [f.id, ...missingIds], `Explicit ${componentName} targets are missing or disabled. Update the target IDs.`);
    let length = num(f, 'length', radius * 3);
    let low = -length / 2, high = length / 2;
    if (f.params.through !== false && chosen.length) {
      const extents = chosen.flatMap((p) => [p.box.minX, p.box.maxX].flatMap((x) => [p.box.minY, p.box.maxY].flatMap((y) => [-p.meta.thickness / 2, p.meta.thickness / 2].map((z) => dot3(add3(sheetWorld(p.meta, x, y, z), mul3(position, -1)), direction)))));
      low = Math.min(...extents) - Math.max(width, h); high = Math.max(...extents) + Math.max(width, h); length = high - low;
    }
    const start = add3(position, mul3(direction, low)), end = add3(position, mul3(direction, high));
    const result = { ...(f.params.rod === true ? { kind: 'rod' as const } : {}), id: f.id, hits: [] as string[], status: '', origin: position, localOrigin: position, start, end, u: a, v: b, width, height: h };
    channels.push(result);
    if (!f.enabled) { result.status = 'Disabled; no cuts applied.'; continue; }
    const componentValid = tube ? num(f, 'diameter', 16) > 0 : num(f, 'width', 12) > 0 && num(f, 'height', 5) > 0 && num(f, 'cornerRadius') >= 0 && num(f, 'cornerRadius') <= Math.min(num(f, 'width', 12), num(f, 'height', 5)) / 2;
    if (!(length > 0 && width > 0 && h > 0 && clearance >= 0 && componentValid)) {
      result.status = 'Invalid route or cross-section.'; say('error', [f.id], `${componentName} component dimensions and length must be positive; clearance cannot be negative, and corner radius must fit the component.`); continue;
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
        say('error', [f.id, part.meta.id], f.params.rod === true ? 'The rod ends inside this sheet or runs along its face. Extend or rotate it for a complete crossing.' : 'The route ends inside this sheet or runs along its face. A closed laser opening needs a complete crossing; extend the route or choose an edge-open notch.'); continue;
      }
      if (!edgeOpen && !boundaryFits(polygon, part, minBridge)) {
        say('error', [f.id, part.meta.id], `The closed ${componentName} opening reaches an edge, existing opening or insufficient bridge. ${f.params.rod === true ? 'Move the rod or reduce its diameter.' : 'Move it or explicitly choose an edge-open notch.'}`); continue;
      }
      if (edgeOpen) {
        const angle = num(f, 'openAngle', 90) * Math.PI / 180;
        const span = Math.hypot(part.box.maxX - part.box.minX, part.box.maxY - part.box.minY) + Math.hypot(box.maxX - box.minX, box.maxY - box.minY);
        const dx = Math.cos(angle) * span * 2, dy = Math.sin(angle) * span * 2;
        polygon = convexHull(polygon.reduce<number[][]>((out, x, i) => { if (i % 2 === 0) out.push([x, polygon[i + 1]], [x + dx, polygon[i + 1] + dy]); return out; }, []));
        box = polyBox(polygon); cut = polygonDistance(polygon, kernel, reach);
      }
      if (part.zones.some((zone) => samples(zone.box, Math.max(part.step, 0.5), (x, y) => zone.field(x, y) < minBridge && cut(x, y) < minBridge))) {
        say('error', [f.id, part.meta.id], `The ${componentName} opening conflicts with a joint or mounting opening. Move the route or change its dimensions.`); continue;
      }
      subtract(part, cut); result.hits.push(part.meta.id);
    }
    for (const part of parts.filter((p) => !chosen.includes(p))) {
      const opening = prismOpening(part.meta, start, end, a, b, section);
      if (opening.length && overlaps(part, polygonDistance(opening, kernel, reach), polyBox(opening))) {
        say('error', [f.id, part.meta.id], `An excluded part obstructs the ${componentName} component. Include it as a target or move the route. No cut was made in this part.`);
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
      if (lowBlocked && highBlocked) say('error', [f.id], f.params.rod === true ? 'Both straight rod insertion directions are obstructed. Revise the surrounding parts or rod placement.' : 'Both straight insertion directions are obstructed. Use an edge-open notch or revise the surrounding parts.');
      else say('info', [f.id], `${componentName} insertion: feed from the route ${!lowBlocked ? 'start' : 'end'} after dry-fitting the assembly. Component retention is a separate design decision.`);
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
  let remainingRibCollision = false;
  for (let a = 0; a < parts.length; a++) for (let b = a + 1; b < parts.length; b++) {
    if (!collision(parts[a], parts[b])) continue;
    const pair: [string, string] = [parts[a].meta.id, parts[b].meta.id];
    const ribPair = parts[a].meta.kind === 'rib' && parts[b].meta.kind === 'rib';
    remainingRibCollision ||= ribPair;
    say('error', pair, 'Finished sheets intersect outside their clearances. Move the parts or revise their joints.', ribPair ? pair : undefined);
  }
  const extent = (p: WorkPart, d: Vec3) => [p.box.minX, p.box.maxX].flatMap((x) => [p.box.minY, p.box.maxY].flatMap((y) => [-p.meta.thickness / 2, p.meta.thickness / 2].map((n) => dot3(sheetWorld(p.meta, x, y, n), d))));
  const blocked = (a: WorkPart, b: WorkPart, d: Vec3) => {
    const length = Math.max(0, Math.max(...extent(b, d)) - Math.min(...extent(a, d))) + Math.max(a.meta.thickness, b.meta.thickness);
    const count = Math.max(24, Math.min(96, Math.ceil(length / Math.max(minBridge, Math.min(a.meta.thickness, b.meta.thickness)))));
    // Do not step over a thin parallel sheet while removing an end plate.
    const dn = dot3(d, b.meta.n);
    if (Math.abs(dot3(a.meta.n, b.meta.n)) > 1 - 1e-8 && Math.abs(dn) > 1e-8) {
      const station = dot3(add3(b.meta.origin, mul3(a.meta.origin, -1)), b.meta.n) / dn;
      if (station > 0 && collision(a, b, mul3(d, station))) return true;
    }
    for (let i = 1; i <= count; i++) if (collision(a, b, mul3(d, length * i / count))) return true;
    return false;
  };
  if (crossJoints) {
    // Crossed ribs form a network before the wall plate is installed. Search
    // a deterministic disassembly sequence, then reverse it for assembly.
    const walls = backs.filter((b) => parts.includes(b));
    for (const back of walls) {
      const blockedBy = ribs.filter((rib) => blocked(back, rib, [0, -1, 0]));
      if (blockedBy.length) say('error', [back.meta.id, ...blockedBy.map((r) => r.meta.id)], 'The wall plate cannot slide onto the assembled rib network from behind. Shorten protruding tabs or revise the wall plane, rib angles or joints.');
      else say('info', [back.meta.id], `After assembling the ribs, fit ${back.meta.label} from behind along assembly +Y until the shoulders meet. Keep the wall plate off during rib assembly.`);
      for (const joint of joints.filter((j) => j.parts.includes(back.meta.id))) joint.instruction = `After assembling the rib network, fit ${back.meta.label} from behind along assembly +Y onto this rib's tabs. Dry-fit all shoulders before gluing.`;
    }
    if (remainingRibCollision) say('error', [layout.id], 'Resolve the remaining rib collisions before checking the rib-network assembly order.');
    else {
      const remaining = [...ribs], removal: { part: WorkPart; direction: string }[] = [];
      while (remaining.length) {
        let found: { part: WorkPart; direction: string } | undefined;
        for (const axis of ['above', 'below', 'front'] as const) {
          for (const part of remaining) {
            const direction: Vec3 = axis === 'above' ? [0, 0, 1] : axis === 'below' ? [0, 0, -1] : part.meta.u;
            if (remaining.every((fixed) => fixed === part || !blocked(part, fixed, direction))) { found = { part, direction: axis }; break; }
          }
          if (found) break;
        }
        if (!found) break;
        removal.push(found); remaining.splice(remaining.indexOf(found.part), 1);
      }
      if (remaining.length) say('error', remaining.map((r) => r.meta.id), 'No straight individual-rib assembly sequence was found. Swap slot opening directions, change the split or revise the crossing layout. Moving groups together is not checked.');
      else say('info', [layout.id, ...removal.map((r) => r.part.meta.id)], `Rib-network assembly order (wall plate off): ${removal.reverse().map((r, i) => `${i + 1}. ${r.part.meta.label} from ${r.direction === 'front' ? 'its positive U side' : r.direction}`).join('; ')}. Directions are in the assembly frame. Sweeps are sampled; verify this sequence with a physical coupon.`);
    }
  } else {
    // Every rib moves on its own U axis from outside the assembly. A swept
    // collision against another rib determines an insertion dependency. Cycles
    // mean there is no sequential assembly order, even if the final pose fits.
    const before = new Map<string, Set<string>>(ribs.map((r) => [r.meta.id, new Set<string>()]));
    for (const rib of ribs) {
      for (const fixed of [...openSupports, ...backs.filter((p) => parts.includes(p)), ...ribs.filter((r) => r !== rib)]) {
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
  }
  if (socketSupports.length && socketSupports.every(cap => expectedRibs.length > 0 && expectedRibs.every(rib => joints.some(j => j.parts.includes(cap.meta.id) && j.parts.includes(rib.id))))) {
    const remaining = [...socketSupports], removed: WorkPart[] = [];
    while (remaining.length) {
      const removable = remaining.find(cap => parts.every(fixed => fixed === cap || removed.includes(fixed) || !blocked(cap, fixed, [0, 0, socketSign(cap)])));
      if (!removable) break;
      removed.push(removable); remaining.splice(remaining.indexOf(removable), 1);
    }
    if (remaining.length) {
      const obstacles = parts.filter(fixed => !removed.includes(fixed) && remaining.some(cap => fixed !== cap && blocked(cap, fixed, [0, 0, socketSign(cap)])));
      say('error', [...remaining, ...obstacles].map(p => p.meta.id), 'A closed-socket end plate cannot slide onto the assembled parts from its chosen side. Move the named obstructing parts, change Install from or use Cross slots. Group motions are not checked.');
    }
    else say('info', removed.map(p => p.meta.id), `After the ribs and open-slot supports, install closed-socket end plates in this order: ${removed.reverse().map(p => `${p.meta.label} from ${socketSign(p) > 0 ? 'above (-Z)' : 'below (+Z)'}`).join(', ')}. Seat the shoulders, dry-fit and glue. Insertion checks are sampled; confirm with a physical coupon.`);
    joints.sort((a, b) => Number(a.parts.some(id => socketSupports.some(p => p.meta.id === id))) - Number(b.parts.some(id => socketSupports.some(p => p.meta.id === id))));
  }
  if (ribs.length && !supports.length && !backs.length) say('warning', ribs.map((p) => p.meta.id), crossJoints ? 'No wall plate or horizontal supports are enabled. Rib cross joints do not establish a mounting or load rating.' : 'No supports are enabled. These are loose ribs with no generated attachment.');

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
    const slice: Slice = { index: slices.length + 1, z: meta.origin[2], zBottom: meta.origin[2] - meta.thickness / 2, contours, nominalContours: nominal, circles: [], part: meta };
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
    assembly: { id: layout.id, origin: translation, cuttable: !issues.some((i) => i.severity === 'error'), issues: compact, joints, channels } };
}
