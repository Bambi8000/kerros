/** Orthogonal grid construction. Real tracing and upright joints are injected. */
import type { Feature } from './types.ts';
import type { Bounds, Contour, Slice, SliceSet } from './slice.ts';
import type { AssemblyKernel, AssemblyOptions, Box2, Vec3 } from './assembly.ts';

export type GridAxis = 'x' | 'y' | 'z';
export const GRID_LIMITS = { x: 8, y: 8, z: 64, parts: 1024 } as const;
type Distance = (u: number, v: number) => number;
type Part = NonNullable<Slice['part']>;
type Wall = { feature: Feature; axis: 'x' | 'y'; position: number; slice: Slice; field: Distance; box: Box2; sockets: { box: Box2; field: Distance }[] };
export interface GridKernel extends AssemblyKernel {
  uprights: (features: Feature[], sample: (x: number, y: number, z: number) => number, bounds: Bounds, options: AssemblyOptions, kernel: AssemblyKernel) => SliceSet;
}
const number = (f: Feature, key: string, fallback = 0) => typeof f.params[key] === 'number' && Number.isFinite(f.params[key]) ? f.params[key] as number : fallback;
const boxOf = (contours: Contour[]): Box2 => {
  const xs = contours.flatMap(c => c.points.filter((_, i) => i % 2 === 0)), ys = contours.flatMap(c => c.points.filter((_, i) => i % 2 === 1));
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};
const rectangle = (b: Box2): Distance => (x, y) => {
  const dx = Math.abs(x - (b.minX + b.maxX) / 2) - (b.maxX - b.minX) / 2;
  const dy = Math.abs(y - (b.minY + b.maxY) / 2) - (b.maxY - b.minY) / 2;
  return Math.hypot(Math.max(0, dx), Math.max(0, dy)) + Math.min(0, Math.max(dx, dy));
};
const expand = (b: Box2, d: number): Box2 => ({ minX: b.minX - d, maxX: b.maxX + d, minY: b.minY - d, maxY: b.maxY + d });
const socketDistance = (b: Box2, radius: number): Distance => {
  const rect = rectangle(b);
  return (x, y) => Math.min(rect(x, y), Math.hypot(Math.min(Math.abs(x - b.minX), Math.abs(x - b.maxX)), Math.min(Math.abs(y - b.minY), Math.abs(y - b.maxY))) - radius);
};
function allInside(field: Distance, b: Box2, margin: number, step: number): boolean {
  const nx = Math.max(1, Math.ceil((b.maxX - b.minX) / step)), ny = Math.max(1, Math.ceil((b.maxY - b.minY) / step));
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) {
    if (field(b.minX + (b.maxX - b.minX) * i / nx, b.minY + (b.maxY - b.minY) * j / ny) > -margin) return false;
  }
  return true;
}
export function gridMembers(features: Feature[], layout: Feature, axis: GridAxis) {
  return features.filter(f => f.kind === 'assembly:grid' && f.params.groupId === layout.id && f.params.axis === axis)
    .sort((a, b) => number(a, 'ordinal') - number(b, 'ordinal'));
}
export function gridPlannedParts(features: Feature[], layout: Feature): number {
  const [x, y, z] = (['x', 'y', 'z'] as const).map(axis => gridMembers(features, layout, axis).filter(f => f.enabled).length);
  return (x + 1) * (y + 1) * z + x + y;
}
export function gridPosition(feature: Feature, features: Feature[], layout: Feature): number {
  const axis = feature.params.axis as GridAxis, members = gridMembers(features, layout, axis);
  return (members.findIndex(f => f.id === feature.id) - (members.length - 1) / 2) * number(layout, `spacing${axis.toUpperCase()}`, 30) + number(feature, 'offset');
}
export function gridMember(layout: Feature, axis: GridAxis, features: Feature[], next: number): Feature {
  const members = gridMembers(features, layout, axis), ordinal = Math.max(-1, ...members.map(f => number(f, 'ordinal'))) + 1;
  return { id: `f${next}`, kind: 'assembly:grid', stage: 'SLICE', enabled: true, name: `${axis.toUpperCase()} plane ${ordinal + 1}`,
    params: { groupId: layout.id, axis, ordinal, offset: 0 } };
}
export function gridFeatures(next: number, bounds: Bounds): { features: Feature[]; next: number; id: string } {
  const layout: Feature = { id: `f${next++}`, kind: 'assembly:layout', stage: 'SLICE', name: 'Grid', enabled: true,
    params: { layout: 'grid', jointClearance: 0.1, tabWidth: 8, reliefRadius: 0.5, split: 50, px: 0, py: 0, pz: 0, angle: 0 } };
  const features = [layout];
  (['x', 'y', 'z'] as const).forEach((axis, i) => {
    layout.params[`spacing${axis.toUpperCase()}`] = (bounds.max[i] - bounds.min[i]) * (axis === 'z' ? 0.15 : 0.4);
    layout.params[`sourceCentre${axis.toUpperCase()}`] = (bounds.max[i] + bounds.min[i]) / 2;
    for (let n = 0; n < (axis === 'z' ? 3 : 2); n++) features.push(gridMember(layout, axis, features, next++));
  });
  return { features, next, id: layout.id };
}

export function buildGrid(features: Feature[], sample: (x: number, y: number, z: number) => number, bounds: Bounds, options: AssemblyOptions, kernel: GridKernel): SliceSet {
  const layout = features.find(f => f.enabled && f.kind === 'assembly:layout')!;
  const axes = (['x', 'y', 'z'] as const).map(axis => gridMembers(features, layout, axis).filter(f => f.enabled)
    .map(feature => ({ feature, position: gridPosition(feature, features, layout) })).sort((a, b) => a.position - b.position));
  const [xs, ys, zs] = axes;
  const centre = bounds.min.map((v, i) => (v + bounds.max[i]) / 2) as Vec3;
  const half = bounds.max.map((v, i) => (v - bounds.min[i]) / 2);
  const t = Math.max(0.2, options.thickness), fit = number(layout, 'jointClearance', 0.1);
  const bridge = Math.max(options.minFeature, options.kerf * 2, 0.2), tabWidth = number(layout, 'tabWidth', 8);
  const reach = Math.max(...half) * 4 + 100;
  const step = Math.max(Math.max(...half) * 2 / 1400, Math.min(t / 4, bridge / 2, Math.max(...half) * 2 / Math.max(120, options.resolution)));
  const tol = Math.min(options.tolerance, step / 12);
  const relief = number(layout, 'reliefRadius', 0.5), edgeGap = fit + step;
  const report: NonNullable<SliceSet['assembly']> = { id: layout.id, origin: centre, cuttable: false, issues: [], joints: [], channels: [] };
  const fail = (ids: string[], message: string) => report.issues.push({ severity: 'error', ids, message });
  const result: SliceSet = { slices: [], planes: [], thickness: t, kerf: options.kerf, step, pitch: 0, z0: bounds.min[2], planesExamined: 0, assembly: report };
  if (!(fit >= 0 && tabWidth >= 2 * bridge && options.thickness >= 0.2)) fail([layout.id], 'Grid needs nonnegative clearance, stock at least 0.2 mm thick and tab width at least twice the minimum bridge.');
  if (relief < step || relief > tabWidth / 2) fail([layout.id], `Socket corner relief must be at least ${step.toFixed(2)} mm at this resolution and no more than half the tab width.`);
  if (!xs.length || !ys.length) fail([layout.id], 'Grid needs at least one enabled X plane and one enabled Y plane.');
  const planned = gridPlannedParts(features, layout);
  if (planned > GRID_LIMITS.parts) fail([layout.id], `Grid plans up to ${planned} cut parts, exceeding the ${GRID_LIMITS.parts}-part limit. Reduce X, Y or Z planes; empty cells also count toward this limit.`);
  for (const axis of ['x', 'y', 'z'] as const) {
    const count = gridMembers(features, layout, axis).length;
    if (count > GRID_LIMITS[axis]) fail([layout.id], `${axis.toUpperCase()} has ${count} planes; the limit is ${GRID_LIMITS[axis]}. Reduce the count, including disabled planes.`);
  }
  for (let axis = 0; axis < 3; axis++) {
    if (number(layout, `spacing${'XYZ'[axis]}`, 30) <= t + 2 * fit) fail([layout.id], `${'XYZ'[axis]} spacing must exceed stock thickness plus twice the clearance.`);
    for (let i = 0; i < axes[axis].length; i++) {
      const plane = axes[axis][i];
      if (Math.abs(plane.position) + t / 2 > half[axis] + step) fail([plane.feature.id], 'The grid plane extends outside the source bounds. Reduce spacing or its offset.');
      if (i && plane.position - axes[axis][i - 1].position <= t + 2 * fit) fail([plane.feature.id, axes[axis][i - 1].feature.id], 'Grid planes overlap or leave no clearance. Increase their separation.');
    }
  }
  const unsupported = features.filter(f => f.enabled && (f.kind === 'rod' || (f.kind === 'assembly:layout' && f.id !== layout.id)
    || (f.params.groupId === layout.id && f.kind !== 'assembly:grid')));
  const invalid = features.filter(f => f.enabled && f.params.groupId === layout.id && f.kind === 'assembly:grid' && !['x', 'y', 'z'].includes(String(f.params.axis)));
  if (invalid.length) fail(invalid.map(f => f.id), 'A grid plane has an invalid axis. Restore X, Y or Z before building.');
  if (unsupported.length) fail(unsupported.map(f => f.id), 'Grid cannot combine rods, free plates, other layouts, wall/ring supports or LED channels yet. Disable them; source carving can define the light cavity.');
  const excluded = features.filter(f => f.enabled && !f.kind.startsWith('assembly:') && f.kind !== 'rod' && f.stage !== 'SHAPE' && f.stage !== 'CARVE');
  if (excluded.length) report.issues.push({ severity: 'warning', ids: excluded.map(f => f.id), message: 'Horizontal-layer tools are not applied to Grid parts. Disable Grid to edit their original layers.' });
  if (report.issues.some(i => i.severity === 'error')) return result;

  // Reuse the production upright solver, including connected cuts, slab
  // collisions and sampled disassembly. Grid owns its stations and orientations.
  const baseLayout: Feature = { ...layout, params: { ...layout.params, layout: 'linear', spacing: 1, angle: 0, px: 0, py: 0, pz: 0, ribAngle: 0, oddAngle: 0, evenAngle: 0, fanAngle: 0 } };
  const ribs = [...xs, ...ys].map(({ feature, position }): Feature => ({ ...feature, kind: 'assembly:rib', params: {
    groupId: layout.id, ordinal: number(feature, 'ordinal'), sourceAxis: feature.params.axis, sourceX: position, station: position, angle: 0, px: 0, py: 0, pz: 0,
  } }));
  const joints: Feature[] = [];
  for (const x of xs) for (const y of ys) {
    let contact = false;
    for (let z = bounds.min[2]; z <= bounds.max[2]; z += step) if (sample(centre[0] + x.position, centre[1] + y.position, z) < -bridge / 2) { contact = true; break; }
    if (contact) joints.push({ id: `${x.feature.id}:${y.feature.id}`, kind: 'assembly:joint', stage: 'SLICE', enabled: true, name: 'Grid crossing',
      params: { groupId: layout.id, ribA: x.feature.id, ribB: y.feature.id, operation: 'cross', upper: 'a', split: number(layout, 'split', 50), reliefRadius: 0 } });
  }
  const base = kernel.uprights([baseLayout, ...ribs, ...joints], sample, bounds, options, kernel);
  const owners = new Map(features.map(f => [f.id, f]));
  const labels = new Map([...xs, ...ys].map(p => [p.feature.id, `${String(p.feature.params.axis).toUpperCase()}${p.feature.id.slice(1)}`]));
  const relabel = (text: string) => text.replace(/\bR(\d+)\b/g, (old, id: string) => labels.get(`f${id}`) ?? old).replace('Rib-network assembly order (wall plate off)', 'Upright grid assembly order');
  report.issues.push(...base.assembly!.issues.filter(i => !i.message.startsWith('No wall plate')).map(i => ({ ...i, ids: i.ids.filter(id => owners.has(id)), message: relabel(i.message), ribCollision: undefined })));
  report.joints.push(...base.assembly!.joints.map(j => ({ ...j, instruction: relabel(j.instruction) })));
  const connected = new Set<string>(ribs.length ? [ribs[0].id] : []);
  for (let pass = 0; pass < ribs.length; pass++) for (const joint of report.joints) if (joint.parts.some(id => connected.has(id))) joint.parts.forEach(id => connected.add(id));
  const unconnected = ribs.filter(f => !connected.has(f.id));
  if (unconnected.length) fail(unconnected.map(f => f.id), 'These upright planes have no connection to the main grid. Move their stations or revise the source.');
  const walls: Wall[] = base.slices.map(slice => {
    const feature = owners.get(slice.part!.id)!;
    const position = gridPosition(feature, features, layout), axis = feature.params.axis as 'x' | 'y';
    // Uprights were placed at the source centre; work in centred grid coordinates.
    slice.part = { ...slice.part!, origin: axis === 'x' ? [position, 0, 0] : [0, position, 0], gridAxis: axis, label: labels.get(feature.id)! };
    const baseField = kernel.distance(slice.nominalContours!, reach), sockets: Wall['sockets'] = [];
    const field: Distance = (u, v) => {
      let d = baseField(u, v);
      for (const socket of sockets) {
        // Outside this expanded AABB the socket's distance is greater than
        // -d, so subtracting it cannot change max(d, -socketDistance).
        const margin = Math.max(0, -d), b = socket.box;
        if (u < b.minX - margin || u > b.maxX + margin || v < b.minY - margin || v > b.maxY + margin) continue;
        d = Math.max(d, -socket.field(u, v));
      }
      return d;
    };
    return { feature, axis, position, slice, field, box: boxOf(slice.nominalContours!), sockets };
  });
  const finish = (meta: Part, field: Distance, box: Box2): Slice | undefined => {
    const nominal = kernel.trace(field, expand(box, step * 2), step, 0, tol);
    if (!nominal.length) { fail([meta.featureId ?? meta.id], `${meta.label}: all material was removed.`); return; }
    if (nominal.filter(c => !c.isHole).length !== 1) fail([meta.featureId ?? meta.id], `${meta.label}: the cut produces separate pieces. Revise the source or plane spacing.`);
    const contours = options.kerf > 0 ? kernel.trace(kernel.distance(nominal, reach), expand(box, options.kerf + step * 2), step, options.kerf / 2, tol) : nominal;
    const slice: Slice = { index: 0, z: meta.origin[2], zBottom: meta.origin[2] - t / 2, part: meta, nominalContours: nominal, contours, circles: [] };
    if (kernel.thin({ ...slice, contours: nominal }, bridge)) report.issues.push({ severity: 'warning', ids: [meta.featureId ?? meta.id], message: `${meta.label}: a narrow feature was detected below ${bridge} mm. Inspect the source edges and socket relief before cutting.` });
    return slice;
  };
  const cuts: Slice[] = [];
  const wx = walls.filter(w => w.axis === 'x').sort((a, b) => a.position - b.position), wy = walls.filter(w => w.axis === 'y').sort((a, b) => a.position - b.position);
  // A socket is reserved immediately after a successful tile. The opposite
  // cell must find distinct sockets rather than put two tabs in the same hole.
  for (const plane of zs) {
    let made = 0, empty = 0;
    const z = plane.position, raw: Distance = (x, y) => sample(centre[0] + x, centre[1] + y, centre[2] + z);
    for (let ix = 0; ix <= wx.length; ix++) for (let iy = 0; iy <= wy.length; iy++) {
      const left = wx[ix - 1], right = wx[ix], bottom = wy[iy - 1], top = wy[iy];
      // A full trace cell separates concave tab roots from a receiver face.
      // This is a visible body gap, not extra clearance in the fitted socket.
      const cell: Box2 = { minX: left ? left.position + t / 2 + edgeGap : -half[0], maxX: right ? right.position - t / 2 - edgeGap : half[0],
        minY: bottom ? bottom.position + t / 2 + edgeGap : -half[1], maxY: top ? top.position - t / 2 - edgeGap : half[1] };
      const cellField = rectangle(cell), uncut: Distance = (x, y) => Math.max(raw(x, y), cellField(x, y));
      const nominal = kernel.trace(uncut, expand(cell, step * 2), step, 0, tol);
      if (!nominal.length) { empty++; continue; }
      const label = `Z${plane.feature.id.slice(1)}.${ix + 1}.${iy + 1}`;
      const meta: Part = { id: `${plane.feature.id}:${left?.feature.id ?? 'loX'}:${right?.feature.id ?? 'hiX'}:${bottom?.feature.id ?? 'loY'}:${top?.feature.id ?? 'hiY'}`,
        featureId: plane.feature.id, label, kind: 'support', gridAxis: 'z', origin: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], thickness: t, kerf: options.kerf,
        stockName: options.materialName || 'Stock', material: `${options.materialName || 'Stock'} / ${t} mm / kerf ${options.kerf} mm` };
      let selected: { wall: Wall; field: Distance; box: Box2; sockets: Box2[]; direction: string } | undefined;
      const candidates = [{ wall: left, sign: 1, opposite: right }, { wall: right, sign: -1, opposite: left }, { wall: bottom, sign: 1, opposite: top }, { wall: top, sign: -1, opposite: bottom }];
      for (const { wall, sign, opposite } of candidates) {
        if (!wall) continue;
        const isX = wall.axis === 'x', travel = t + edgeGap + Math.max(step, 0.1), box = { ...cell };
        const low = isX ? 'minX' : 'minY', high = isX ? 'maxX' : 'maxY';
        if (opposite) { if (sign > 0) box[high] -= travel; else box[low] += travel; }
        if (box.maxX - box.minX < 2 * bridge || box.maxY - box.minY < 2 * bridge) continue;
        const clip = rectangle(box), body: Distance = (x, y) => Math.max(raw(x, y), clip(x, y));
        const edge = sign > 0 ? box[low] : box[high];
        const u0 = (isX ? box.minY : box.minX) + tabWidth / 2 + bridge + step, u1 = (isX ? box.maxY : box.maxX) - tabWidth / 2 - bridge - step;
        const available: number[] = [];
        for (let u = u0; u <= u1; u += Math.max(step, 0.5)) {
          const socket = { minX: u - tabWidth / 2 - fit, maxX: u + tabWidth / 2 + fit, minY: z - t / 2 - fit, maxY: z + t / 2 + fit };
          if (!allInside(wall.field, expand(socket, bridge + relief + step), 0, step)) continue;
          const root = [edge + sign * step, edge + sign * (bridge + step)].sort((a, b) => a - b);
          const rootBox = isX ? { minX: root[0], maxX: root[1], minY: u - tabWidth / 2 - bridge, maxY: u + tabWidth / 2 + bridge }
            : { minY: root[0], maxY: root[1], minX: u - tabWidth / 2 - bridge, maxX: u + tabWidth / 2 + bridge };
          if (allInside(body, rootBox, 0, step)) available.push(u);
        }
        if (!available.length) continue;
        // Opposite cells prefer opposite ends of the contact. Reserving both
        // ends for the first cell can strand the final corner of a valid grid.
        const locations = [sign > 0 ? available[0] : available.at(-1)!];
        const sockets = locations.map(u => ({ minX: u - tabWidth / 2 - fit, maxX: u + tabWidth / 2 + fit, minY: z - t / 2 - fit, maxY: z + t / 2 + fit }));
        const tip = wall.position - sign * t / 2, end = edge + sign * (bridge + step), span = [tip, end].sort((a, b) => a - b);
        const tabs = locations.map(u => rectangle(isX ? { minX: span[0], maxX: span[1], minY: u - tabWidth / 2, maxY: u + tabWidth / 2 }
          : { minY: span[0], maxY: span[1], minX: u - tabWidth / 2, maxX: u + tabWidth / 2 }));
        const field: Distance = (x, y) => Math.min(body(x, y), tabs[0](x, y));
        const tabBox = { ...box, [low]: Math.min(box[low], tip), [high]: Math.max(box[high], tip) };
        const tileContours = kernel.trace(field, expand(tabBox, step * 2), step, 0, tol);
        // The expanded socket region was checked inside existing material.
        // Trace each finished receiver once below, after all sockets, where
        // disconnected outlines still block export. Retracing the entire tall
        // upright for every interior socket makes large Z counts quadratic.
        if (tileContours.filter(c => !c.isHole).length !== 1) continue;
        selected = { wall, field, box: tabBox, sockets, direction: `${sign > 0 ? '-' : '+'}${wall.axis.toUpperCase()}` };
        break;
      }
      if (selected) {
        for (const socket of selected.sockets) selected.wall.sockets.push({ box: expand(socket, relief), field: socketDistance(socket, relief) });
        const cut = finish(meta, selected.field, selected.box); if (cut) cuts.push(cut);
        report.joints.push({ id: `${meta.id}:${selected.wall.feature.id}`, parts: [meta.id, selected.wall.feature.id],
          instruction: `${label}: lower into its cell from above, then slide ${selected.direction} into ${selected.wall.slice.part!.label}; ${selected.sockets.length} glued tab(s). Fit horizontal cells bottom to top after the upright grid. The opposite-edge gap provides insertion travel. Dry-fit before gluing.` });
        made++;
      } else {
        fail([plane.feature.id], `${label}: no connected tab joint fits this cell. Increase cell size, move this plane away from cross slots, reduce tab width, or revise the source.`);
        const cut = finish(meta, uncut, cell); if (cut) cuts.push(cut);
      }
    }
    report.issues.push({ severity: 'info', ids: [plane.feature.id], message: `Z${plane.feature.id.slice(1)}: ${made} attached cells; ${empty} cells contain no source material.` });
    if (!made && !cuts.some(c => c.part?.featureId === plane.feature.id)) fail([plane.feature.id], 'This horizontal plane contains no grid material. Move it or disable it.');
  }
  for (const wall of walls) { const slice = finish(wall.slice.part!, wall.field, wall.box); if (slice) result.slices.push(slice); }
  result.slices.push(...cuts);
  const angle = number(layout, 'angle') * Math.PI / 180;
  const rotate = ([x, y, z]: Vec3): Vec3 => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle), z];
  const origin = centre.map((v, i) => v + number(layout, ['px', 'py', 'pz'][i])) as Vec3;
  result.slices.forEach((slice, i) => {
    const part = slice.part!, p = rotate(part.origin);
    part.origin = p.map((v, i) => v + origin[i]) as Vec3;
    part.u = rotate(part.u); part.v = rotate(part.v); part.n = rotate(part.n);
    slice.index = i + 1; slice.z = part.origin[2]; slice.zBottom = slice.z - t / 2;
  });
  report.origin = origin;
  report.issues.push({ severity: 'info', ids: [layout.id], message: `Horizontal body edge gap: ${edgeGap.toFixed(2)} mm. Opposite an attached upright, a bounded cell leaves ${(t + 2 * edgeGap + Math.max(step, 0.1)).toFixed(2)} mm for insertion. Sockets use ${fit.toFixed(2)} mm clearance per side and ${relief.toFixed(2)} mm corner relief.` });
  report.issues.push({ severity: 'warning', ids: [layout.id], message: 'Grid tabs require adhesive and a physical XYZ coupon. Install the upright network first, then horizontal cells from the lowest plane upward. Mounting hardware and load capacity are not established.' });
  report.cuttable = !report.issues.some(i => i.severity === 'error');
  result.planesExamined = xs.length + ys.length + zs.length;
  return result;
}
