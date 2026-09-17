import { worldRigidOf } from '../core/sdf';
import { curveHeight } from '../core/curves';
import type { Feature } from '../core/types';
import type { SliceSet } from '../core/slice';

/** A sheet-height key is meaningful only when the drawing plane is horizontal. */
export function curveLayerTarget(feature: Feature, features: Feature[], set: SliceSet | null, layer: number) {
  if (feature.params.profileMode === 'radial') return { z: null, reason: 'Layer keys are retained but inactive in Radial side profile. Switch to Layer profiles to edit them.' };
  if (!set || set.assembly) return { z: null, reason: 'Calculate horizontal layers to place a key on a sheet.' };
  const slice = set.slices[Math.round(layer) - 1];
  if (!slice) return { z: null, reason: 'Choose an existing layer.' };
  const frame = worldRigidOf(features, feature);
  if (Math.abs(frame.r[8]) < 1 - 1e-8) return { z: null, reason: 'Return this profile to a horizontal drawing plane before adding a key by layer.' };
  const z = (slice.z - frame.t[2]) / frame.r[8];
  if (!feature.sketch || Math.abs(z) >= curveHeight(feature.sketch, Number(feature.params.height)) / 2)
    return { z: null, reason: 'This layer is outside the curve profile. Choose a layer within its height.' };
  return { z, reason: '' };
}

export function curveKeyLabel(feature: Feature, features: Feature[], set: SliceSet | null, z: number): string {
  const frame = worldRigidOf(features, feature);
  if (!set || set.assembly || !set.slices.length || Math.abs(frame.r[8]) < 1 - 1e-8) return `z ${Number(z.toFixed(2))} mm`;
  const height = frame.t[2] + z * frame.r[8];
  const nearest = set.slices.reduce((a, b) => Math.abs(a.z - height) <= Math.abs(b.z - height) ? a : b);
  return `${Math.abs(nearest.z - height) < 1e-4 ? 'Layer' : 'Near layer'} ${nearest.index} · z ${Number(z.toFixed(2))} mm`;
}
