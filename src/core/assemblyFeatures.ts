/** Persistent assembly feature creation. No runtime dependencies. */
import type { Feature } from './types.ts';
import type { Bounds } from './slice.ts';

type Params = Feature['params'];
export type AssemblyMember = 'rib' | 'support' | 'backplate' | 'channel';
export function assemblyFeatures(kind: 'radial' | 'linear', next: number, bounds: Bounds): { features: Feature[]; next: number; id: string } {
  const features: Feature[] = [];
  const create = (kind: string, name: string, params: Params): Feature => {
    const feature: Feature = { id: `f${next++}`, kind: `assembly:${kind}`, stage: 'SLICE', name, enabled: true, params };
    features.push(feature); return feature;
  };
  const radius = Math.max((bounds.max[0] - bounds.min[0]) / 2, (bounds.max[1] - bounds.min[1]) / 2);
  const height = bounds.max[2] - bounds.min[2];
  const count = kind === 'radial' ? 12 : 9;
  const spacing = (bounds.max[0] - bounds.min[0]) * 0.8 / Math.max(count - 1, 1);
  const layout = create('layout', kind === 'radial' ? 'Radial ribs' : 'Linear ribs', { layout: kind, spacing, sourceSpacing: spacing, pivotRadius: radius * 0.7, innerRadius: radius * 0.38, ribDepth: radius * 0.35, ribAngle: 0, angle: 0, jointClearance: 0.1, px: 0, py: 0, pz: 0, radius, height });
  for (let i = 0; i < count; i++) {
    const station = i - (count - 1) / 2;
    create('rib', `Rib ${i + 1}`, { groupId: layout.id, ordinal: i, station, sourceX: station * spacing, sourceAngle: i * 360 / count, angle: 0, px: 0, py: 0, pz: 0 });
  }
  const member = (kind: AssemblyMember) => {
    const feature = assemblyMember(kind, layout, features, next++);
    features.push(feature);
  };
  if (kind === 'radial') { member('support'); member('support'); }
  else member('backplate');
  return { features, next, id: layout.id };
}
export function assemblyMember(kind: AssemblyMember, layout: Feature, features: Feature[], next: number): Feature {
  const p = layout.params, radius = Number(p.radius) || 80, height = Number(p.height) || 160;
  const siblings = features.filter((f) => f.kind === `assembly:${kind}` && f.params.groupId === layout.id);
  const ordinal = Math.max(-1, ...siblings.map((f) => Number(f.params.ordinal) || 0)) + 1;
  const params: Params = { groupId: layout.id, ordinal, px: 0, py: 0, pz: 0, ownMaterial: false, materialName: 'Custom stock', thickness: 3, kerf: 0.15 };
  if (kind === 'rib') {
    const maxStation = Math.max(-1, ...siblings.map((f) => Number(f.params.station) || 0));
    const angles = siblings.map((f) => ((Number(f.params.sourceAngle) || 0) % 360 + 360) % 360).sort((a, b) => a - b);
    let angle = 0, gap = 0;
    angles.forEach((a, i) => { const size = (i + 1 < angles.length ? angles[i + 1] : angles[0] + 360) - a; if (size > gap) { gap = size; angle = (a + size / 2) % 360; } });
    Object.assign(params, { station: maxStation + 1, sourceX: (maxStation + 1) * Number(p.sourceSpacing || p.spacing), sourceAngle: angle, angle: 0 });
  } else if (kind === 'support') Object.assign(params, { outerDiameter: radius * 1.82, innerDiameter: radius * 1.2, pz: siblings.length === 0 ? -height * 0.25 : siblings.length === 1 ? height * 0.25 : 0 });
  else if (kind === 'backplate') Object.assign(params, { width: radius * 2 + 16, height: height + 16, margin: 8, cornerRadius: 4, tabHeight: Math.max(8, height * 0.08), tabSpacing: height * 0.45, tabProtrusion: 0, wallOffset: 0, mount: 'screw', screwDiameter: 4, headDiameter: 8, mountSpacing: radius * 1.5, mountZ: height * 0.37 });
  else Object.assign(params, { shape: 'tube', diameter: 16, width: 12, height: 5, cornerRadius: 0, clearance: 0.25, py: radius * 0.3, yaw: 0, elevation: 0, roll: 0, length: radius * 3, through: true, open: false, openAngle: 90, ribTarget: true, supportTarget: false, backplateTarget: false, targetIds: '' });
  return { id: `f${next}`, kind: `assembly:${kind}`, stage: 'SLICE', name: `${kind === 'backplate' ? 'Wall mount' : kind === 'channel' ? 'LED channel' : kind === 'support' ? 'Support' : 'Rib'} ${ordinal + 1}`, enabled: true, params };
}
