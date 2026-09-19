/** Persistent rib membership and explicit copies of unjointed nominal drawings. */
import type { Feature } from './types.ts';
import type { CurveSketch } from './curves.ts';
import type { Contour } from './slice.ts';

export function profileRibs(features: Feature[], layoutId: string, profileId?: string): Feature[] {
  return features.filter(f => f.kind === 'assembly:rib' && f.params.groupId === layoutId
    && f.params.freePlacement !== true && (profileId === undefined || f.params.profileId === profileId))
    .sort((a, b) => Number(a.params.ordinal) - Number(b.params.ordinal) || a.id.localeCompare(b.id));
}

/** The UI names sequences; saved membership always points to feature IDs. */
export function selectRibRange(ribs: Feature[], expression: string): string[] {
  const sequences = new Set<number>();
  for (const item of expression.trim().split(/[\s,]+/)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(item);
    if (!match) throw new Error('Enter rib sequences such as 1-6, 9, 12.');
    const first = Number(match[1]), last = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last - first > 64)
      throw new Error('Use an ascending range of existing rib sequences.');
    for (let i = first; i <= last; i++) sequences.add(i);
  }
  const selected = ribs.filter(r => sequences.has(Number(r.params.ordinal) + 1));
  if (selected.length !== sequences.size) throw new Error('Some requested rib sequences are missing or use Free placement. Choose existing linked ribs.');
  return selected.map(r => r.id);
}

/** Copy once, with a declared simplification tolerance; never track sampled vertices. */
export function sketchFromRib(contours: Contour[], simplify: (points: number[], tolerance: number) => number[]): CurveSketch {
  if (!contours.length || contours.length > 32) throw new Error('This rib needs 1–32 closed loops to become a drawing.');
  const base = contours.map(contour => {
    const points = simplify(contour.points, 0.05);
    if (points.length < 6 || points.length > 512) throw new Error('This rib is too detailed for a drawing (256 points per loop). Simplify its source before making a group.');
    return Array.from({ length: points.length / 2 }, (_, i) => ({
      point: [points[2 * i], points[2 * i + 1]] as [number, number],
      incoming: [0, 0] as [number, number], outgoing: [0, 0] as [number, number], smooth: false,
    }));
  });
  return { base, keys: [], nextKey: 1 };
}
