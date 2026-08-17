import { create } from 'zustand';
import type {
  Feature,
  MachineProfile,
  MaterialProfile,
  Stage,
  StackSettings,
} from './types';
import { DEFAULT_MACHINE, DEFAULT_MATERIAL, DEFAULT_STACK } from './profiles';
import { defaultParams, findModule } from './sdf';

export type ViewName = 'persp' | 'top' | 'front' | 'side';

/** Sample count along the longest axis for the preview mesh. */
export const PREVIEW_RESOLUTIONS = [32, 48, 64, 96, 128];

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
  previewRes: number;
  /** Global PRNG seed. Every generator derives from this. */
  seed: number;

  addShape: (moduleKey: string) => void;
  removeFeature: (id: string) => void;
  moveFeature: (id: string, delta: number) => void;
  toggleFeature: (id: string) => void;
  selectFeature: (id: string | null) => void;
  renameFeature: (id: string, name: string) => void;
  setParam: (id: string, key: string, value: number | string | boolean) => void;

  setMachine: (patch: Partial<MachineProfile>) => void;
  setMaterial: (patch: Partial<MaterialProfile>) => void;
  setStack: (patch: Partial<StackSettings>) => void;
  setView: (view: ViewName) => void;
  setPreviewRes: (res: number) => void;
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
  previewRes: 64,
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

  setMachine: (patch) => set((s) => ({ machine: { ...s.machine, ...patch } })),
  setMaterial: (patch) => set((s) => ({ material: { ...s.material, ...patch } })),
  setStack: (patch) => set((s) => ({ stack: { ...s.stack, ...patch } })),
  setView: (view) => set({ view }),
  setPreviewRes: (previewRes) => set({ previewRes }),
  setSeed: (seed) => set({ seed }),
}));
