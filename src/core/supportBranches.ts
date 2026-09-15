/** Cavity chains meet through one shared horizontal sheet at every fork. */
import type { Feature } from './types.ts';
import type { Contour, ContourGroup, Slice, SliceSet } from './slice.ts';
import type { AssemblyKernel, Box2 } from './assembly.ts';
import type { buildVerticalSupports, VerticalSupportOptions } from './verticalSupports.ts';

type Point = [number, number];
type Field = (x: number, y: number) => number;
type Report = NonNullable<SliceSet['verticalSupports']>;
type Node = { row: number; owner: string; slice: Slice; hole: Contour; centre: Point; box: Box2; field: Field; parents: Node[]; children: Node[] };
type Section = { id: string; label: string; nodes: Node[]; parent?: Section; shared?: Node; centre: Point; angles: number[] };
const RAD = Math.PI / 180;
const num = (f: Feature, key: string, fallback: number) => typeof f.params[key] === 'number' && Number.isFinite(f.params[key]) ? f.params[key] as number : fallback;
function bounds(contours: Contour[]): Box2 {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const contour of contours) for (let i = 0; i < contour.points.length; i += 2) {
    minX = Math.min(minX, contour.points[i]); maxX = Math.max(maxX, contour.points[i]);
    minY = Math.min(minY, contour.points[i + 1]); maxY = Math.max(maxY, contour.points[i + 1]);
  }
  return { minX, minY, maxX, maxY };
}
const rotate = (x: number, y: number, angle: number): Point => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
function worldContour(contour: Contour, angle: number): Contour {
  const points: number[] = [];
  for (let i = 0; i < contour.points.length; i += 2) points.push(...rotate(contour.points[i], contour.points[i + 1], angle));
  return { ...contour, points };
}
function overlap(a: Node, b: Node, margin: number): boolean {
  const x0 = Math.max(a.box.minX, b.box.minX), x1 = Math.min(a.box.maxX, b.box.maxX);
  const y0 = Math.max(a.box.minY, b.box.minY), y1 = Math.min(a.box.maxY, b.box.maxY);
  if (x1 - x0 <= margin * 2 || y1 - y0 <= margin * 2) return false;
  // Interior samples distinguish overlapping cavities from touching envelopes.
  for (let i = 1; i < 12; i++) for (let j = 1; j < 12; j++) {
    const x = x0 + (x1 - x0) * i / 12, y = y0 + (y1 - y0) * j / 12;
    if (a.field(x, y) < -margin && b.field(x, y) < -margin) return true;
  }
  return false;
}

/** A sampled full-stock collision test for upright plates; translation is along U. */
export function supportCollision(a: Slice, b: Slice, kernel: AssemblyKernel, shift = 0, step = 0.2): boolean {
  const pa = a.part!, pb = b.part!, ba = bounds(a.nominalContours!), bb = bounds(b.nominalContours!);
  const za = Math.max(ba.minY, bb.minY), zb = Math.min(ba.maxY, bb.maxY);
  if (za >= zb) return false;
  const ax = pa.origin[0] + pa.u[0] * shift, ay = pa.origin[1] + pa.u[1] * shift;
  const da = kernel.distance(a.nominalContours!, 2), db = kernel.distance(b.nominalContours!, 2);
  const cross = pa.n[0] * pb.n[1] - pa.n[1] * pb.n[0];
  if (Math.abs(cross) < 1e-6) {
    const offset = (ax - pb.origin[0]) * pb.n[0] + (ay - pb.origin[1]) * pb.n[1];
    if (Math.abs(offset) >= (pa.thickness + pb.thickness) / 2 - 0.02) return false;
    const signed = pa.u[0] * pb.u[0] + pa.u[1] * pb.u[1];
    const base = (ax - pb.origin[0]) * pb.u[0] + (ay - pb.origin[1]) * pb.u[1];
    const ends = [(bb.minX - base) / signed, (bb.maxX - base) / signed];
    const u0 = Math.max(ba.minX, Math.min(...ends)), u1 = Math.min(ba.maxX, Math.max(...ends));
    for (let z = za; z <= zb; z += step) for (let u = u0; u <= u1; u += step)
      if (da(u, z) < -0.03 && db(base + signed * u, z) < -0.03) return true;
    return false;
  }
  for (const va of [-0.49, 0, 0.49]) for (const vb of [-0.49, 0, 0.49]) {
    const ca = ax * pa.n[0] + ay * pa.n[1] + va * pa.thickness;
    const cb = pb.origin[0] * pb.n[0] + pb.origin[1] * pb.n[1] + vb * pb.thickness;
    const x = (ca * pb.n[1] - cb * pa.n[1]) / cross, y = (pa.n[0] * cb - pb.n[0] * ca) / cross;
    const ua = (x - ax) * pa.u[0] + (y - ay) * pa.u[1], ub = (x - pb.origin[0]) * pb.u[0] + (y - pb.origin[1]) * pb.u[1];
    if (ua < ba.minX || ua > ba.maxX || ub < bb.minX || ub > bb.maxX) continue;
    for (let z = za; z <= zb; z += step) if (da(ua, z) < -0.03 && db(ub, z) < -0.03) return true;
  }
  return false;
}

export function buildStackSupports(
  set: SliceSet, nominal: SliceSet, features: Feature[], options: VerticalSupportOptions,
  turnAt: (slice: Slice) => number, kernel: AssemblyKernel,
  build: typeof buildVerticalSupports, group: (contours: Contour[]) => ContourGroup[],
): SliceSet {
  const active = features.filter(f => f.enabled && f.kind === 'verticalSupports');
  if (active.length !== 1 || active[0].params.fit !== 'auto' || !nominal.slices.some(s => s.contours.filter(c => c.isHole).length > 1))
    return build(set, nominal, features, options, turnAt, kernel);
  const feature = active[0], count = Math.round(num(feature, 'branchCount', 1));
  const report: Report = { parts: [], contacts: [], issues: [] };
  const fail = (message: string): SliceSet => ({ ...set, verticalSupports: { ...report, parts: [], contacts: [], issues: report.issues.some(i => i.severity === 'error' && i.message === message) ? report.issues : [...report.issues, { severity: 'error', message }] } });
  if (count < 1 || count > 6) return fail('Use 1–6 supports per branch. The requested count is never reduced automatically.');
  if (set.slices.length !== nominal.slices.length || set.slices.some((s, i) => s.index !== nominal.slices[i].index || Math.abs(s.z - nominal.slices[i].z) > 1e-8))
    return fail('Kerf compensation changes layer membership. Revise thin source geometry before fitting branch supports.');
  const bridge = Math.max(options.minFeature, 2 * set.kerf, 0.5), t = set.thickness;
  const ownerContours = new Map<string, Contour[]>(), ownersByRow = new Map<number, string[]>();
  const rows: Node[][] = nominal.slices.map((slice, row) => {
    const nodes: Node[] = [], owners: string[] = [];
    group(slice.contours).forEach((part, index) => {
      const owner = `${slice.index}:${index}`, contours = [part.outer, ...part.holes];
      ownerContours.set(owner, contours); owners.push(owner);
      for (const hole of part.holes) {
        const world = worldContour(hole, turnAt(slice) * RAD), box = bounds([world]);
        nodes.push({ row, owner, slice: { ...slice, contours }, hole: world, box,
          centre: [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2],
          field: kernel.distance([world], bridge * 2), parents: [], children: [] });
      }
    });
    ownersByRow.set(row, owners);
    return nodes.sort((a, b) => a.centre[0] - b.centre[0] || a.centre[1] - b.centre[1]);
  });
  if (rows.some(row => row.length > 8)) return fail('Branch fitting supports at most eight cavities in one layer. Simplify this section of the source.');
  for (let i = 1; i < rows.length; i++) for (const node of rows[i]) for (const parent of rows[i - 1]) {
    if (overlap(parent, node, Math.min(bridge, 0.5))) { parent.children.push(node); node.parents.push(parent); }
  }
  const all = rows.flat(), roots = all.filter(n => !n.parents.length);
  const merge = all.find(n => n.parents.length > 1);
  if (merge) return fail(`Layer ${merge.slice.index}: cavities merge or their projected paths are ambiguous. This fitter handles a single trunk splitting upward; merges need a separate joint design.`);
  if (roots.length !== 1) return fail(`Found ${roots.length} separate cavity starts. Branch supports need one continuous trunk below the forks. Closed interior layers and disconnected sources cannot be bridged by skipping sheets.`);
  const sections: Section[] = [];
  const visit = (start: Node, parent?: Section, shared?: Node) => {
    const nodes = [start];
    while (nodes.at(-1)!.children.length === 1) nodes.push(nodes.at(-1)!.children[0]);
    const largest = nodes.reduce((a, b) => Math.abs(a.hole.area) >= Math.abs(b.hole.area) ? a : b);
    const section: Section = { id: `${feature.id}-branch-${sections.length + 1}`, label: parent ? `Branch ${sections.length}` : 'Trunk', nodes, parent, shared, centre: largest.centre, angles: [] };
    sections.push(section);
    nodes.at(-1)!.children.forEach(child => visit(child, section, nodes.at(-1)));
  };
  visit(roots[0]);
  if (sections.length === 1) return fail('The cavities do not form an upward fork with a shared layer. Adjust the source or use a Manual support range.');
  if (sections.length * count > 48) return fail('This branch layout exceeds 48 support plates. Reduce the support count or simplify the forks.');
  for (const section of sections) {
    let angle: number;
    if (section.parent) angle = Math.atan2(section.centre[1] - section.parent.centre[1], section.centre[0] - section.parent.centre[0]) / RAD;
    else {
      const children = sections.filter(s => s.parent === section);
      const a = children[0].centre, b = children.at(-1)!.centre;
      angle = Math.atan2(b[1] - a[1], b[0] - a[0]) / RAD + 90;
    }
    angle += num(feature, 'angle', 0);
    // Child supports face away from the trunk, leaving distinct shared-sheet
    // joints instead of sending inward spines through the neighbouring branch.
    section.angles = Array.from({ length: count }, (_, i) => angle + (section.parent ? (i - (count - 1) / 2) * 180 / (count + 1) : i * 360 / count));
  }
  // A cavity pinch can be too narrow for the trunk before it actually splits.
  // Measure the trunk once and hand its unsuitable end rows to the child spines.
  // No layer is skipped: only the shared-sheet position moves down, and the
  // adjacent sections still overlap on exactly one physical sheet.
  for (const section of sections) {
    const children = sections.filter(s => s.parent === section);
    if (!children.length) continue;
    const nodes = section.shared ? [section.shared, ...section.nodes] : section.nodes;
    const source = { ...nominal, slices: nodes.map(n => n.slice) };
    const probe = build({ ...set, slices: source.slices }, source,
      [{ ...feature, id: section.id, params: { ...feature.params, count } }],
      { ...options, section: { centre: section.centre, angles: section.angles, requiredLayers: section.shared ? [section.shared.slice.index] : [], onTravel: () => {}, measureOnly: true } }, turnAt, kernel).verticalSupports!;
    const error = probe.issues.find(i => i.severity === 'error');
    if (error || !probe.fit) return fail(`${section.label}: ${error?.message ?? 'no usable shared layer was found'}`);
    const at = section.nodes.findIndex(n => n.slice.index === probe.fit!.lastLayer);
    if (at < 0) return fail(`${section.label}: no shared layer remains above its parent joint.`);
    const moved = section.nodes.splice(at + 1);
    for (const child of children) { child.shared = section.nodes.at(-1)!; child.nodes = [...moved, ...child.nodes]; }
  }
  report.branches = { count, sections: [], junctions: [], order: [], excluded: [] };
  const finished = new Map<string, Field[]>(), travels = new Map<string, number>();
  for (const section of sections) {
    const nodes = section.shared ? [section.shared, ...section.nodes] : section.nodes;
    const last = section.nodes.at(-1)!, requiredLayers = [...(section.shared ? [section.shared.slice.index] : []), ...(sections.some(s => s.parent === section) ? [last.slice.index] : [])];
    const source = { ...nominal, slices: nodes.map(n => n.slice) };
    const output = build({ ...set, slices: source.slices }, source,
      [{ ...feature, id: section.id, params: { ...feature.params, count } }],
      { ...options, layerIndices: source.slices.map(s => s.index), section: { centre: section.centre, angles: section.angles, requiredLayers,
        onTravel: (id, travel) => travels.set(id, travel),
        onSheetCuts: (slice, cuts) => { const owner = nodes.find(n => n.slice.index === slice.index)!.owner; finished.set(owner, [...(finished.get(owner) ?? []), ...cuts]); },
      } }, turnAt, kernel);
    const result = output.verticalSupports!;
    const error = result.issues.find(i => i.severity === 'error');
    if (error) return fail(`${section.label}: ${error.message}`);
    const fitted = result.fit!;
    report.branches.sections.push({ id: section.id, label: section.label, parent: section.parent?.id, centre: section.centre,
      firstLayer: fitted.firstLayer, lastLayer: fitted.lastLayer });
    fitted.excluded.forEach(row => report.branches!.excluded.push({ section: section.label, ...row }));
    for (const plate of result.parts) {
      plate.index = -report.parts.length - 1; plate.part!.label = `V${report.parts.length + 1}`;
      report.parts.push(plate);
    }
    report.contacts.push(...result.contacts);
  }
  for (const section of sections) {
    const children = sections.filter(s => s.parent === section);
    if (!children.length) continue;
    const node = section.nodes.at(-1)!, ids = [section.id, ...children.map(s => s.id)];
    const contacts = report.contacts.filter(c => c.layer === node.slice.index && ids.some(id => c.id.startsWith(`${id}-support-`)));
    if (contacts.length !== ids.length * count) return fail(`Layer ${node.slice.index}: not every trunk and branch support reaches the shared sheet.`);
    report.branches.junctions.push({ layer: node.slice.index, parent: section.id, children: children.map(s => s.id), contacts: contacts.length });
  }
  const span = Math.max(...nominal.slices.map(s => { const b = bounds(s.contours); return Math.max(b.maxX - b.minX, b.maxY - b.minY); }));
  const step = Math.max(span / 1400, Math.min(0.15, t / 12, bridge / 8)), tolerance = Math.min(options.tolerance, 0.02);
  const slices = set.slices.map((slice, row) => {
    if (ownersByRow.get(row)!.every(owner => !finished.has(owner))) return { ...slice, nominalContours: nominal.slices[row].contours };
    const contours: Contour[] = [], cutContours: Contour[] = [];
    for (const owner of ownersByRow.get(row)!) {
      const changes = finished.get(owner), base = ownerContours.get(owner)!;
      if (!changes) {
        contours.push(...base);
        cutContours.push(...kernel.trace(kernel.distance(base, 2), bounds(base), step, set.kerf / 2, tolerance)); continue;
      }
      const field = kernel.distance(base, 2), box = bounds(base);
      const cut = kernel.trace((x, y) => Math.max(field(x, y), -Math.min(...changes.map(f => f(x, y)))), box, step, 0, tolerance);
      if (cut.filter(c => !c.isHole).length !== 1) report.issues.push({ severity: 'error', message: `Layer ${slice.index}: combined branch slots split a connected sheet. Reduce count or change the source.` });
      contours.push(...cut);
      cutContours.push(...kernel.trace(kernel.distance(cut, 2), box, step, set.kerf / 2, tolerance));
    }
    const result = { ...slice, nominalContours: contours, contours: cutContours };
    if (finished.size && kernel.thin(result, bridge)) report.issues.push({ severity: 'error', message: `Layer ${slice.index}: branch joints or the source leave a narrow bridge. Change the source, rotation or support count.` });
    return result;
  });
  const error = report.issues.find(i => i.severity === 'error');
  if (error) return fail(error.message);
  const supportedOwners = new Set(finished.keys());
  for (const [row, owners] of ownersByRow) for (const owner of owners) if (!supportedOwners.has(owner))
    report.branches.excluded.push({ section: `Unattached piece ${Number(owner.split(':')[1]) + 1}`, layer: nominal.slices[row].index, reason: 'no fitted cavity joint; attach this piece separately' });
  // Check every finished sheet and every other spine, including shared layers.
  // The same finite inward staging travel is checked before outward insertion.
  const sheetFields = slices.map(s => ({ slice: s, field: kernel.distance(s.nominalContours!, 2) }));
  const before = new Map<string, Set<string>>(report.parts.map(p => [p.part!.id, new Set()]));
  for (const plate of report.parts) {
    const p = plate.part!, box = bounds(plate.nominalContours!), distance = kernel.distance(plate.nominalContours!, 2), travel = travels.get(p.id)!;
    const steps = Math.ceil(travel / Math.max(0.25, t / 3));
    for (const input of sheetFields) {
      const sheet = input.slice;
      if (sheet.zBottom + t < box.minY || sheet.zBottom > box.maxY) continue;
      const angle = -turnAt(sheet) * RAD;
      for (let k = 0; k <= steps; k++) for (const z of [sheet.zBottom + 0.02, sheet.z, sheet.zBottom + t - 0.02]) {
        if (z < box.minY || z > box.maxY) continue;
        for (let u = box.minX; u <= box.maxX; u += Math.max(step, 0.25)) {
          if (distance(u, z) >= -0.03) continue;
          for (const v of [-0.49 * t, 0, 0.49 * t]) {
            const at = u - travel * k / steps;
            const xy = rotate(p.origin[0] + p.u[0] * at + p.n[0] * v, p.origin[1] + p.u[1] * at + p.n[1] * v, angle);
            if (input.field(...xy) < -0.03) return fail(`${p.label}: ${k ? 'its insertion path crosses' : 'it intersects'} layer ${sheet.index}. Change rotation, support count or the shared-sheet shape.`);
          }
        }
      }
    }
    for (const other of report.parts) {
      if (other === plate) continue;
      if (supportCollision(plate, other, kernel, 0)) return fail(`${p.label} and ${other.part!.label} intersect. Change rotation or support count.`);
      for (let i = 1; i <= steps; i++) if (supportCollision(plate, other, kernel, -travel * i / steps)) {
        before.get(other.part!.id)!.add(p.id); break;
      }
    }
  }
  const order: string[] = [];
  while (order.length < report.parts.length) {
    const next = report.parts.find(p => !order.includes(p.part!.id) && [...before.get(p.part!.id)!].every(id => order.includes(id)));
    if (!next) return fail('Branch support insertion paths depend on each other in a cycle. Change rotation or count; moving groups together is not checked.');
    order.push(next.part!.id);
  }
  report.branches.order = order;
  if (report.branches.excluded.length) report.issues.push({ severity: 'warning', message: `Pieces without support joints occur in layers ${[...new Set(report.branches.excluded.map(e => e.layer))].join(', ')}. See Branch coverage and attach these pieces separately.` });
  return { ...set, slices, verticalSupports: report };
}
