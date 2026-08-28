import { create } from 'zustand';
import type {
  Feature,
  SculptStroke,
  MachineProfile,
  MaterialProfile,
  Stage,
  StackSettings,
} from './types';
import { layerPitch } from './types';
import { DEFAULT_MACHINE, DEFAULT_MATERIAL, DEFAULT_STACK } from './profiles';
import {
  defaultModifierParams,
  defaultParams,
  findModule,
  frameOf,
  localFromWorld,
  rigidOf,
  worldRigidOf,
  frameToLocal,
  frameToWorld,
  modelBounds,
  shellModifier,
} from './sdf';
import type { Frame } from './sdf';
import { WINDOW_WORLD, windowToLocal, windowToWorld } from './window';
import { importMesh, openEdgeCount } from './meshImport';
import type { TriangleSoup } from './meshImport';
import { meshGridBounds, sampleMeshGrid, voxelise } from './voxelise';
import type { MeshGrid } from './voxelise';
import { FIXTURE_LABELS, SOCKET_PRESETS } from './fixture';
import type { FixtureKind } from './fixture';
import type { WindowFrame } from './window';
import type { PartPlacement } from './nest';
import type { ProjectData } from './project';
import { eulerFromMatrix } from './sdf';
import {
  attachFrameFor,
  composeField as composeFieldWith,
  isFieldFeature,
  rodSpanOf,
  windowFrameFor,
} from './pipeline';
import { localiseFixture } from './fixture';

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
  /**
   * Pack against the real outline instead of the bounding box.
   *
   * Off by default: it costs about half a second per layout, which is worth
   * paying when you are about to buy material and not worth paying while you are
   * still deciding what the lamp looks like.
   */
  trueShapeNesting: boolean;
  /** Grid the true-shape packer works on, mm. */
  nestCell: number;
  sculptMode: boolean;
  /** The measuring tape is out in the model view. */
  measureMode: boolean;
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
  addLegs: () => void;
  addShell: () => void;
  addPattern: () => void;
  addWindow: () => void;
  addFixture: (kind: FixtureKind) => void;
  /** Read a mesh, bake it, and hang it on a feature. Creates one if needed. */
  loadImport: (id: string | null, name: string, bytes: Uint8Array) => string;
  /** Re-bake an already loaded mesh at another resolution. */
  rebakeImport: (id: string, resolution: number) => void;
  /** Scale an import so its longest axis measures this, in mm. */
  fitImportSize: (id: string, mm: number) => void;
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
  setTrueShapeNesting: (on: boolean) => void;
  setNestCell: (mm: number) => void;
  setSculptMode: (on: boolean) => void;
  setMeasureMode: (on: boolean) => void;
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
  /** The same for a fixture: it follows a shape, or it stays put. */
  setFixtureParent: (id: string, parentId: string) => void;
  /**
   * Group a shape under another shape, or free it.
   *
   * Unlike a window or a fixture, a shape inherits the **whole** rotation: it is a
   * volume, not a hole in a flat sheet, so tipping over is a move it can make.
   */
  setShapeParent: (id: string, parentId: string) => void;
  /** Write a world-space gizmo drag into a feature's own parameters. */
  setTransformWorld: (
    id: string,
    position: [number, number, number],
    rotation: [number, number, number],
  ) => void;
  /** Move a feature by its world origin, converting for anything attached. */
  setOriginWorld: (id: string, x: number, y: number, z: number) => void;
  /** Shift a feature by a world XY delta, leaving its height untouched. */
  moveOriginWorldBy: (id: string, dx: number, dy: number) => void;
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

/** The main thread's baked volumes, in the shape the field wants them. */
function mainVolumes() {
  const out = new Map<
    string,
    { sample: (x: number, y: number, z: number) => number; min: [number, number, number]; max: [number, number, number] }
  >();
  for (const [id, entry] of importVolumes) out.set(id, entry.volume);
  return out;
}

/** Every baked grid, for handing to a worker after a bake. */
export function importGrids(): { id: string; grid: MeshGrid }[] {
  return Array.from(importVolumes, ([id, entry]) => ({ id, grid: entry.grid }));
}

/** Tenths of a millimetre: stroke points do not need sixteen decimal places. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}


/** The frame a sculpt feature's strokes live in. */
function frameFor(features: Feature[], sculpt: Feature): Frame {
  const target = typeof sculpt.params.attachTo === 'string' ? sculpt.params.attachTo : '';
  if (target === '') return frameOf({});
  const parent = features.find((f) => f.id === target);
  return frameOf(parent ? parent.params : {});
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

  trueShapeNesting: false,
  nestCell: 2,
  sculptMode: false,
  measureMode: false,
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
      // Uniform, and kept across a reload of the same mesh: resizing an import
      // is usually the first thing done to it and should not be undone by
      // swapping the file for a fixed version of itself.
      scale: existing?.params.scale ?? 1,
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

  fitImportSize: (id, mm) =>
    set((s) => {
      const entry = importVolumes.get(id);
      if (!entry || !(mm > 0)) return s;

      // Measured on the mesh itself, not the padded grid: the person means the
      // object, not the box of air around it.
      const size = Math.max(
        entry.soup.max[0] - entry.soup.min[0],
        entry.soup.max[1] - entry.soup.min[1],
        entry.soup.max[2] - entry.soup.min[2],
      );
      if (!(size > 0)) return s;

      const scale = Math.round((mm / size) * 10000) / 10000;
      return {
        features: s.features.map((f) =>
          f.id === id ? { ...f, params: { ...f.params, scale } } : f,
        ),
      };
    }),

  addFixture: (kind) =>
    set((s) => {
      const bounds = modelBounds(s.features.filter(isFieldFeature));
      const id = `f${s.nextFeatureNumber}`;
      const count = s.features.filter((f) => f.kind === `fixture:${kind}`).length + 1;
      /*
       * A fixture's default band is one layer tall, so it needs a pitch. This
       * used to add the two numbers inline, which is the arithmetic
       * `layerPitch` exists to own — and it gave the requested gap rather than
       * the buildable one, so a 4 mm gap of 3 mm rings sized the band on 7 mm
       * of a stack pitched at 6.
       *
       * The pitch at the bottom, since a default is a starting value the person
       * then aims. A graded stack has no single pitch to use here.
       */
      const pitch = layerPitch(s.material, s.stack);

      // Attached to the last shape by default, so a socket hole follows the form
      // it is drilled into. Detachable, since an off-centre cable exit that holds
      // still is a real thing to want.
      const host = [...s.features]
        .reverse()
        .find((f) => f.enabled && findModule(f.kind) !== undefined);
      const hostFrame = host
        ? {
            x: Number(host.params.px) || 0,
            y: Number(host.params.py) || 0,
            z: Number(host.params.pz) || 0,
            rz: Number(host.params.rz) || 0,
          }
        : { x: 0, y: 0, z: 0, rz: 0 };

      const worldX = bounds ? (bounds.min[0] + bounds.max[0]) / 2 : 0;
      const worldY = bounds ? (bounds.min[1] + bounds.max[1]) / 2 : 0;
      const worldZ = bounds ? bounds.min[2] + s.material.thickness / 2 : 0;
      const local = localiseFixture({ x: worldX, y: worldY, z: worldZ, rot: 0 }, hostFrame);

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
              attachTo: host ? host.id : '',
              px: round1(local.x),
              py: round1(local.y),
              pz: round1(local.z),
              length: Math.max(pitch * 0.9, s.material.thickness),
              rot: round1(local.rot),
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
  /**
   * Splayed legs through the bottom sheets.
   *
   * Defaults to the two lowest layers, because that is what the selector is for
   * and because a leg through the whole stack is a rod. The spread is measured
   * at the bottom of the model, so the number typed in is where the legs meet
   * the lamp.
   */
  addLegs: () =>
    set((s) => {
      const bounds = modelBounds(s.features.filter((f) => f.stage === 'SHAPE'));
      const spread = bounds ? Math.max(bounds.max[0], 20) * 0.7 : 50;
      const id = `f${s.nextFeatureNumber}`;
      const count = s.features.filter((f) => f.kind === 'legs').length + 1;

      return {
        features: [
          ...s.features,
          {
            id,
            kind: 'legs',
            stage: 'RIG' as Stage,
            name: `Legs ${count}`,
            enabled: true,
            params: {
              legCount: 3,
              tilt: 15,
              diameter: 12,
              radius: Math.round(spread * 10) / 10,
              angle: 0,
              px: 0,
              py: 0,
              selKind: 'range',
              selFrom: 1,
              selTo: 2,
            },
          },
        ],
        nextFeatureNumber: s.nextFeatureNumber + 1,
        selectedId: id,
      };
    }),

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
  setTrueShapeNesting: (trueShapeNesting) => set({ trueShapeNesting }),
  setNestCell: (nestCell) => set({ nestCell: Math.min(Math.max(nestCell, 0.5), 6) }),
  // The two tools want the same button, so turning one on puts the other away
  // rather than leaving both live and letting the click decide.
  setSculptMode: (sculptMode) => set({ sculptMode, measureMode: sculptMode ? false : get().measureMode }),
  setMeasureMode: (measureMode) => set({ measureMode, sculptMode: measureMode ? false : get().sculptMode }),
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

  setFixtureParent: (id, parentId) =>
    set((s) => {
      const fixture = s.features.find((f) => f.id === id);
      if (!fixture) return s;

      const from = attachFrameFor(s.features, fixture);
      const parent = s.features.find((f) => f.id === parentId);
      const to =
        parentId === '' || !parent
          ? { x: 0, y: 0, z: 0, rz: 0 }
          : {
              x: Number(parent.params.px) || 0,
              y: Number(parent.params.py) || 0,
              z: Number(parent.params.pz) || 0,
              rz: Number(parent.params.rz) || 0,
            };

      // Out of the old frame and into the new one: changing the reference moves
      // the reference, not the hole.
      const a = (from.rz * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const lx = Number(fixture.params.px) || 0;
      const ly = Number(fixture.params.py) || 0;
      const world = {
        x: from.x + lx * cos - ly * sin,
        y: from.y + lx * sin + ly * cos,
        z: from.z + (Number(fixture.params.pz) || 0),
        rot: (Number(fixture.params.rot) || 0) + from.rz,
      };
      const local = localiseFixture(world, to);

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
                  rot: round1(local.rot),
                },
              }
            : f,
        ),
      };
    }),

  setShapeParent: (id, parentId) =>
    set((s) => {
      const shape = s.features.find((f) => f.id === id);
      if (!shape) return s;
      if (parentId === id) return s;

      // A cycle would make the tree unevaluable. The interface only offers
      // parents from earlier in the tree, so this is the belt to that braces.
      let walker = s.features.find((f) => f.id === parentId);
      const seen = new Set<string>([id]);
      while (walker) {
        if (seen.has(walker.id)) return s;
        seen.add(walker.id);
        const next = typeof walker.params.attachTo === 'string' ? walker.params.attachTo : '';
        walker = next === '' ? undefined : s.features.find((f) => f.id === next);
      }

      // Carry the shape across: it keeps the place it is in, and only the
      // reference changes.
      const world = worldRigidOf(s.features, shape);
      const parent = s.features.find((f) => f.id === parentId);
      const parentWorld =
        parentId === '' || !parent
          ? { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] as [number, number, number] }
          : worldRigidOf(s.features, parent);

      const local = localFromWorld(parentWorld, world);

      return {
        features: s.features.map((f) =>
          f.id === id
            ? {
                ...f,
                params: {
                  ...f.params,
                  attachTo: parentId,
                  px: round1(local.position[0]),
                  py: round1(local.position[1]),
                  pz: round1(local.position[2]),
                  rx: round1(local.rotation[0]),
                  ry: round1(local.rotation[1]),
                  rz: round1(local.rotation[2]),
                },
              }
            : f,
        ),
      };
    }),

  setTransformWorld: (id, position, rotation) =>
    set((s) => {
      const feature = s.features.find((f) => f.id === id);
      if (!feature) return s;

      const attachTo = typeof feature.params.attachTo === 'string' ? feature.params.attachTo : '';
      const parent = attachTo === '' ? undefined : s.features.find((f) => f.id === attachTo);

      // Unattached, world is local and the numbers go in as they are.
      if (!parent) {
        return {
          features: s.features.map((f) =>
            f.id === id
              ? {
                  ...f,
                  params: {
                    ...f.params,
                    px: round1(position[0]),
                    py: round1(position[1]),
                    pz: round1(position[2]),
                    rx: round1(rotation[0]),
                    ry: round1(rotation[1]),
                    rz: round1(rotation[2]),
                  },
                }
              : f,
          ),
        };
      }

      const local = localFromWorld(worldRigidOf(s.features, parent), {
        r: rigidOf({ rx: rotation[0], ry: rotation[1], rz: rotation[2] }).r,
        t: position,
      });

      return {
        features: s.features.map((f) =>
          f.id === id
            ? {
                ...f,
                params: {
                  ...f.params,
                  px: round1(local.position[0]),
                  py: round1(local.position[1]),
                  pz: round1(local.position[2]),
                  rx: round1(local.rotation[0]),
                  ry: round1(local.rotation[1]),
                  rz: round1(local.rotation[2]),
                },
              }
            : f,
        ),
      };
    }),

  /**
   * A drag in a slice plane, as a delta.
   *
   * Absolutes were the wrong currency here. A fixture attached to a shape
   * stores `px`/`py` in that shape's frame, so treating the stored numbers as
   * world coordinates throws the feature sideways by the frame the moment
   * anybody drags it — and reconstructing the world position only to convert it
   * straight back is work in service of a mistake.
   *
   * A translation needs no origin. A world delta becomes a local one by turning
   * it against the frame's Z rotation, and nothing else about the frame matters.
   * Height is not touched at all, which is what dragging inside a slice plane
   * means.
   */
  moveOriginWorldBy: (id, dx, dy) =>
    set((s) => {
      const feature = s.features.find((f) => f.id === id);
      if (!feature) return s;

      let rz = 0;
      if (feature.kind.startsWith('fixture:')) rz = attachFrameFor(s.features, feature).rz;
      else if (feature.kind === 'window') rz = windowFrameFor(s.features, feature).rz;

      const a = (-rz * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const localDX = dx * cos - dy * sin;
      const localDY = dx * sin + dy * cos;

      return {
        features: s.features.map((f) =>
          f.id === id
            ? {
                ...f,
                params: {
                  ...f.params,
                  px: round1((Number(f.params.px) || 0) + localDX),
                  py: round1((Number(f.params.py) || 0) + localDY),
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
      if (feature.kind.startsWith('fixture:')) {
        const local = localiseFixture(
          { x, y, z, rot: Number(feature.params.rot) || 0 },
          attachFrameFor(s.features, feature),
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
    feature.kind === 'import' ||
    findModule(feature.kind) !== undefined
  );
}


/**
 * Can this feature be rotated?
 *
 * Only shapes. A rod turned about its own axis is unchanged, and a window is
 * turned by its `angle` parameter, which is an angle about the stack rather
 * than a free orientation.
 */
export function hasRotation(feature: Feature): boolean {
  return feature.kind === 'import' || findModule(feature.kind) !== undefined;
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

  if (feature.kind.startsWith('fixture:')) {
    const frame = attachFrameFor(features, feature);
    const a = (frame.rz * Math.PI) / 180;
    return [
      frame.x + x * Math.cos(a) - y * Math.sin(a),
      frame.y + x * Math.sin(a) + y * Math.cos(a),
      frame.z + (Number(feature.params.pz) || 0),
    ];
  }

  if (feature.stage === 'RIG') {
    const [low, high] = rodSpanOf(feature.params);
    return [x, y, (low + high) / 2];
  }

  return [x, y, Number(feature.params.pz) || 0];
}


/** Wall thickness of the last enabled shell in a tree, or 0 when there is none. */
export function shellWallOf(features: Feature[]): number {
  const shell = [...features].reverse().find((f) => f.kind === 'shell' && f.enabled);
  return shell ? Math.max(Number(shell.params.t) || 0, 0) : 0;
}



/** Shapes a sculpt feature can be attached to, in tree order. */
export function attachableShapes(features: Feature[]): Feature[] {
  return features.filter((f) => findModule(f.kind) !== undefined);
}

/** The size an import measures on the bed, in mm, after its scale. */
export function importSizeOf(feature: Feature): [number, number, number] | null {
  const entry = importVolumes.get(feature.id);
  if (!entry) return null;
  const scale = Math.max(Number(feature.params.scale) || 1, 1e-4);
  return [
    (entry.soup.max[0] - entry.soup.min[0]) * scale,
    (entry.soup.max[1] - entry.soup.min[1]) * scale,
    (entry.soup.max[2] - entry.soup.min[2]) * scale,
  ];
}

/* ------------------------------------------------------------------ *
 * Re-exported from the pipeline
 *
 * These live in `pipeline.ts` so that the whole slicing path can be loaded in
 * Node, and therefore validated, without dragging zustand along. They are
 * re-exported here because every caller in the UI already imports them from the
 * store and there is no reason to churn that.
 * ------------------------------------------------------------------ */

export {
  rodsFromFeatures,
  windowsFromFeatures,
  fixturesFromFeatures,
  legsFromFeatures,
  patternOptionsOf,
} from './pipeline';

// Names the store uses itself are re-exported explicitly, since an
// `export { x } from` does not bring x into this module's scope.
export { isFieldFeature, rodSpanOf, windowFrameFor };

/**
 * The field, using the store's own baked imports.
 *
 * The pipeline's version takes the volume map explicitly, because a worker has
 * its own. On the main thread this is the one anyone wants.
 */
export function composeField(
  features: Feature[],
  kerf: number,
  seed: number,
  thickness: number,
  /**
   * The stack, not a pitch.
   *
   * The pipeline's version took one pitch until gaps could vary; per-layer
   * windows key on which sheet a height falls in, so the field has to know the
   * whole plan. Passed straight through here — this wrapper exists only to
   * supply the main thread's baked imports.
   */
  stack: { spacerHeight: number; spacerHeightTop?: number; spacerThickness?: number },
) {
  return composeFieldWith(features, kerf, seed, thickness, stack, mainVolumes());
}

/**
 * Shapes a shape may be grouped under: only those earlier in the tree.
 *
 * That restriction is what makes a cycle unreachable through the interface, and
 * it matches how the tree reads — a follower sits below its leader.
 */
export function groupableParents(features: Feature[], id: string): Feature[] {
  const at = features.findIndex((f) => f.id === id);
  if (at < 0) return [];
  return features
    .slice(0, at)
    .filter((f) => findModule(f.kind) !== undefined || f.kind === 'import');
}

/** Shapes attached to this one, directly. */
export function groupChildren(features: Feature[], id: string): Feature[] {
  return features.filter((f) => f.params.attachTo === id);
}

/** Where a feature's gizmo should stand in world terms, for a shape. */
export function worldTransformOf(
  features: Feature[],
  feature: Feature,
): { position: [number, number, number]; rotation: [number, number, number] } {
  const world = worldRigidOf(features, feature);
  return {
    position: world.t,
    rotation: eulerFromMatrix(world.r),
  };
}

/** Field features with their baked import volumes attached, for picking. */
export function fieldFeaturesWithVolumes(features: Feature[]): Feature[] {
  return features
    .filter(isFieldFeature)
    .map((f) => (f.kind === 'import' ? { ...f, volume: importEntry(f.id)?.volume } : f)) as Feature[];
}
