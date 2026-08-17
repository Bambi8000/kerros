import { create } from 'zustand';
import type {
  Feature,
  MachineProfile,
  MaterialProfile,
  Stage,
  StackSettings,
} from './types';
import { DEFAULT_MACHINE, DEFAULT_MATERIAL, DEFAULT_STACK } from './profiles';

export type ViewName = 'persp' | 'top' | 'front' | 'side';

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
  /** Global PRNG seed. Every generator derives from this. */
  seed: number;

  addFeature: (kind: string, stage: Stage, name: string) => void;
  removeFeature: (id: string) => void;
  moveFeature: (id: string, delta: number) => void;
  toggleFeature: (id: string) => void;
  selectFeature: (id: string | null) => void;

  setMachine: (patch: Partial<MachineProfile>) => void;
  setMaterial: (patch: Partial<MaterialProfile>) => void;
  setStack: (patch: Partial<StackSettings>) => void;
  setView: (view: ViewName) => void;
  setSeed: (seed: number) => void;
}

export const useKerros = create<KerrosState>((set) => ({
  features: [],
  selectedId: null,
  nextFeatureNumber: 1,

  machine: DEFAULT_MACHINE,
  material: DEFAULT_MATERIAL,
  stack: DEFAULT_STACK,

  view: 'persp',
  seed: 1,

  addFeature: (kind, stage, name) =>
    set((s) => {
      const id = `f${s.nextFeatureNumber}`;
      const feature: Feature = {
        id,
        kind,
        stage,
        name,
        enabled: true,
        params: {},
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

  setMachine: (patch) => set((s) => ({ machine: { ...s.machine, ...patch } })),
  setMaterial: (patch) => set((s) => ({ material: { ...s.material, ...patch } })),
  setStack: (patch) => set((s) => ({ stack: { ...s.stack, ...patch } })),
  setView: (view) => set({ view }),
  setSeed: (seed) => set({ seed }),
}));
