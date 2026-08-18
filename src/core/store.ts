import { create } from 'zustand';
import type {
  Feature,
  MachineProfile,
  MaterialProfile,
  Stage,
  StackSettings,
} from './types';
import { DEFAULT_MACHINE, DEFAULT_MATERIAL, DEFAULT_STACK } from './profiles';
import { defaultParams, findModule, modelBounds } from './sdf';
import { ROD_CLEARANCE } from './rig';
import type { RodSpec } from './rig';

export type ViewName = 'persp' | 'top' | 'front' | 'side';

/** Sample count along the longest axis for the preview mesh. */
export const PREVIEW_RESOLUTIONS = [32, 48, 64, 96, 128];

/** What the workspace is showing. */
export type WorkspaceMode = 'model' | 'slice' | 'stack';

/** Samples along the longest XY axis when slicing. */
export const SLICE_RESOLUTIONS = [120, 200, 300, 420];

/** How the solid is drawn in Model mode. */
export type DisplayMode = 'solid' | 'xray' | 'wire';

/** Direct-manipulation gizmo mode. */
export type GizmoMode = 'translate' | 'rotate';

/** Snap increments used when snapping is on. */
export const SNAP_TRANSLATE_MM = 5;
export const SNAP_ROTATE_DEG = 15;

/** The six transform keys a gizmo drag writes back to. */
export interface TransformPatch {
  px?: number;
  py?: number;
  pz?: number;
  rx?: number;
  ry?: number;
  rz?: number;
}

interface KerrosState {
  /** Ordered feature tree. Order is evaluation order. */
  features: Feature[];
  selectedId: string | null;
  /** Monotonic counter so ids are reproducible across a session. */
  nextFeatureNumber: number;

  machine: MachineProfile;
  material: MaterialProfile;
  stack: StackSettings;

  view: ViewName;
  mode: WorkspaceMode;
  previewRes: number;
  displayMode: DisplayMode;
  gizmoMode: GizmoMode;
  snapEnabled: boolean;

  /** Slicing settings. Kerf is not applied yet — that lands in M3. */
  sliceRes: number;
  sliceTolerance: number;
  sliceSmoothing: number;
  /** 1-based layer shown in the inspector and highlighted in the stack. */
  currentLayer: number;
  /** Stack view: hide everything above the current layer to see inside. */
  hideAbove: boolean;
  /**
   * Narrowest cut feature considered safe, mm. Slices with anything thinner
   * are flagged in the inspector rather than quietly exported.
   */
  minFeature: number;
  /**
   * Slice inspector: refit the view to each layer as you step through.
   * Off by default — a fixed scale is what shows the form narrowing.
   */
  sliceFitToLayer: boolean;
  /** Global PRNG seed. Every generator derives from this. */
  seed: number;

  addShape: (moduleKey: string) => void;
  addRod: () => void;
  /** Stretch a rod to span the whole model. */
  fitRodToModel: (id: string) => void;
  removeFeature: (id: string) => void;
  moveFeature: (id: string, delta: number) => void;
  toggleFeature: (id: string) => void;
  selectFeature: (id: string | null) => void;
  renameFeature: (id: string, name: string) => void;
  setParam: (id: string, key: string, value: number | string | boolean) => void;
  /** Write a whole transform at once — a gizmo drag is one edit, not six. */
  setTransform: (id: string, patch: TransformPatch) => void;

  setMachine: (patch: Partial<MachineProfile>) => void;
  setMaterial: (patch: Partial<MaterialProfile>) => void;
  setStack: (patch: Partial<StackSettings>) => void;
  setView: (view: ViewName) => void;
  setMode: (mode: WorkspaceMode) => void;
  setPreviewRes: (res: number) => void;
  setDisplayMode: (mode: DisplayMode) => void;
  setSliceRes: (res: number) => void;
  setSliceTolerance: (mm: number) => void;
  setSliceSmoothing: (passes: number) => void;
  setCurrentLayer: (layer: number) => void;
  setHideAbove: (hide: boolean) => void;
  setSliceFitToLayer: (fit: boolean) => void;
  setMinFeature: (mm: number) => void;
  setGizmoMode: (mode: GizmoMode) => void;
  setSnapEnabled: (enabled: boolean) => void;
  setSeed: (seed: number) => void;
}

const SHAPE: Stage = 'SHAPE';

export const useKerros = create<KerrosState>((set) => ({
  features: [],
  selectedId: null,
  nextFeatureNumber: 1,

  machine: DEFAULT_MACHINE,
  material: DEFAULT_MATERIAL,
  stack: DEFAULT_STACK,

  view: 'persp',
  mode: 'model',
  previewRes: 64,
  displayMode: 'solid',
  gizmoMode: 'translate',
  snapEnabled: false,

  sliceRes: 200,
  sliceTolerance: 0.05,
  sliceSmoothing: 1,
  currentLayer: 1,
  hideAbove: false,
  sliceFitToLayer: false,
  minFeature: 1,
  seed: 1,

  addShape: (moduleKey) =>
    set((s) => {
      const mod = findModule(moduleKey);
      if (!mod) return s;
      const id = `f${s.nextFeatureNumber}`;
      const params = defaultParams(mod);
      // The first solid in the tree has nothing to blend against, so give it a
      // plain union and let later features do the blending.
      if (s.features.length === 0) params.op = 'union';

      const feature: Feature = {
        id,
        kind: mod.key,
        stage: SHAPE,
        name: mod.name,
        enabled: true,
        params,
      };
      return {
        features: [...s.features, feature],
        nextFeatureNumber: s.nextFeatureNumber + 1,
        selectedId: id,
      };
    }),

  /**
   * A rod spans the whole model by default and sits off to one side, because
   * a rod that starts life at the origin is inside the cable channel and
   * invisible. Both are two drags away from wherever they belong.
   */
  addRod: () =>
    set((s) => {
      const bounds = modelBounds(s.features.filter((f) => f.stage === 'SHAPE'));
      const zStart = bounds ? bounds.min[2] : 0;
      const zEnd = bounds ? bounds.max[2] : 100;
      const x = bounds ? bounds.max[0] * 0.72 : 40;

      const id = `f${s.nextFeatureNumber}`;
      const rodCount = s.features.filter((f) => f.kind === 'rod').length + 1;

      return {
        features: [
          ...s.features,
          {
            id,
            kind: 'rod',
            stage: 'RIG' as Stage,
            name: `Rod ${rodCount}`,
            enabled: true,
            params: {
              size: 'M5',
              px: Math.round(x * 10) / 10,
              py: 0,
              // Centre and length, not two ends: that way the gizmo moves a
              // rod in Z exactly like it moves anything else, and the length
              // stays a number you set rather than a subtraction you do.
              pz: Math.round(((zStart + zEnd) / 2) * 10) / 10,
              length: Math.max(Math.round((zEnd - zStart) * 10) / 10, 1),
              diameter: 0,
            },
          },
        ],
        nextFeatureNumber: s.nextFeatureNumber + 1,
        selectedId: id,
      };
    }),

  fitRodToModel: (id) =>
    set((s) => {
      const bounds = modelBounds(s.features.filter((f) => f.stage === 'SHAPE'));
      if (!bounds) return s;
      const pz = Math.round(((bounds.min[2] + bounds.max[2]) / 2) * 10) / 10;
      const length = Math.max(Math.round((bounds.max[2] - bounds.min[2]) * 10) / 10, 1);
      return {
        features: s.features.map((f) =>
          f.id === id ? { ...f, params: { ...f.params, pz, length } } : f,
        ),
      };
    }),

  removeFeature: (id) =>
    set((s) => ({
      features: s.features.filter((f) => f.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),

  moveFeature: (id, delta) =>
    set((s) => {
      const from = s.features.findIndex((f) => f.id === id);
      if (from < 0) return s;
      const to = from + delta;
      if (to < 0 || to >= s.features.length) return s;
      const next = s.features.slice();
      const [row] = next.splice(from, 1);
      next.splice(to, 0, row);
      return { features: next };
    }),

  toggleFeature: (id) =>
    set((s) => ({
      features: s.features.map((f) =>
        f.id === id ? { ...f, enabled: !f.enabled } : f,
      ),
    })),

  selectFeature: (id) => set({ selectedId: id }),

  renameFeature: (id, name) =>
    set((s) => ({
      features: s.features.map((f) => (f.id === id ? { ...f, name } : f)),
    })),

  setParam: (id, key, value) =>
    set((s) => ({
      features: s.features.map((f) =>
        f.id === id ? { ...f, params: { ...f.params, [key]: value } } : f,
      ),
    })),

  setTransform: (id, patch) =>
    set((s) => ({
      features: s.features.map((f) =>
        f.id === id ? { ...f, params: { ...f.params, ...patch } } : f,
      ),
    })),

  setMachine: (patch) => set((s) => ({ machine: { ...s.machine, ...patch } })),
  setMaterial: (patch) => set((s) => ({ material: { ...s.material, ...patch } })),
  setStack: (patch) => set((s) => ({ stack: { ...s.stack, ...patch } })),
  setView: (view) => set({ view }),
  setMode: (mode) => set({ mode }),
  setPreviewRes: (previewRes) => set({ previewRes }),
  setDisplayMode: (displayMode) => set({ displayMode }),
  setSliceRes: (sliceRes) => set({ sliceRes }),
  setSliceTolerance: (sliceTolerance) => set({ sliceTolerance }),
  setSliceSmoothing: (sliceSmoothing) => set({ sliceSmoothing }),
  setCurrentLayer: (currentLayer) => set({ currentLayer: Math.max(1, Math.round(currentLayer)) }),
  setHideAbove: (hideAbove) => set({ hideAbove }),
  setSliceFitToLayer: (sliceFitToLayer) => set({ sliceFitToLayer }),
  setMinFeature: (minFeature) => set({ minFeature: Math.max(minFeature, 0) }),
  setGizmoMode: (gizmoMode) => set({ gizmoMode }),
  setSnapEnabled: (snapEnabled) => set({ snapEnabled }),
  setSeed: (seed) => set({ seed }),
}));

/**
 * A rod's span, from centre and length.
 *
 * Rods used to be stored as two ends. Both forms are read here so a tree built
 * before the change still resolves, but centre-and-length is the one written.
 */
export function rodSpanOf(params: Feature['params']): [number, number] {
  const length = Number(params.length) || 0;
  if (length > 0) {
    const centre = Number(params.pz) || 0;
    return [centre - length / 2, centre + length / 2];
  }
  const start = Number(params.zStart) || 0;
  const end = Number(params.zEnd) || 0;
  return start <= end ? [start, end] : [end, start];
}

/** Turn the RIG features of a tree into rod specs the rig module understands. */
export function rodsFromFeatures(features: Feature[]): RodSpec[] {
  const rods: RodSpec[] = [];
  for (const f of features) {
    if (f.kind !== 'rod' || !f.enabled) continue;
    const size = typeof f.params.size === 'string' ? f.params.size : 'M5';
    const [zStart, zEnd] = rodSpanOf(f.params);
    rods.push({
      id: f.id,
      label: f.name,
      size: ROD_CLEARANCE[size] ? size : 'M5',
      x: Number(f.params.px) || 0,
      y: Number(f.params.py) || 0,
      zStart,
      zEnd,
      diameter: Number(f.params.diameter) || 0,
    });
  }
  return rods;
}
