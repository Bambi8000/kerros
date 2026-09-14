/** Internal cross-lapped spines for the original horizontal stack. */
import type { Feature } from './types.ts';
import type { Contour, Slice, SliceSet } from './slice.ts';
import type { AssemblyKernel, Box2 } from './assembly.ts';

type Distance = (x: number, y: number) => number;
type Report = NonNullable<SliceSet['verticalSupports']>;
const RAD = Math.PI / 180;
const number = (f: Feature, key: string, fallback: number) =>
  typeof f.params[key] === 'number' && Number.isFinite(f.params[key]) ? f.params[key] as number : fallback;
const boxOf = (contours: Contour[]): Box2 => {
  const xs = contours.flatMap(c => c.points.filter((_, i) => i % 2 === 0));
  const ys = contours.flatMap(c => c.points.filter((_, i) => i % 2 === 1));
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};
function rectangle(x: number, y: number, x0: number, x1: number, y0: number, y1: number): number {
  const a = Math.abs(x - (x0 + x1) / 2) - (x1 - x0) / 2;
  const b = Math.abs(y - (y0 + y1) / 2) - (y1 - y0) / 2;
  return Math.hypot(Math.max(a, 0), Math.max(b, 0)) + Math.min(Math.max(a, b), 0);
}
function contour(points: number[]): Contour {
  let area = 0;
  for (let i = 0; i < points.length; i += 2) {
    const j = (i + 2) % points.length;
    area += points[i] * points[j + 1] - points[j] * points[i + 1];
  }
  return { points, area: area / 2, isHole: area < 0 };
}

/** No feature means exact legacy output, including object identity. */
export function buildVerticalSupports(
  set: SliceSet, nominal: SliceSet, features: Feature[],
  options: { minFeature: number; tolerance: number; layerIndices: number[] },
  turnAt: (slice: Slice) => number, kernel: AssemblyKernel,
): SliceSet {
  const enabled = features.filter(f => f.enabled && f.kind === 'verticalSupports');
  if (!enabled.length) return set;
  const report: Report = { parts: [], contacts: [], issues: [] };
  const fail = (message: string) => {
    report.issues.push({ severity: 'error', message });
    return { ...set, verticalSupports: { ...report, parts: [], contacts: [] } };
  };
  if (enabled.length !== 1) return fail('Use one Vertical supports group. Set its count, or disable the additional groups.');
  if (set.slices.length !== nominal.slices.length || set.slices.some((slice, i) => slice.index !== nominal.slices[i].index || Math.abs(slice.z - nominal.slices[i].z) > 1e-8))
    return fail('Kerf compensation changes which layers contain material. Revise the thin source geometry or kerf before adding vertical supports.');
  const feature = enabled[0];
  const automatic = feature.params.fit === 'auto';
  const count = Math.round(number(feature, 'count', 3));
  const depth = number(feature, 'depth', 12), engagement = number(feature, 'engagement', 4);
  const clearance = number(feature, 'clearance', 0.2), t = set.thickness;
  let cx = number(feature, 'px', 0), cy = number(feature, 'py', 0);
  let layers = nominal.slices.filter(s => automatic || options.layerIndices.includes(s.index));
  const bridge = Math.max(options.minFeature, set.kerf * 2, 0.5);
  if (count < 1 || count > 12 || (!automatic && (depth < bridge * 2 || engagement < bridge * 2)) || clearance < 0 || clearance > t / 2)
    return fail(automatic ? 'Use 1–12 supports and clearance between 0 and half the sheet thickness.' : `Use 1–12 supports, depth and engagement at least ${(bridge * 2).toFixed(2)} mm, and clearance between 0 and half the sheet thickness.`);
  if (layers.length < 2) return fail('Vertical supports need at least two nonempty layers in the selected range.');
  const separate = layers.filter(s => s.contours.filter(c => !c.isHole).length !== 1);
  if (!automatic && separate.length)
    return fail(`Layers ${separate.map(s => s.index).join(', ')} contain separate pieces. Each selected layer must be one connected ring around the support centre. Narrow the Manual layer range, or choose Automatic to look for a usable continuous range. Branches need separate attachment.`);
  const span = Math.max(layers.at(-1)!.zBottom + t - layers[0].zBottom + bridge * 4,
    ...layers.map(layer => { const b = boxOf(layer.contours); return Math.max(b.maxX - b.minX, b.maxY - b.minY); }));
  const step = Math.max(span / 1400, Math.min(0.15, t / 12, bridge / 8));
  if (step > Math.min(t / 4, bridge / 3))
    return fail('The part span is too large to resolve these stock-thickness slots. Use thicker stock or a smaller span.');
  const full = nominal.slices.map(slice => {
    const a = turnAt(slice) * RAD, c = Math.cos(a), s = Math.sin(a);
    const distance = kernel.distance(slice.contours, 12);
    const holes = slice.contours.filter(c => c.isHole).map(hole => kernel.distance([hole], 12));
    return { slice, distance, holes, local: (x: number, y: number): [number, number] => [x * c + y * s, -x * s + y * c] };
  });
  if (automatic) {
    const cavities = full.flatMap(input => input.slice.contours.filter(c => c.isHole).map(hole => ({ input, hole })));
    cavities.sort((a, b) => Math.abs(b.hole.area) - Math.abs(a.hole.area));
    if (!cavities.length) return fail('Automatic fit found no cavity enclosed by the sliced contours. Add a Shell, thicken an open wall or increase slicing resolution.');
    const { input, hole } = cavities[0], b = boxOf([hole]);
    const x = (b.minX + b.maxX) / 2, y = (b.minY + b.maxY) / 2, a = turnAt(input.slice) * RAD;
    cx = x * Math.cos(a) - y * Math.sin(a); cy = x * Math.sin(a) + y * Math.cos(a);
  }
  // Measure once, before tracing any cut parts. Automatic fitting never retries
  // the expensive slicer or changes the requested stock, count or clearance.
  const measure = (layer: Slice, ordinal: number): { innerMin: number; innerMax: number; outerMin: number } | string => {
    const input = full.find(row => row.slice.index === layer.index)!;
    if (layer.contours.filter(c => !c.isHole).length !== 1) return 'the layer has separate pieces';
    if (!input.holes.some(hole => hole(...input.local(cx, cy)) < -bridge)) return 'the centre is closed or outside its cavity';
    const angle = (number(feature, 'angle', 0) + ordinal * 360 / count) * RAD, c = Math.cos(angle), s = Math.sin(angle);
    const worldDistance = (u: number, v: number) => input.distance(...input.local(cx + c * u - s * v, cy + s * u + c * v));
    const b = boxOf(layer.contours);
    const limit = Math.max(...[b.minX, b.maxX].flatMap(x => [b.minY, b.maxY].map(y => Math.hypot(x, y)))) + Math.hypot(cx, cy) + 5;
    let innerMin = Infinity, innerMax = -Infinity, outerMin = Infinity;
    // The whole stock strip must enter the same cavity, not only its centre line.
    for (let row = 0; row <= 8; row++) {
      const v = (row / 8 - 0.5) * (t + clearance + 2 * bridge);
      if (worldDistance(0, v) <= bridge) return 'the centre is closed or too narrow';
      const crossings: number[] = [];
      let previous = worldDistance(0, v);
      for (let u = 0.25; u <= limit; u += 0.25) {
        const d = worldDistance(u, v);
        if ((d < 0) !== (previous < 0)) {
          let lo = u - 0.25, hi = u;
          for (let k = 0; k < 16; k++) {
            const mid = (lo + hi) / 2;
            if ((worldDistance(mid, v) < 0) === (previous < 0)) lo = mid; else hi = mid;
          }
          crossings.push((lo + hi) / 2);
          if (crossings.length === 2) break;
        }
        previous = d;
      }
      if (crossings.length !== 2) return 'there is no complete wall at this angle';
      innerMin = Math.min(innerMin, crossings[0]); innerMax = Math.max(innerMax, crossings[0]); outerMin = Math.min(outerMin, crossings[1]);
    }
    return { innerMin, innerMax, outerMin };
  };
  const measured = layers.map(layer => ({ layer, walls: Array.from({ length: count }, (_, ordinal) => measure(layer, ordinal)) }));
  const fitted = new Map<string, { depth: number; engagement: number }>();
  const web = bridge + clearance / 2 + 2 * step + Math.min(options.tolerance, 0.02);
  if (automatic) {
    const targetEngagement = Math.max(t * 2, web * 2), targetDepth = Math.max(t * 4, web * 4);
    const candidates = measured.map(row => {
      let reason = '';
      const dimensions = row.walls.map(wall => {
        if (typeof wall === 'string') { reason ||= wall; return { depth: 0, engagement: 0 }; }
        const engagement = Math.min(targetEngagement, wall.outerMin - wall.innerMax - web);
        if (engagement < 2 * web) reason ||= 'the wall is too thin for two joint shoulders and an outer bridge';
        return { depth: targetDepth, engagement };
      });
      return { ...row, dimensions, reason };
    });
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const travel = Math.max(0, ...candidates.filter(row => !row.reason).map(row => {
        const wall = row.walls[ordinal];
        return typeof wall === 'string' ? 0 : wall.innerMax + row.dimensions[ordinal].engagement - wall.innerMin;
      })) + clearance + step;
      const minimumBack = (t / 2 + bridge) / (count > 1 ? Math.sin(Math.PI / count) : 1) + travel + step;
      for (const row of candidates) {
        const wall = row.walls[ordinal], dimensions = row.dimensions[ordinal];
        if (typeof wall === 'string') continue;
        dimensions.depth = Math.min(targetDepth, wall.innerMin - minimumBack);
        if (dimensions.depth < 2 * web) row.reason ||= 'the cavity is too narrow for insertion at this support count';
      }
    }
    const first = candidates.findIndex(row => !row.reason), last = candidates.findLastIndex(row => !row.reason);
    if (first < 0 || first === last) {
      const reason = candidates.find(row => row.reason && row.walls.every(wall => typeof wall !== 'string'))?.reason
        ?? candidates.find(row => row.reason)?.reason ?? 'the cavity is too short';
      return fail(`Automatic fit needs at least two usable layers: ${reason}. Try fewer supports, a larger cavity or a thicker shell.`);
    }
    const chosen = candidates.slice(first, last + 1);
    const interrupted = chosen.find(row => row.reason);
    if (interrupted) return fail(`Automatic fit cannot span layer ${interrupted.layer.index}: ${interrupted.reason}. Adjust the source or use a Manual layer range; interior layers are never skipped.`);
    for (const row of chosen) row.dimensions.forEach((dimensions, ordinal) => fitted.set(`${ordinal}:${row.layer.index}`, dimensions));
    layers = chosen.map(row => row.layer);
    const dimensions = chosen.flatMap(row => row.dimensions);
    report.fit = { centre: [cx, cy], firstLayer: layers[0].index, lastLayer: layers.at(-1)!.index,
      depth: [Math.min(...dimensions.map(d => d.depth)), Math.max(...dimensions.map(d => d.depth))],
      engagement: [Math.min(...dimensions.map(d => d.engagement)), Math.max(...dimensions.map(d => d.engagement))],
      excluded: candidates.filter(row => row.reason).map(row => ({ layer: row.layer.index, reason: row.reason })) };
  }
  const slots = new Map<number, Distance[]>();
  const tolerance = Math.min(options.tolerance, 0.02);
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const angle = number(feature, 'angle', 0) + ordinal * 360 / count;
    const c = Math.cos(angle * RAD), s = Math.sin(angle * RAD);
    const id = `${feature.id}-support-${ordinal + 1}`;
    const stations: { layer: number; bottom: number; top: number; back: number; outer: number; split: number; entry: number }[] = [];
    for (const layer of layers) {
      const wall = measured.find(row => row.layer.index === layer.index)!.walls[ordinal];
      if (typeof wall === 'string') return fail(`Support ${ordinal + 1}, layer ${layer.index}: ${wall}. Open the cavity, move the centre, or change the layer range.`);
      const { innerMin, innerMax, outerMin } = wall;
      const dimensions = fitted.get(`${ordinal}:${layer.index}`) ?? { depth, engagement };
      const back = innerMin - dimensions.depth, outer = innerMax + dimensions.engagement, split = innerMax + dimensions.engagement / 2;
      if (outer > outerMin - bridge) return fail(`Support ${ordinal + 1}, layer ${layer.index}: the wall is too narrow for ${engagement.toFixed(2)} mm engagement and a ${bridge.toFixed(2)} mm outer bridge. Reduce engagement or thicken the wall.`);
      const separation = count > 1 ? back * Math.sin(Math.PI / count) : back;
      if (back < bridge || separation < t / 2 + bridge)
        return fail(`Support ${ordinal + 1}, layer ${layer.index}: supports crowd the centre. Reduce depth or count, or enlarge the cavity.`);
      stations.push({ layer: layer.index, bottom: layer.zBottom - clearance / 2, top: layer.zBottom + t + clearance / 2, back, outer, split, entry: innerMin });
      report.contacts.push({ id, layer: layer.index, angle, split });
      const list = slots.get(layer.index) ?? [];
      // Convert from cutting coordinates to the world placement of the sheet.
      const a = turnAt(layer) * RAD, ct = Math.cos(a), st = Math.sin(a);
      list.push((x, y) => {
        const dx = x * ct - y * st - cx, dy = x * st + y * ct - cy;
        return rectangle(dx * c + dy * s, -dx * s + dy * c, 0, split + clearance / 2, -(t + clearance) / 2, (t + clearance) / 2);
      });
      slots.set(layer.index, list);
    }
    // Each support can start fully clear of every sheet inside its own angular
    // sector. This conservative corridor also keeps it clear of the other spines.
    const travel = Math.max(...stations.map(row => row.outer - row.entry)) + clearance + step;
    const startBack = Math.min(...stations.map(row => row.back)) - travel;
    if (startBack * (count > 1 ? Math.sin(Math.PI / count) : 1) < t / 2 + bridge)
      return fail(`Support ${ordinal + 1}: insufficient room in the cavity for outward insertion. Reduce depth, count or engagement, or enlarge the cavity.`);
    for (let i = 1; i < stations.length; i++) {
      if (stations[i].bottom - stations[i - 1].top < bridge)
        return fail(`Layers ${stations[i - 1].layer}–${stations[i].layer}: the gap leaves less than ${bridge.toFixed(2)} mm between support slots. Increase the layer gap or reduce clearance.`);
    }
    // Plateaus span the complete stock slab. Interpolation only occurs in air gaps.
    const rows = stations.flatMap(row => [{ z: row.bottom, ...row }, { z: row.top, ...row }]);
    const endShoulder = automatic ? web : bridge * 2;
    rows.unshift({ ...rows[0], z: rows[0].z - endShoulder });
    rows.push({ ...rows[rows.length - 1], z: rows[rows.length - 1].z + endShoulder });
    const outline = contour([...rows.flatMap(row => [row.outer, row.z]), ...rows.slice().reverse().flatMap(row => [row.back, row.z])]);
    const profile = kernel.distance([outline], 12), box = boxOf([outline]);
    const raw = (u: number, z: number) => {
      let d = profile(u, z);
      // Keep a web beside each slot even where the cavity turns sharply.
      // Union with the continuous spine, so close rows cannot sever its slope.
      if (automatic) for (const row of stations) {
        if (z < row.bottom - web - 2 * step || z > row.top + web + 2 * step) continue;
        d = Math.min(d, rectangle(u, z, row.back, row.outer, row.bottom - web, row.top + web));
      }
      for (const row of stations) {
        if (automatic && (z < row.bottom - 2 * step || z > row.top + 2 * step)) continue;
        d = Math.max(d, -rectangle(u, z, row.split - clearance / 2, box.maxX + 10, row.bottom, row.top));
      }
      return d;
    };
    const nominalContours = kernel.trace(raw, box, step, 0, tolerance);
    if (nominalContours.filter(c => !c.isHole).length !== 1) return fail(`Support ${ordinal + 1}: its slots split the plate. ${automatic ? 'Increase the cavity size or layer spacing, or use Manual to adjust dimensions.' : 'Increase depth or reduce clearance.'}`);
    const distance = kernel.distance(nominalContours, 12);
    // Every part of the spine that crosses a nonselected sheet must remain in air.
    for (const input of full.filter(row => !layers.some(s => s.index === row.slice.index))) {
      if (input.slice.zBottom + t < box.minY || input.slice.zBottom > box.maxY) continue;
      for (let u = box.minX; u <= box.maxX; u += step) for (const z of [input.slice.zBottom, input.slice.z, input.slice.zBottom + t]) {
        if (distance(u, z) >= 0) continue;
        for (const v of [-t / 2, 0, t / 2]) if (input.distance(...input.local(cx + c * u - s * v, cy + s * u + c * v)) < 0)
          return fail(`Support ${ordinal + 1} reaches unselected layer ${input.slice.index}. ${automatic ? 'Increase the layer spacing or use Manual to leave more room at the ends.' : 'Extend the selected range or leave more space above and below it.'}`);
      }
    }
    const plate: Slice = { index: -ordinal - 1, z: 0, zBottom: 0, circles: [], nominalContours,
      contours: kernel.trace(distance, box, step, set.kerf / 2, tolerance),
      part: { id, label: `V${ordinal + 1}`, kind: 'support', origin: [cx, cy, 0], u: [c, s, 0], v: [0, 0, 1], n: [s, -c, 0], thickness: t, kerf: set.kerf, material: 'stock' } };
    if (kernel.thin(plate, bridge)) return fail(`Support ${ordinal + 1}: the finished plate has a narrow bridge. ${automatic ? 'Increase layer spacing or shell thickness, or use Manual to adjust dimensions.' : 'Increase depth, engagement or layer spacing.'}`);
    report.parts.push(plate);
  }
  const slices = set.slices.map(slice => {
    const cuts = slots.get(slice.index);
    if (!cuts) return slice;
    const input = full.find(row => row.slice.index === slice.index)!;
    const box = boxOf(input.slice.contours);
    const raw = (x: number, y: number) => Math.max(input.distance(x, y), -Math.min(...cuts.map(cut => cut(x, y))));
    const nominalContours = kernel.trace(raw, box, step, 0, tolerance);
    if (nominalContours.filter(c => !c.isHole).length !== 1) report.issues.push({ severity: 'error', message: `Layer ${slice.index}: the support notches split the sheet. Change the supports or wall thickness.` });
    const distance = kernel.distance(nominalContours, 12);
    return { ...slice, nominalContours, contours: kernel.trace(distance, box, step, set.kerf / 2, tolerance) };
  });
  const omitted = set.slices.length - layers.length;
  if (omitted && report.fit) {
    const details = [...new Set(report.fit.excluded.map(row => row.reason))].map(reason => {
      const ids = report.fit!.excluded.filter(row => row.reason === reason).map(row => row.layer);
      return `${ids.length === 1 ? 'Layer' : 'Layers'} ${ids.join(', ')} ${ids.length === 1 ? 'has' : 'have'} no vertical support joints: ${reason}.`;
    });
    report.issues.push({ severity: 'warning', message: `${layers.length} of ${set.slices.length} layers are supported. ${details.join(' ')} Attach these end layers separately, or revise the source.` });
  } else if (omitted) report.issues.push({ severity: 'warning', message: `${omitted} layers outside the selected range have no vertical support joints.` });
  return { ...set, slices, verticalSupports: report };
}
