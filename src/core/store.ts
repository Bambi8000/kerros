import { create } from 'zustand';
import type {
  Feature,
  SculptStroke,
  MachineProfile,
  MaterialProfile,
  Stage,
  StackSettings,
} from './types';
import { DEFAULT_MACHINE, DEFAULT_MATERIAL, DEFAULT_STACK } from './profiles';
import {
  defaultModifierParams,
  defaultParams,
  evaluatePoint,
  findModule,
  frameOf,
  frameToLocal,
  frameToWorld,
  modelBounds,
  prepareFeatures,
  shellModifier,
} from './sdf';
import type { Frame } from './sdf';
import { WINDOW_WORLD, resolveWindow, stockField, windowToLocal, windowToWorld } from './window';
import { importMesh, openEdgeCount } from './meshImport';
import type { TriangleSoup } from './meshImport';
import { meshGridBounds, sampleMeshGrid, voxelise } from './voxelise';
import type { MeshGrid } from './voxelise';
import { FIXTURE_LABELS, SOCKET_PRESETS } from './fixture';
import type { FixtureKind, FixtureSpec } from './fixture';
import type { LayerPlan, WindowFrame, WindowSpec } from './window';
import { ROD_CLEARANCE } from './rig';
import type { RodSpec } from './rig';
import type { PartPlacement } from './nest';
import type { ProjectData } from './project';

export type ViewName = 'persp' | 'top' | 'front' | 'side';

/** Sample count along the longest axis for the preview mesh. */
export const PREVIEW_RESOLUTIONS = [32, 48, 64, 96, 128];

/** What the workspace is showing. */
export type WorkspaceMode = 'model' | 'slice' | 'stack' | 'sheet';

/** Which way the flutes run in the stock, or none for plain material. */
export type FluteDirection = 'none' | 'horizontal' | 'vertical';

/** Which panel the right rail is showing. */
export type Panel = 'inspector' | 'profiles';

/** Brush operations offered while sculpting. A blend belongs to the smooth ones. */
export const BRUSH_OPS = ['union', 'smoothUnion', 'subtract', 'smoothSubtract'] as const;
export type BrushOp = (typeof BRUSH_OPS)[number];

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

  /** Project name, used for the saved filename and the manifest. */
  projectName: string;

  view: ViewName;
  mode: WorkspaceMode;
  /**
   * Which panel the right rail shows.
   *
   * Kept in the store rather than in the panel's own state, because selecting
   * something *is* a request to inspect it: the selection action and the panel
   * change then happen together instead of racing in two effects.
   */
  panel: Panel;

  /** Sculpting takes the left mouse button, so it is a mode you switch on. */
  sculptMode: boolean;
  brushOp: BrushOp;
  brushRadius: number;
  brushBlend: number;
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
  /** Space left between parts when nesting, mm. */
  partGap: number;
  /** Engraved label height, mm. 0 turns labelling off. */
  labelHeight: number;
  /** Radial width of a spacer ring, mm. */
  ringWidth: number;
  /** Generate spacer rings as cut parts. */
  makeSpacers: boolean;
  /** 1-based sheet shown in the sheet view. */
  currentSheet: number;
  /**
   * Manual part placements, keyed by part id. Part ids are deterministic, so
   * a pinned part stays put across re-slicing and re-nesting.
   */
  partPlacements: Record<string, PartPlacement>;
  /** Part selected in the sheet view. Separate from the feature selection. */
  selectedPartId: string | null;
  /**
   * Corrugation direction of the stock. Corrugated board has flutes running
   * one way inside it, and a cut edge exposes them, so the angle a part is cut
   * at changes how its edge looks and how it passes light.
   */
  fluteDirection: FluteDirection;
  /** Flute pitch, mm. B flute is about 6.5, C about 7.9, E about 3.5. */
  flutePitch: number;
  /** Widest angle the scatter button will turn a part, degrees. */
  scatterAngle: number;
  /**
   * Slice inspector: refit the view to each layer as you step through.
   * Off by default — a fixed scale is what shows the form narrowing.
   */
  sliceFitToLayer: boolean;
  /** Global PRNG seed. Every generator derives from this. */
  seed: number;

  addShape: (moduleKey: string) => void;
  addRod: () => void;
  addShell: () => void;
  addPattern: () => void;
  addWindow: () => void;
  addFixture: (kind: FixtureKind) => void;
  /** Read a mesh, bake it, and hang it on a feature. Creates one if needed. */
  loadImport: (id: string | null, name: string, bytes: Uint8Array) => string;
  /** Re-bake an already loaded mesh at another resolution. */
  rebakeImport: (id: string, resolution: number) => void;
  /**
   * Bumped whenever a mesh is baked. Grids live outside the store — they are
   * megabytes of Float32 and have no business in a state object that gets
   * compared on every render — so this is what tells the memos to recompute.
   */
  importRevision: number;
  /** Put a feature's axis at the middle of the model's footprint. */
  centreOnModel: (id: string) => void;
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
  setPanel: (panel: Panel) => void;
  setSculptMode: (on: boolean) => void;
  setBrushOp: (op: BrushOp) => void;
  setBrushRadius: (mm: number) => void;
  setBrushBlend: (mm: number) => void;
  /**
   * The sculpt feature strokes should go to, creating one if there is none.
   * Returns its id, because the viewport needs it the moment a stroke starts.
   */
  ensureSculpt: () => string;
  /** `stroke` arrives in world coordinates; it is stored in the parent's frame. */
  addStroke: (id: string, stroke: SculptStroke) => void;
  /** Re-attach a sculpt to another shape, carrying its strokes across. */
  setSculptParent: (id: string, parentId: string) => void;
  /** Attach or detach a window, carrying its placement across. */
  setWindowParent: (id: string, parentId: string) => void;
  /** Move a feature by its world origin, converting for anything attached. */
  setOriginWorld: (id: string, x: number, y: number, z: number) => void;
  undoStroke: (id: string) => void;
  clearStrokes: (id: string) => void;
  setProjectName: (name: string) => void;
  /** Replace everything a project file describes. */
  applyProject: (data: ProjectData, nextFeatureNumber: number) => void;
  /** Everything a project file should hold. */
  projectData: () => ProjectData;
  setPreviewRes: (res: number) => void;
  setDisplayMode: (mode: DisplayMode) => void;
  setSliceRes: (res: number) => void;
  setSliceTolerance: (mm: number) => void;
  setSliceSmoothing: (passes: number) => void;
  setCurrentLayer: (layer: number) => void;
  setHideAbove: (hide: boolean) => void;
  setSliceFitToLayer: (fit: boolean) => void;
  setMinFeature: (mm: number) => void;
  setPartGap: (mm: number) => void;
  setLabelHeight: (mm: number) => void;
  setRingWidth: (mm: number) => void;
  setMakeSpacers: (on: boolean) => void;
  setCurrentSheet: (sheet: number) => void;
  selectPart: (id: string | null) => void;
  setPartPlacement: (id: string, placement: PartPlacement) => void;
  clearPartPlacement: (id: string) => void;
  clearAllPlacements: () => void;
  /** Set several placements at once, so a scatter is a single update. */
  mergePlacements: (placements: Record<string, PartPlacement>) => void;
  setFluteDirection: (direction: FluteDirection) => void;
  setFlutePitch: (mm: number) => void;
  setScatterAngle: (degrees: number) => void;
  setGizmoMode: (mode: GizmoMode) => void;
  setSnapEnabled: (enabled: boolean) => void;
  setSeed: (seed: number) => void;
}

const SHAPE: Stage = 'SHAPE';

/** A baked import, held outside the store. */
export interface ImportEntry {
  soup: TriangleSoup;
  grid: MeshGrid;
  volume: { sample: (x: number, y: number, z: number) => number; min: [number, number, number]; max: [number, number, number] };
  /** Edges used by one triangle. Zero means watertight. */
  openEdges: number;
  ms: number;
}

/**
 * Baked meshes, by feature id.
 *
 * Deliberately not in the store. A grid is a megabyte or more of Float32, and
 * putting it in state means every selector comparison walks past it. The store
 * carries `importRevision` instead, which is the one number that has to change
 * for the memos to notice.
 *
 * The consequence is that a grid does not survive a reload, which is also why
 * the project file records the path and not the geometry.
 */
const importVolumes = new Map<string, ImportEntry>();

export function importEntry(id: string): ImportEntry | undefined {
  return importVolumes.get(id);
}

/** Tenths of a millimetre: stroke points do not need sixteen decimal places. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The frame a window follows: translation and Z rotation only.
 *
 * A window is a vertical wedge and its layers come from world Z, so inheriting
 * a parent's X or Y rotation would tip it out of the stack. See `WindowFrame`.
 */
export function windowFrameFor(features: Feature[], window: Feature): WindowFrame {
  const target = typeof window.params.attachTo === 'string' ? window.params.attachTo : '';
  if (target === '') return WINDOW_WORLD;
  const parent = features.find((f) => f.id === target);
  if (!parent) return WINDOW_WORLD;
  return {
    x: Number(parent.params.px) || 0,
    y: Number(parent.params.py) || 0,
    z: Number(parent.params.pz) || 0,
    rz: Number(parent.params.rz) || 0,
  };
}

/** The frame a sculpt feature's strokes live in. */
function frameFor(features: Feature[], sculpt: Feature): Frame {
  const target = typeof sculpt.params.attachTo === 'string' ? sculpt.params.attachTo : '';
  if (target === '') return frameOf({});
  const parent = features.find((f) => f.id === target);
  return frameOf(parent ? parent.params : {});
}

/**
 * Features that take part in the distance field.
 *
 * SHAPE contributes solids, CARVE modifies the result. RIG does neither: rods
 * are drilled after slicing and never touch the field.
 */
export function isFieldFeature(feature: Feature): boolean {
  return feature.stage === 'SHAPE' || feature.stage === 'CARVE';
}

export const useKerros = create<KerrosState>((set, get) => ({
  features: [],
  selectedId: null,
  nextFeatureNumber: 1,

  machine: DEFAULT_MACHINE,
  material: DEFAULT_MATERIAL,
  stack: DEFAULT_STACK,

  projectName: 'Untitled lamp',

  view: 'persp',
  mode: 'model',
  panel: 'inspector',
  importRevision: 0,

  sculptMode: false,
  brushOp: 'smoothUnion',
  brushRadius: 8,
  brushBlend: 6,
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
  partGap: 4,
  labelHeight: 4,
  ringWidth: 4,
  makeSpacers: true,
  currentSheet: 1,
  partPlacements: {},
  selectedPartId: null,
  fluteDirection: 'horizontal',
  flutePitch: 6.5,
  scatterAngle: 180,
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
   * A shell hollows everything above it in the tree, so it belongs at the end
   * of the shapes. Adding one puts it there, and the caps default to the
   * model's own top and bottom so switching one on does something sensible
   * straight away.
   */
  addShell: () =>
    set((s) => {
      const bounds = modelBounds(s.features.filter((f) => f.stage === 'SHAPE'));
      const id = `f${s.nextFeatureNumber}`;
      const params = defaultModifierParams(shellModifier);
      if (bounds) {
        params.capTopZ = Math.round(bounds.max[2] * 10) / 10;
        params.capBottomZ = Math.round(bounds.min[2] * 10) / 10;
      }

      // Shells go after the last shape and before any rig feature: rods are
      // drilled after slicing and take no part in the field, but keeping the
      // tree in stage order is what makes it readable.
      const lastShape = s.features.reduce(
        (at, f, i) => (f.stage === 'SHAPE' || f.stage === 'CARVE' ? i + 1 : at),
        0,
      );
      const next = s.features.slice();
      next.splice(lastShape, 0, {
        id,
        kind: 'shell',
        stage: 'CARVE' as Stage,
        name: 'Shell',
        enabled: true,
        params,
      });

      return {
        features: next,
        nextFeatureNumber: s.nextFeatureNumber + 1,
        selectedId: id,
        panel: 'inspector' as const,
      };
    }),

  /**
   * A window is a wedge taken out of the form, and the piece that came out is
   * cut from something else and glued back in. It spans the model's height by
   * default, since the usual first move is to see where the light lands and
   * then trim the band.
   */
  addWindow: () =>
    set((s) => {
      const bounds = modelBounds(s.features.filter(isFieldFeature));
      const id = `f${s.nextFeatureNumber}`;
      const count = s.features.filter((f) => f.kind === 'window').length + 1;
      const z = bounds ? (bounds.min[2] + bounds.max[2]) / 2 : 50;
      const length = bounds ? (bounds.max[2] - bounds.min[2]) * 0.6 : 60;
      // Attached to the last shape by default, so moving the form takes the
      // windows with it. Detachable, because an eccentric window that stays put
      // while the form moves is sometimes exactly what is wanted.
      const host = [...s.features]
        .reverse()
        .find((f) => f.enabled && findModule(f.kind) !== undefined);
      // Centred on the form, not on the world axis: a window is its own volume
      // and does not follow the shape the way a shell does.
      const axisX = bounds ? (bounds.min[0] + bounds.max[0]) / 2 : 0;
      const axisY = bounds ? (bounds.min[1] + bounds.max[1]) / 2 : 0;
      const hostFrame: WindowFrame = host
        ? {
            x: Number(host.params.px) || 0,
            y: Number(host.params.py) || 0,
            z: Number(host.params.pz) || 0,
            rz: Number(host.params.rz) || 0,
          }
        : WINDOW_WORLD;
      const localAxis = windowToLocal({ x: axisX, y: axisY, z, angle: 0 }, hostFrame);

      return {
        features: [
          ...s.features,
          {
            id,
            kind: 'window',
            stage: 'CARVE' as Stage,
            name: `Window ${count}`,
            enabled: true,
            params: {
              attachTo: host ? host.id : '',
              // Per layer by default: a window that happens to a sheet reads as
              // a lamp, where a slot down the whole side reads as a mistake.
              mode: 'perLayer',
              px: round1(localAxis.x),
              py: round1(localAxis.y),
              chance: 0.3,
              minCount: 1,
              maxCount: 2,
              minWidth: 20,
              maxWidth: 60,
              count: 4,
              width: 40,
              twist: 0,
              pz: round1(localAxis.z),
              angle: round1(localAxis.angle),
              length: Math.round(length * 10) / 10,
              fit: 0.4,
              windowKerf: s.material.kerf,
            },
          },
        ],
        nextFeatureNumber: s.nextFeatureNumber + 1,
        selectedId: id,
        panel: 'inspector' as const,
      };
    }),

  /**
   * Lamp fixtures: the socket mount, the cable channel, the Wago chamber.
   *
   * A fixture belongs to particular sheets, so its band starts one layer tall
   * and sits at the bottom of the model, where the socket plate usually goes.
   */
  loadImport: (id, name, bytes) => {
    const report = importMesh(bytes, name);
    const s = get();

    // A feature is made even when the read failed, so the failure has somewhere
    // to be reported rather than vanishing with the file.
    const target = id ?? `f${s.nextFeatureNumber}`;
    const short = name.split(/[\\/]/).pop() ?? name;

    if (!report.soup) {
      if (id === null) {
        set({
          features: [
            ...s.features,
            {
              id: target,
              kind: 'import',
              stage: 'SHAPE' as Stage,
              name: short,
              enabled: true,
              params: { op: 'union', k: 0, resolution: 80, path: name, error: report.error ?? '' },
            },
          ],
          nextFeatureNumber: s.nextFeatureNumber + 1,
          selectedId: target,
          panel: 'inspector' as const,
        });
      } else {
        set({
          features: s.features.map((f) =>
            f.id === target ? { ...f, params: { ...f.params, error: report.error ?? '' } } : f,
          ),
        });
      }
      return target;
    }

    const existing = s.features.find((f) => f.id === target);
    const resolution = Math.max(Number(existing?.params.resolution) || 80, 16);
    const baked = voxelise(report.soup, { resolution });
    const box = meshGridBounds(baked.grid);

    importVolumes.set(target, {
      soup: report.soup,
      grid: baked.grid,
      volume: {
        sample: (x, y, z) => sampleMeshGrid(baked.grid, x, y, z),
        min: box.min,
        max: box.max,
      },
      openEdges: openEdgeCount(report.soup),
      ms: baked.ms,
    });

    const params = {
      op: existing ? (existing.params.op ?? 'union') : 'union',
      k: existing ? (existing.params.k ?? 0) : 0,
      px: existing?.params.px ?? 0,
      py: existing?.params.py ?? 0,
      pz: existing?.params.pz ?? 0,
      rx: existing?.params.rx ?? 0,
      ry: existing?.params.ry ?? 0,
      rz: existing?.params.rz ?? 0,
      resolution,
      path: name,
      triangles: report.soup.triangleCount,
      error: '',
    };

    if (existing) {
      set({
        features: s.features.map((f) => (f.id === target ? { ...f, params } : f)),
        importRevision: s.importRevision + 1,
      });
    } else {
      set({
        features: [
          ...s.features,
          {
            id: target,
            kind: 'import',
            stage: 'SHAPE' as Stage,
            name: short,
            enabled: true,
            params,
          },
        ],
        nextFeatureNumber: s.nextFeatureNumber + 1,
        selectedId: target,
        panel: 'inspector' as const,
        importRevision: s.importRevision + 1,
      });
    }

    return target;
  },

  rebakeImport: (id, resolution) =>
    set((s) => {
      const entry = importVolumes.get(id);
      if (!entry) return s;

      const clamped = Math.max(Math.round(resolution), 16);
      const baked = voxelise(entry.soup, { resolution: clamped });
      const box = meshGridBounds(baked.grid);

      importVolumes.set(id, {
        ...entry,
        grid: baked.grid,
        volume: {
          sample: (x, y, z) => sampleMeshGrid(baked.grid, x, y, z),
          min: box.min,
          max: box.max,
        },
        ms: baked.ms,
      });

      return {
        features: s.features.map((f) =>
          f.id === id ? { ...f, params: { ...f.params, resolution: clamped } } : f,
        ),
        importRevision: s.importRevision + 1,
      };
    }),

  addFixture: (kind) =>
    set((s) => {
      const bounds = modelBounds(s.features.filter(isFieldFeature));
      const id = `f${s.nextFeatureNumber}`;
      const count = s.features.filter((f) => f.kind === `fixture:${kind}`).length + 1;
      const pitch = s.material.thickness + s.stack.spacerHeight;

      return {
        features: [
          ...s.features,
          {
            id,
            kind: `fixture:${kind}`,
            stage: 'RIG' as Stage,
            name: count > 1 ? `${FIXTURE_LABELS[kind]} ${count}` : FIXTURE_LABELS[kind],
            enabled: true,
            params: {
              fixture: kind,
              px: bounds ? Math.round(((bounds.min[0] + bounds.max[0]) / 2) * 10) / 10 : 0,
              py: bounds ? Math.round(((bounds.min[1] + bounds.max[1]) / 2) * 10) / 10 : 0,
              pz: bounds ? Math.round((bounds.min[2] + s.material.thickness / 2) * 10) / 10 : 0,
              length: Math.max(pitch * 0.9, s.material.thickness),
              rot: 0,
              preset: kind === 'socket' ? 'nipple' : 'custom',
              diameter: kind === 'cable' ? 8 : SOCKET_PRESETS.nipple,
              screws: 0,
              boltCircle: 30,
              screwDiameter: 3.2,
              shape: 'round',
              slotLength: 24,
              width: 32,
              depth: 22,
              corner: 3,
            },
          },
        ],
        nextFeatureNumber: s.nextFeatureNumber + 1,
        selectedId: id,
        panel: 'inspector' as const,
      };
    }),

  centreOnModel: (id) =>
    set((s) => {
      const bounds = modelBounds(s.features.filter(isFieldFeature));
      if (!bounds) return s;
      const px = Math.round(((bounds.min[0] + bounds.max[0]) / 2) * 10) / 10;
      const py = Math.round(((bounds.min[1] + bounds.max[1]) / 2) * 10) / 10;
      return {
        features: s.features.map((f) =>
          f.id === id ? { ...f, params: { ...f.params, px, py } } : f,
        ),
      };
    }),

  /**
   * A pattern perforates the wall of every slice. It is not part of the field,
   * so where it sits in the tree does not change the form — but it goes after
   * the shapes and the shell so the tree still reads top to bottom.
   */
  addPattern: () =>
    set((s) => {
      const id = `f${s.nextFeatureNumber}`;
      const count = s.features.filter((f) => f.stage === 'PATTERN').length + 1;

      // Size the holes to the wall they will be cut in. Fixed defaults meant a
      // 2 mm hole with a 1.5 mm bridge needing 7 mm of wall, which the 6 mm
      // default shell could not give — so the pattern placed nothing, silently.
      const shell = [...s.features]
        .reverse()
        .find((f) => f.kind === 'shell' && f.enabled);
      const wall = shell ? Math.max(Number(shell.params.t) || 0, 0.5) : 0;

      const fitted =
        wall > 0
          ? (() => {
              const minBridge = Math.max(1, wall * 0.18);
              const radius = Math.max(0.5, ((wall - 2 * minBridge) / 2) * 0.9);
              return {
                radius: Math.round(radius * 10) / 10,
                minBridge: Math.round(minBridge * 10) / 10,
                pitch: Math.round((radius * 2 + minBridge) * 1.6 * 10) / 10,
              };
            })()
          : { radius: 2, minBridge: 1.5, pitch: 8 };

      return {
        features: [
          ...s.features,
          {
            id,
            kind: 'pattern',
            stage: 'PATTERN' as Stage,
            name: `Pattern ${count}`,
            enabled: true,
            params: {
              patternKind: 'hex',
              radius: fitted.radius,
              pitch: fitted.pitch,
              minBridge: fitted.minBridge,
              density: 1,
              band: 0,
              rotatePerLayer: 1,
            },
          },
        ],
        nextFeatureNumber: s.nextFeatureNumber + 1,
        selectedId: id,
        panel: 'inspector' as const,
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

  // Selecting brings the inspector forward: one action, one place.
  selectFeature: (id) => set(id ? { selectedId: id, panel: 'inspector' } : { selectedId: id }),

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
  setPanel: (panel) => set({ panel }),
  setSculptMode: (sculptMode) => set({ sculptMode }),
  setBrushOp: (brushOp) => set({ brushOp }),
  setBrushRadius: (brushRadius) => set({ brushRadius: Math.max(brushRadius, 0.2) }),
  setBrushBlend: (brushBlend) => set({ brushBlend: Math.max(brushBlend, 0) }),

  ensureSculpt: () => {
    const s = get();

    // The selected sculpt feature if there is one, otherwise the last: strokes
    // should land where the person is looking, not always at the end.
    const chosen =
      s.features.find((f) => f.id === s.selectedId && f.kind === 'sculpt') ??
      [...s.features].reverse().find((f) => f.kind === 'sculpt');
    if (chosen) return chosen.id;

    // Attached to the last shape by default. Strokes then live in that shape's
    // coordinates, so moving or turning it carries the sculpting along instead
    // of leaving it behind in world space.
    const host = [...s.features]
      .reverse()
      .find((f) => f.enabled && findModule(f.kind) !== undefined);

    const id = `f${s.nextFeatureNumber}`;
    set({
      features: [
        ...s.features,
        {
          id,
          kind: 'sculpt',
          stage: 'SHAPE' as Stage,
          name: 'Sculpt',
          enabled: true,
          params: { attachTo: host ? host.id : '' },
          strokes: [],
        },
      ],
      nextFeatureNumber: s.nextFeatureNumber + 1,
      selectedId: id,
      panel: 'inspector' as const,
    });
    return id;
  },

  addStroke: (id, stroke) =>
    set((s) => {
      const sculpt = s.features.find((f) => f.id === id);
      if (!sculpt) return s;

      const frame = frameFor(s.features, sculpt);
      const points: number[] = [];
      for (let i = 0; i < stroke.points.length; i += 3) {
        const [lx, ly, lz] = frameToLocal(
          frame,
          stroke.points[i],
          stroke.points[i + 1],
          stroke.points[i + 2],
        );
        points.push(round1(lx), round1(ly), round1(lz));
      }

      return {
        features: s.features.map((f) =>
          f.id === id ? { ...f, strokes: [...(f.strokes ?? []), { ...stroke, points }] } : f,
        ),
      };
    }),

  setWindowParent: (id, parentId) =>
    set((s) => {
      const window = s.features.find((f) => f.id === id);
      if (!window) return s;

      const from = windowFrameFor(s.features, window);
      const parent = s.features.find((f) => f.id === parentId);
      const to: WindowFrame =
        parentId === '' || !parent
          ? WINDOW_WORLD
          : {
              x: Number(parent.params.px) || 0,
              y: Number(parent.params.py) || 0,
              z: Number(parent.params.pz) || 0,
              rz: Number(parent.params.rz) || 0,
            };

      // Out of the old frame and into the new one, so attaching or detaching
      // moves the reference and leaves the window where it looks.
      const world = windowToWorld(
        {
          x: Number(window.params.px) || 0,
          y: Number(window.params.py) || 0,
          z: Number(window.params.pz) || 0,
          angle: Number(window.params.angle) || 0,
        },
        from,
      );
      const local = windowToLocal(world, to);

      return {
        features: s.features.map((f) =>
          f.id === id
            ? {
                ...f,
                params: {
                  ...f.params,
                  attachTo: parentId,
                  px: round1(local.x),
                  py: round1(local.y),
                  pz: round1(local.z),
                  angle: round1(local.angle),
                },
              }
            : f,
        ),
      };
    }),

  setOriginWorld: (id, x, y, z) =>
    set((s) => {
      const feature = s.features.find((f) => f.id === id);
      if (!feature) return s;

      // An attached window stores its placement in the parent's frame, so a
      // gizmo drag — which is always in world terms — has to come back through
      // that frame before it is written.
      if (feature.kind === 'window') {
        const frame = windowFrameFor(s.features, feature);
        const local = windowToLocal(
          { x, y, z, angle: Number(feature.params.angle) || 0 },
          frame,
        );
        return {
          features: s.features.map((f) =>
            f.id === id
              ? {
                  ...f,
                  params: {
                    ...f.params,
                    px: round1(local.x),
                    py: round1(local.y),
                    pz: round1(local.z),
                  },
                }
              : f,
          ),
        };
      }

      return {
        features: s.features.map((f) =>
          f.id === id
            ? { ...f, params: { ...f.params, px: round1(x), py: round1(y), pz: round1(z) } }
            : f,
        ),
      };
    }),

  setSculptParent: (id, parentId) =>
    set((s) => {
      const sculpt = s.features.find((f) => f.id === id);
      if (!sculpt) return s;

      // Carry the strokes across: out of the old frame into the new one, so
      // re-attaching moves the reference rather than the geometry.
      const from = frameFor(s.features, sculpt);
      const to = parentId === '' ? frameOf({}) : frameOf(
        s.features.find((f) => f.id === parentId)?.params ?? {},
      );

      const strokes = (sculpt.strokes ?? []).map((stroke) => {
        const points: number[] = [];
        for (let i = 0; i < stroke.points.length; i += 3) {
          const [wx, wy, wz] = frameToWorld(
            from,
            stroke.points[i],
            stroke.points[i + 1],
            stroke.points[i + 2],
          );
          const [lx, ly, lz] = frameToLocal(to, wx, wy, wz);
          points.push(round1(lx), round1(ly), round1(lz));
        }
        return { ...stroke, points };
      });

      return {
        features: s.features.map((f) =>
          f.id === id
            ? { ...f, params: { ...f.params, attachTo: parentId }, strokes }
            : f,
        ),
      };
    }),

  undoStroke: (id) =>
    set((s) => ({
      features: s.features.map((f) =>
        f.id === id ? { ...f, strokes: (f.strokes ?? []).slice(0, -1) } : f,
      ),
    })),

  clearStrokes: (id) =>
    set((s) => ({
      features: s.features.map((f) => (f.id === id ? { ...f, strokes: [] } : f)),
    })),
  setProjectName: (projectName) => set({ projectName }),
  setPreviewRes: (previewRes) => set({ previewRes }),
  setDisplayMode: (displayMode) => set({ displayMode }),
  setSliceRes: (sliceRes) => set({ sliceRes }),
  setSliceTolerance: (sliceTolerance) => set({ sliceTolerance }),
  setSliceSmoothing: (sliceSmoothing) => set({ sliceSmoothing }),
  setCurrentLayer: (currentLayer) => set({ currentLayer: Math.max(1, Math.round(currentLayer)) }),
  setHideAbove: (hideAbove) => set({ hideAbove }),
  setSliceFitToLayer: (sliceFitToLayer) => set({ sliceFitToLayer }),
  setMinFeature: (minFeature) => set({ minFeature: Math.max(minFeature, 0) }),
  setPartGap: (partGap) => set({ partGap: Math.max(partGap, 0) }),
  setLabelHeight: (labelHeight) => set({ labelHeight: Math.max(labelHeight, 0) }),
  setRingWidth: (ringWidth) => set({ ringWidth: Math.max(ringWidth, 0.5) }),
  setMakeSpacers: (makeSpacers) => set({ makeSpacers }),
  setCurrentSheet: (currentSheet) => set({ currentSheet: Math.max(1, Math.round(currentSheet)) }),

  selectPart: (selectedPartId) =>
    set(selectedPartId ? { selectedPartId, panel: 'inspector' } : { selectedPartId }),

  setPartPlacement: (id, placement) =>
    set((s) => ({ partPlacements: { ...s.partPlacements, [id]: placement } })),

  clearPartPlacement: (id) =>
    set((s) => {
      if (!(id in s.partPlacements)) return s;
      const next = { ...s.partPlacements };
      delete next[id];
      return { partPlacements: next };
    }),

  clearAllPlacements: () => set({ partPlacements: {} }),

  mergePlacements: (placements) =>
    set((s) => ({ partPlacements: { ...s.partPlacements, ...placements } })),

  setFluteDirection: (fluteDirection) => set({ fluteDirection }),
  setFlutePitch: (flutePitch) => set({ flutePitch: Math.max(flutePitch, 0.5) }),
  setScatterAngle: (scatterAngle) =>
    set({ scatterAngle: Math.min(Math.max(scatterAngle, 0), 180) }),

  projectData: () => {
    const s = get();
    return {
      name: s.projectName,
      machine: { ...s.machine },
      material: { ...s.material },
      stack: { ...s.stack },
      seed: s.seed,
      features: s.features.map((f) => ({
        id: f.id,
        kind: f.kind,
        stage: f.stage as string,
        name: f.name,
        enabled: f.enabled,
        params: { ...f.params },
        ...(f.strokes && f.strokes.length > 0
          ? { strokes: f.strokes.map((k) => ({ ...k, points: [...k.points] })) }
          : {}),
      })),
      slicing: {
        sliceRes: s.sliceRes,
        sliceTolerance: s.sliceTolerance,
        sliceSmoothing: s.sliceSmoothing,
        minFeature: s.minFeature,
        previewRes: s.previewRes,
      },
      layout: {
        partGap: s.partGap,
        labelHeight: s.labelHeight,
        ringWidth: s.ringWidth,
        makeSpacers: s.makeSpacers,
        fluteDirection: s.fluteDirection as string,
        flutePitch: s.flutePitch,
        scatterAngle: s.scatterAngle,
        partPlacements: Object.fromEntries(
          Object.entries(s.partPlacements).map(([id, p]) => [
            id,
            { sheet: p.sheet, dx: p.dx, dy: p.dy, rot: p.rot ?? 0 },
          ]),
        ),
      },
    };
  },

  applyProject: (data, nextFeatureNumber) =>
    set({
      projectName: data.name,
      machine: { ...data.machine },
      material: { ...data.material },
      stack: { ...data.stack },
      seed: data.seed,
      features: data.features.map((f) => ({
        id: f.id,
        kind: f.kind,
        stage: f.stage as Stage,
        name: f.name,
        enabled: f.enabled,
        params: { ...f.params },
        ...(f.strokes ? { strokes: f.strokes.map((k) => ({ ...k, points: [...k.points] })) } : {}),
      })),
      nextFeatureNumber,
      sliceRes: data.slicing.sliceRes,
      sliceTolerance: data.slicing.sliceTolerance,
      sliceSmoothing: data.slicing.sliceSmoothing,
      minFeature: data.slicing.minFeature,
      previewRes: data.slicing.previewRes,
      partGap: data.layout.partGap,
      labelHeight: data.layout.labelHeight,
      ringWidth: data.layout.ringWidth,
      makeSpacers: data.layout.makeSpacers,
      fluteDirection: data.layout.fluteDirection as FluteDirection,
      flutePitch: data.layout.flutePitch,
      scatterAngle: data.layout.scatterAngle,
      partPlacements: { ...data.layout.partPlacements },
      // Selections point at things that may no longer exist.
      selectedId: null,
      selectedPartId: null,
      currentLayer: 1,
      currentSheet: 1,
    }),
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

/**
 * Does this feature have a position the gizmo can move?
 *
 * Shapes and rods do. Shells and patterns do not: a shell hollows whatever is
 * above it in the tree and a pattern perforates every slice, so neither has a
 * place on the bed. Attaching a gizmo to one wrote transform parameters that
 * nothing read, which looked like a broken drag.
 */
export function hasTransform(feature: Feature): boolean {
  if (feature.kind === 'sculpt') return false;
  return (
    feature.stage === 'RIG' ||
    feature.kind === 'window' ||
    findModule(feature.kind) !== undefined
  );
}

/** Fixture specs of a tree, as the fixture module wants them. */
export function fixturesFromFeatures(features: Feature[], kerf: number): FixtureSpec[] {
  const out: FixtureSpec[] = [];
  for (const f of features) {
    if (!f.kind.startsWith('fixture:') || !f.enabled) continue;
    const kind = f.kind.slice('fixture:'.length) as FixtureKind;
    out.push({
      id: f.id,
      label: f.name,
      kind,
      x: Number(f.params.px) || 0,
      y: Number(f.params.py) || 0,
      z: Number(f.params.pz) || 0,
      length: Math.max(Number(f.params.length) || 0, 0),
      rot: Number(f.params.rot) || 0,
      kerf,
      preset: typeof f.params.preset === 'string' ? f.params.preset : 'custom',
      diameter: Number(f.params.diameter) || 0,
      screws: Math.max(Math.round(Number(f.params.screws) || 0), 0),
      boltCircle: Number(f.params.boltCircle) || 0,
      screwDiameter: Number(f.params.screwDiameter) || 0,
      shape: typeof f.params.shape === 'string' ? f.params.shape : 'round',
      slotLength: Number(f.params.slotLength) || 0,
      width: Number(f.params.width) || 0,
      depth: Number(f.params.depth) || 0,
      corner: Number(f.params.corner) || 0,
    });
  }
  return out;
}

/**
 * Can this feature be rotated?
 *
 * Only shapes. A rod turned about its own axis is unchanged, and a window is
 * turned by its `angle` parameter, which is an angle about the stack rather
 * than a free orientation.
 */
export function hasRotation(feature: Feature): boolean {
  return findModule(feature.kind) !== undefined;
}

/** Where a feature's gizmo should stand, in world mm. */
export function transformOriginOf(
  features: Feature[],
  feature: Feature,
): [number, number, number] {
  const x = Number(feature.params.px) || 0;
  const y = Number(feature.params.py) || 0;

  if (feature.kind === 'window') {
    const world = windowToWorld(
      { x, y, z: Number(feature.params.pz) || 0, angle: 0 },
      windowFrameFor(features, feature),
    );
    return [world.x, world.y, world.z];
  }

  if (feature.stage === 'RIG') {
    const [low, high] = rodSpanOf(feature.params);
    return [x, y, (low + high) / 2];
  }

  return [x, y, Number(feature.params.pz) || 0];
}

/** Pattern settings of a feature, in the shape the generator wants. */
export function patternOptionsOf(
  feature: Feature,
  kerf: number,
  seed: number,
): {
  kind: 'grid' | 'hex' | 'scatter' | 'radial';
  radius: number;
  pitch: number;
  minBridge: number;
  density: number;
  kerf: number;
  seed: number;
  rotatePerLayer: boolean;
  band: number;
} {
  const kind = typeof feature.params.patternKind === 'string' ? feature.params.patternKind : 'hex';
  return {
    kind: (['grid', 'hex', 'scatter', 'radial'].includes(kind) ? kind : 'hex') as
      | 'grid'
      | 'hex'
      | 'scatter'
      | 'radial',
    band: Math.max(Number(feature.params.band) || 0, 0),
    radius: Number(feature.params.radius) || 2,
    pitch: Number(feature.params.pitch) || 8,
    minBridge: Number(feature.params.minBridge) || 1.5,
    density: Number(feature.params.density) || 0,
    kerf,
    seed,
    rotatePerLayer: Number(feature.params.rotatePerLayer) > 0,
  };
}

/** Wall thickness of the last enabled shell in a tree, or 0 when there is none. */
export function shellWallOf(features: Feature[]): number {
  const shell = [...features].reverse().find((f) => f.kind === 'shell' && f.enabled);
  return shell ? Math.max(Number(shell.params.t) || 0, 0) : 0;
}

/** Window features of a tree, as the window module wants them. */
export function windowsFromFeatures(
  features: Feature[],
  fallbackKerf: number,
  seed: number,
): WindowSpec[] {
  const out: WindowSpec[] = [];
  for (const f of features) {
    if (f.kind !== 'window' || !f.enabled) continue;
    const mode = f.params.mode === 'band' ? 'band' : 'perLayer';
    out.push({
      id: f.id,
      label: f.name,
      mode,
      chance: Math.min(Math.max(Number(f.params.chance) ?? 0.3, 0), 1),
      minCount: Math.max(Math.round(Number(f.params.minCount) || 1), 1),
      maxCount: Math.max(Math.round(Number(f.params.maxCount) || 1), 1),
      minWidth: Math.max(Number(f.params.minWidth) || 0, 0),
      maxWidth: Math.max(Number(f.params.maxWidth) || 0, 0),
      x: Number(f.params.px) || 0,
      y: Number(f.params.py) || 0,
      seed,
      count: Math.max(Math.round(Number(f.params.count) || 1), 1),
      width: Number(f.params.width) || 0,
      angle: Number(f.params.angle) || 0,
      twist: Number(f.params.twist) || 0,
      z: Number(f.params.pz) || 0,
      length: Math.max(Number(f.params.length) || 0, 0),
      fit: Math.max(Number(f.params.fit) || 0, 0),
      kerf: Math.max(Number(f.params.windowKerf) ?? fallbackKerf, 0),
    });
  }
  // Placements are stored in the parent's frame; resolve them into world terms
  // here so the sector and the layer planes are measured in the same space.
  return out.map((spec) => {
    const feature = features.find((f) => f.id === spec.id);
    return feature ? resolveWindow(spec, windowFrameFor(features, feature)) : spec;
  });
}

/**
 * The field the rest of the program slices.
 *
 * Windows are applied here rather than inside the SDF core, which has no
 * imports and must not gain one. `solid` is the form before any window is taken
 * out of it — the plug of each window is cut from that, so it has to stay
 * available separately.
 */
export function composeField(
  features: Feature[],
  kerf: number,
  seed: number,
  thickness: number,
  pitch: number,
) {
  // Imports carry their baked volume through to the evaluator here, since the
  // grids live outside the store.
  const fieldFeatures = features.filter(isFieldFeature).map((f) =>
    f.kind === 'import' ? { ...f, volume: importVolumes.get(f.id)?.volume } : f,
  );
  const prepared = prepareFeatures(fieldFeatures);
  const windows = windowsFromFeatures(features, kerf, seed);
  const bounds = modelBounds(fieldFeatures);

  // Per-layer windows have to land on the same planes the slicer will take, so
  // the layer plan is built from the same numbers: the bottom of the model and
  // the pitch.
  const plan: LayerPlan = { z0: bounds ? bounds.min[2] : 0, pitch: Math.max(pitch, 0.01) };

  const solid = (x: number, y: number, z: number) => evaluatePoint(prepared, x, y, z);

  return {
    solid,
    sample: stockField(solid, windows, plan, thickness),
    windows,
    plan,
    thickness,
    bounds,
  };
}

/** Shapes a sculpt feature can be attached to, in tree order. */
export function attachableShapes(features: Feature[]): Feature[] {
  return features.filter((f) => findModule(f.kind) !== undefined);
}
