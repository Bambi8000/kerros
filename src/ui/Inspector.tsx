import {
  BRUSH_OPS,
  attachableShapes,
  groupChildren,
  groupableParents,
  importEntry,
  importSizeOf,
  rodSpanOf,
  shellWallOf,
  useKerros,
} from '../core/store';
import { openBinary, openText } from './download';
import type { BrushOp } from '../core/store';
import {
  BLEND_PARAM,
  OPS,
  OP_LABELS,
  TRANSFORM_PARAMS,
  findModule,
  num,
  opUsesBlend,
  text,
} from '../core/sdf';
import type { Op } from '../core/sdf';
import { shellModifier } from '../core/sdf';
import { ROD_CLEARANCE, ROD_SIZES } from '../core/rig';
import { LEG_COUNTS, MAX_TILT, legSpacing } from '../core/legs';
import { defaultStagger } from '../core/rig';
import { spokesStickOut } from '../core/boss';
import { indexProfile } from '../core/profile2d';
import { PATTERN_KINDS, PATTERN_LABELS } from '../core/pattern';
import { FIXTURE_LABELS, SOCKET_PRESETS, fixtureExtent } from '../core/fixture';
import type { FixtureKind } from '../core/fixture';
import type { PatternKind } from '../core/pattern';
import type { Feature } from '../core/types';
import {
  DEFAULT_LAYER_SELECTOR,
  LAYER_SELECTOR_KINDS,
  describeSelector,
  resolveLayers,
  selectorFromParams,
} from '../core/layers';
import type { LayerSelectorKind } from '../core/layers';
import type { SliceSet } from '../core/slice';
import { NumberField } from './NumberField';

const SELECTOR_LABELS: Record<LayerSelectorKind, string> = {
  all: 'Every layer',
  band: 'A band, in mm',
  range: 'A run of layers',
  every: 'Every nth layer',
};

/**
 * Which layers a per-slice feature applies to.
 *
 * Shared between fixtures and perforation, and the same control the interleaved
 * pins and the leg holes will use — which is the point of there being one
 * selector rather than four spellings of the question.
 *
 * `band` shows no fields of its own for a fixture: the band **is** the
 * fixture's position and length, which it already has controls for. The other
 * kinds ignore the position entirely.
 */
function LayerSelectorFields({
  feature,
  slices,
  bandIsPosition = false,
}: {
  feature: Feature;
  slices: SliceSet | null;
  bandIsPosition?: boolean;
}) {
  const setParam = useKerros((s) => s.setParam);
  const list = slices?.slices ?? [];
  const fallback = bandIsPosition ? { kind: 'band' as LayerSelectorKind } : {};
  const selector = selectorFromParams(feature.params, fallback);

  /*
   * Switching away from a band takes the feature with it.
   *
   * A fixture draws a ghost of the volume it will remove, and the ghost stands
   * at `pz`. Choose layers by number and leave `pz` alone and the ghost points
   * at one place while the holes are cut in another — the exact silent lie M9.1
   * existed to remove. So the position follows the choice.
   */
  const moveTo = (kind: LayerSelectorKind, next: typeof selector) => {
    if (!bandIsPosition || kind === 'band' || list.length === 0) return;
    // list.length === 0 means nothing has been sliced yet, and the message
    // below says so — moving the ghost to a layer nobody has computed would be
    // a guess dressed as a placement.
    const picked = resolveLayers({ ...next, kind }, list);
    if (picked.length === 0) return;
    const zs = list.filter((s) => picked.includes(s.index)).map((s) => s.z);
    const mid = (Math.min(...zs) + Math.max(...zs)) / 2;
    setParam(feature.id, 'pz', Math.round(mid * 10) / 10);
  };

  return (
    <div className="group">
      <div className="group-head">Layers</div>
      <label className="field">
        <span className="field-label">Choose by</span>
        <span className="field-input">
          <select
            value={selector.kind}
            onChange={(e) => {
              const kind = e.target.value as LayerSelectorKind;
              setParam(feature.id, 'selKind', kind);
              moveTo(kind, selector);
            }}
          >
            {LAYER_SELECTOR_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {bandIsPosition && kind === 'band' ? 'A band around the position' : SELECTOR_LABELS[kind]}
              </option>
            ))}
          </select>
        </span>
      </label>

      {selector.kind === 'band' && !bandIsPosition ? (
        <>
          <NumberField
            label="Middle"
            value={num(feature.params, 'selZ', DEFAULT_LAYER_SELECTOR.z)}
            unit="mm"
            step={1}
            onChange={(v) => setParam(feature.id, 'selZ', v)}
          />
          <NumberField
            label="Height"
            value={num(feature.params, 'selLength', DEFAULT_LAYER_SELECTOR.length)}
            unit="mm"
            step={1}
            min={0}
            onChange={(v) => setParam(feature.id, 'selLength', v)}
          />
        </>
      ) : null}

      {selector.kind === 'range' ? (
        <>
          <NumberField
            label="First layer"
            value={selector.from}
            step={1}
            min={1}
            onChange={(v) => {
              setParam(feature.id, 'selFrom', Math.round(v));
              moveTo('range', { ...selector, from: Math.round(v) });
            }}
          />
          <NumberField
            label="Last layer"
            value={selector.to}
            step={1}
            min={1}
            onChange={(v) => {
              setParam(feature.id, 'selTo', Math.round(v));
              moveTo('range', { ...selector, to: Math.round(v) });
            }}
          />
        </>
      ) : null}

      {selector.kind === 'every' ? (
        <>
          <NumberField
            label="One layer in"
            value={selector.n}
            step={1}
            min={1}
            onChange={(v) => {
              setParam(feature.id, 'selN', Math.round(v));
              moveTo('every', { ...selector, n: Math.round(v) });
            }}
          />
          <NumberField
            label="Starting at"
            value={selector.offset}
            step={1}
            min={0}
            onChange={(v) => {
              setParam(feature.id, 'selOffset', Math.round(v));
              moveTo('every', { ...selector, offset: Math.round(v) });
            }}
          />
        </>
      ) : null}

      {/*
        A selection that comes to nothing has to say what it refused and why.
        Not shown for a fixture's own band, where the position is resolved
        through an attachment frame this panel cannot see — the fixture's own
        "reaches N layers" line covers that case without guessing.
      */}
      {selector.kind !== 'band' || !bandIsPosition ? (
        list.length === 0 ? (
          <div className="warn">
            Nothing sliced yet, so there are no layers to choose between and the
            ghost cannot be placed. Open Slice or Stack once and come back.
          </div>
        ) : (
          <div className={resolveLayers(selector, list).length === 0 ? 'warn' : 'derived'}>
            {describeSelector(selector, list)}
          </div>
        )
      ) : null}
    </div>
  );
}

function RodInspector({ feature }: { feature: Feature }) {
  const setParam = useKerros((s) => s.setParam);
  const renameFeature = useKerros((s) => s.renameFeature);
  const fitRodToModel = useKerros((s) => s.fitRodToModel);

  const size = text(feature.params, 'size', 'M5');
  const override = num(feature.params, 'diameter', 0);
  const effective = override > 0 ? override : (ROD_CLEARANCE[size] ?? 5.3);
  const [zStart, zEnd] = rodSpanOf(feature.params);
  const centre = (zStart + zEnd) / 2;
  const length = zEnd - zStart;

  return (
    <>
      <div className="group">
        <div className="group-head">Rod</div>
        <label className="field">
          <span className="field-label">Name</span>
          <span className="field-input">
            <input
              type="text"
              value={feature.name}
              onChange={(e) => renameFeature(feature.id, e.target.value)}
            />
          </span>
        </label>
        <label className="field">
          <span className="field-label">Thread</span>
          <span className="field-input">
            <select
              value={size}
              onChange={(e) => setParam(feature.id, 'size', e.target.value)}
            >
              {ROD_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s} · Ø{ROD_CLEARANCE[s]} mm
                </option>
              ))}
            </select>
          </span>
        </label>
        <NumberField
          label="Ø override"
          value={override}
          unit="mm"
          step={0.1}
          min={0}
          max={30}
          onChange={(v) => setParam(feature.id, 'diameter', v)}
        />
        <div className="derived">
          Clearance hole Ø{effective.toFixed(2)} mm{override > 0 ? ' (overridden)' : ''}. Set
          the override to 0 to go back to the table.
        </div>
      </div>

      <div className="group">
        <div className="group-head">Placement</div>
        <NumberField
          label="Position X"
          value={num(feature.params, 'px', 0)}
          unit="mm"
          step={0.5}
          onChange={(v) => setParam(feature.id, 'px', v)}
        />
        <NumberField
          label="Position Y"
          value={num(feature.params, 'py', 0)}
          unit="mm"
          step={0.5}
          onChange={(v) => setParam(feature.id, 'py', v)}
        />
        <NumberField
          label="Position Z"
          value={centre}
          unit="mm"
          step={1}
          onChange={(v) => setParam(feature.id, 'pz', v)}
        />
        <NumberField
          label="Length"
          value={length}
          unit="mm"
          step={1}
          min={1}
          max={2000}
          onChange={(v) => setParam(feature.id, 'length', Math.max(v, 1))}
        />
        <button
          type="button"
          className="btn btn-wide"
          onClick={() => fitRodToModel(feature.id)}
        >
          Fit to model height
        </button>
        <div className="derived">
          Position Z is the middle of the rod, the same as every other feature,
          so the gizmo moves it in all three axes. Spans z {zStart.toFixed(1)} to{' '}
          {zEnd.toFixed(1)} mm. Only layers whose mid-plane falls inside that
          span get a hole, so a rod can stop partway up the stack.
        </div>
      </div>
    </>
  );
}

const BRUSH_LABELS: Record<BrushOp, string> = {
  union: 'Add',
  smoothUnion: 'Add, blended',
  subtract: 'Carve',
  smoothSubtract: 'Carve, blended',
};

const IMPORT_RESOLUTIONS = [48, 64, 80, 112, 144];

function ImportInspector({ feature }: { feature: Feature }) {
  const setParam = useKerros((s) => s.setParam);
  const renameFeature = useKerros((s) => s.renameFeature);
  const loadImport = useKerros((s) => s.loadImport);
  const rebakeImport = useKerros((s) => s.rebakeImport);
  const fitImportSize = useKerros((s) => s.fitImportSize);
  // Read so the panel refreshes when a bake finishes; the grids live elsewhere.
  const revision = useKerros((s) => s.importRevision);
  const wall = useKerros((s) => shellWallOf(s.features));

  const entry = importEntry(feature.id);
  void revision;

  const op = text(feature.params, 'op', 'union') as Op;
  const path = text(feature.params, 'path', '');
  const error = text(feature.params, 'error', '');
  const resolution = num(feature.params, 'resolution', 80);
  const scale = num(feature.params, 'scale', 1);
  const size = importSizeOf(feature);
  const longest = size ? Math.max(size[0], size[1], size[2]) : 0;
  // The exact band scales with everything else, so that is what a shell has to
  // fit inside.
  const scaledReach = entry ? entry.grid.reach * scale : 0;

  const pick = async () => {
    const file = await openBinary(['stl', 'obj'], '.stl,.obj');
    if (file) loadImport(feature.id, file.name, file.bytes);
  };

  return (
    <>
      <div className="group">
        <div className="group-head">Imported mesh</div>
        <label className="field">
          <span className="field-label">Name</span>
          <span className="field-input">
            <input
              type="text"
              value={feature.name}
              onChange={(e) => renameFeature(feature.id, e.target.value)}
            />
          </span>
        </label>

        {error !== '' ? <div className="warn">{error}</div> : null}

        {entry ? (
          <div className="derived derived-strong">
            {entry.soup.triangleCount.toLocaleString('en-US')} triangles
            <span className="derived-sub">
              baked in {entry.ms} ms · {entry.grid.step.toFixed(2)} mm samples ·
              exact to {entry.grid.reach.toFixed(1)} mm from the surface
            </span>
          </div>
        ) : (
          <div className="warn">
            No mesh loaded. A project remembers which file it imported, not the
            geometry — the grid is megabytes and the project file is meant to stay
            readable — so after opening a project the mesh has to be located
            again.
          </div>
        )}

        <button type="button" className="btn btn-wide" onClick={() => void pick()}>
          {entry ? 'Replace mesh…' : 'Locate mesh…'}
        </button>
        {path !== '' ? (
          <div className="derived">
            <code>{path}</code>
          </div>
        ) : null}

        {entry && entry.openEdges > 0 ? (
          <div className="warn">
            {entry.openEdges} edges belong to only one triangle, so the mesh is
            not closed. Inside and out are worked out by counting crossings, and
            that needs a closed surface — expect wrong solid or hollow patches
            near the holes.
          </div>
        ) : null}
      </div>

      {entry ? (
        <div className="group">
          <div className="group-head">Size</div>
          <NumberField
            label="Longest axis"
            value={Math.round(longest * 100) / 100}
            unit="mm"
            step={1}
            min={0.1}
            max={5000}
            onChange={(v) => fitImportSize(feature.id, v)}
          />
          <NumberField
            label="Scale"
            value={scale}
            step={0.05}
            min={0.001}
            max={1000}
            onChange={(v) => setParam(feature.id, 'scale', v)}
          />
          {size ? (
            <div className="derived derived-strong">
              {size[0].toFixed(1)} × {size[1].toFixed(1)} × {size[2].toFixed(1)} mm
              <span className="derived-sub">
                on the bed, at scale {scale}
              </span>
            </div>
          ) : null}
          <div className="derived">
            Uniform, and uniform on purpose: multiplying every distance by the
            same number leaves a true distance field, so blends and kerf keep
            meaning what they say. Scaling the axes independently is what breaks
            that, which is why no primitive has a scale at all. An import needs
            one because it arrives at whatever size the exporter left it — often
            in inches.
          </div>
        </div>
      ) : null}

      <div className="group">
        <div className="group-head">Sampling</div>
        <label className="field">
          <span className="field-label">Resolution</span>
          <span className="field-input">
            <select
              value={resolution}
              onChange={(e) => rebakeImport(feature.id, Number(e.target.value))}
              disabled={!entry}
            >
              {IMPORT_RESOLUTIONS.map((r) => (
                <option key={r} value={r}>
                  {r} samples
                </option>
              ))}
            </select>
          </span>
        </label>
        <div className="derived">
          A mesh is baked into a distance grid once, and everything downstream
          reads that grid — so the preview and the slicer see the same surface,
          whatever they sample it at. Detail finer than one sample is gone for
          good, which is the honest cost of importing rather than modelling.
        </div>
        {entry ? (
          <div className="derived">
            Exact to {scaledReach.toFixed(1)} mm from the surface at this scale.
          </div>
        ) : null}
        {entry && wall > 0 && wall > scaledReach - 1 ? (
          <div className="warn">
            The shell wall is {wall} mm but the imported field is only exact{' '}
            {scaledReach.toFixed(1)} mm in. Raise the resolution, scale the mesh
            up, or thin the wall — otherwise the cavity sits where the field was
            clamped rather than where it belongs.
          </div>
        ) : null}
      </div>

      <div className="group">
        <div className="group-head">In the tree</div>
        <label className="field">
          <span className="field-label">Operation</span>
          <span className="field-input">
            <select value={op} onChange={(e) => setParam(feature.id, 'op', e.target.value)}>
              {OPS.map((o) => (
                <option key={o} value={o}>
                  {OP_LABELS[o]}
                </option>
              ))}
            </select>
          </span>
        </label>
        {opUsesBlend(op) ? (
          <NumberField
            label={BLEND_PARAM.label}
            value={num(feature.params, 'k', 0)}
            unit={BLEND_PARAM.unit}
            step={BLEND_PARAM.step}
            min={BLEND_PARAM.min}
            max={BLEND_PARAM.max}
            onChange={(v) => setParam(feature.id, 'k', v)}
          />
        ) : null}
        <div className="derived">
          An import behaves like any other solid: blend it, subtract from it,
          shell it, slice it. It can be clicked and moved too.
        </div>
      </div>

      <div className="group">
        <div className="group-head">Placement</div>
        {TRANSFORM_PARAMS.map((spec) => (
          <NumberField
            key={spec.key}
            label={spec.label}
            value={num(feature.params, spec.key, spec.def)}
            unit={spec.unit}
            step={spec.step}
            min={spec.min}
            max={spec.max}
            onChange={(v) => setParam(feature.id, spec.key, v)}
          />
        ))}
      </div>
    </>
  );
}

function SculptInspector({ feature }: { feature: Feature }) {
  const renameFeature = useKerros((s) => s.renameFeature);
  const features = useKerros((s) => s.features);
  const setSculptParent = useKerros((s) => s.setSculptParent);
  const sculptMode = useKerros((s) => s.sculptMode);
  const setSculptMode = useKerros((s) => s.setSculptMode);
  const brushOp = useKerros((s) => s.brushOp);
  const setBrushOp = useKerros((s) => s.setBrushOp);
  const brushRadius = useKerros((s) => s.brushRadius);
  const setBrushRadius = useKerros((s) => s.setBrushRadius);
  const brushBlend = useKerros((s) => s.brushBlend);
  const setBrushBlend = useKerros((s) => s.setBrushBlend);
  const undoStroke = useKerros((s) => s.undoStroke);
  const clearStrokes = useKerros((s) => s.clearStrokes);
  const mode = useKerros((s) => s.mode);

  const strokes = feature.strokes ?? [];
  const points = strokes.reduce((sum, k) => sum + k.points.length / 3, 0);
  const blended = brushOp.startsWith('smooth');
  const attachTo = text(feature.params, 'attachTo', '');
  const hosts = attachableShapes(features);
  const host = hosts.find((f) => f.id === attachTo);
  const orphaned = attachTo !== '' && host === undefined;

  return (
    <>
      <div className="group">
        <div className="group-head">Sculpt</div>
        <label className="field">
          <span className="field-label">Name</span>
          <span className="field-input">
            <input
              type="text"
              value={feature.name}
              onChange={(e) => renameFeature(feature.id, e.target.value)}
            />
          </span>
        </label>
        <label className="field">
          <span className="field-label">Attached to</span>
          <span className="field-input">
            <select
              value={orphaned ? '' : attachTo}
              onChange={(e) => setSculptParent(feature.id, e.target.value)}
            >
              <option value="">Nothing — world coordinates</option>
              {hosts.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </span>
        </label>
        {orphaned ? (
          <div className="warn">
            The shape this was attached to is gone, so the strokes are back in
            world coordinates. Pick another to weld them to it.
          </div>
        ) : (
          <div className="derived">
            {host
              ? `Strokes are stored in ${host.name}'s coordinates, so moving or turning it carries the sculpting along.`
              : 'Strokes are in world coordinates and will stay put when a shape moves. Attach them to a shape to weld them to it.'}
          </div>
        )}
        <button
          type="button"
          className={`btn btn-wide${sculptMode ? ' is-active' : ''}`}
          disabled={mode !== 'model'}
          onClick={() => setSculptMode(!sculptMode)}
        >
          {sculptMode ? 'Stop sculpting' : 'Start sculpting'}
        </button>
        {mode !== 'model' ? (
          <div className="derived">Sculpting happens in the Model view.</div>
        ) : (
          <div className="derived">
            Left drag paints on the surface, right drag orbits. There has to be
            something to paint on: add a shape first, then sculpt it.
          </div>
        )}
      </div>

      <div className="group">
        <div className="group-head">Brush</div>
        <label className="field">
          <span className="field-label">Action</span>
          <span className="field-input">
            <select value={brushOp} onChange={(e) => setBrushOp(e.target.value as BrushOp)}>
              {BRUSH_OPS.map((op) => (
                <option key={op} value={op}>
                  {BRUSH_LABELS[op]}
                </option>
              ))}
            </select>
          </span>
        </label>
        <NumberField
          label="Radius"
          value={brushRadius}
          unit="mm"
          step={0.5}
          min={0.2}
          max={100}
          onChange={setBrushRadius}
        />
        {blended ? (
          <NumberField
            label="Blend"
            value={brushBlend}
            unit="mm"
            step={0.5}
            min={0}
            max={80}
            onChange={setBrushBlend}
          />
        ) : null}
        <div className="derived">
          The brush settings apply to the next stroke. Strokes already made keep
          the settings they were made with, which is why changing the radius does
          not disturb what is already there.
        </div>
      </div>

      <div className="group">
        <div className="group-head">Strokes</div>
        <div className="derived derived-strong">
          {strokes.length} {strokes.length === 1 ? 'stroke' : 'strokes'}
          <span className="derived-sub">{points} points</span>
        </div>
        <button
          type="button"
          className="btn btn-wide"
          disabled={strokes.length === 0}
          onClick={() => undoStroke(feature.id)}
        >
          Undo last stroke
        </button>
        <button
          type="button"
          className="btn btn-wide"
          disabled={strokes.length === 0}
          onClick={() => clearStrokes(feature.id)}
        >
          Clear all strokes
        </button>
        <div className="derived">
          A stroke is a capsule chain evaluated straight into the field, not
          baked onto a grid. So the shape is the same whatever resolution samples
          it — the preview at 32 and the slicer at 300 agree — and the project
          file stores a list of points rather than a volume.
        </div>
      </div>
    </>
  );
}

function WindowInspector({ feature }: { feature: Feature }) {
  const setParam = useKerros((s) => s.setParam);
  const renameFeature = useKerros((s) => s.renameFeature);
  const stockKerf = useKerros((s) => s.material.kerf);
  const centreOnModel = useKerros((s) => s.centreOnModel);
  const features = useKerros((s) => s.features);
  const setWindowParent = useKerros((s) => s.setWindowParent);

  const mode = text(feature.params, 'mode', 'perLayer');
  const perLayer = mode === 'perLayer';
  const count = num(feature.params, 'count', 4);
  const width = num(feature.params, 'width', 40);
  const fit = num(feature.params, 'fit', 0.4);
  const windowKerf = num(feature.params, 'windowKerf', stockKerf);
  const share = 360 / Math.max(Math.round(count), 1);
  const clamped = Math.min(width, share * 0.9, 178);
  const chance = num(feature.params, 'chance', 0.3);
  const attachTo = text(feature.params, 'attachTo', '');
  const hosts = attachableShapes(features);
  const host = hosts.find((f) => f.id === attachTo);
  const orphaned = attachTo !== '' && host === undefined;

  return (
    <>
      <div className="group">
        <div className="group-head">Window</div>
        <label className="field">
          <span className="field-label">Name</span>
          <span className="field-input">
            <input
              type="text"
              value={feature.name}
              onChange={(e) => renameFeature(feature.id, e.target.value)}
            />
          </span>
        </label>
        <label className="field">
          <span className="field-label">Attached to</span>
          <span className="field-input">
            <select
              value={orphaned ? '' : attachTo}
              onChange={(e) => setWindowParent(feature.id, e.target.value)}
            >
              <option value="">Nothing — stays where it is</option>
              {hosts.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </span>
        </label>
        {orphaned ? (
          <div className="warn">
            The shape this followed is gone, so the window is back on its own.
            Pick another, or leave it detached.
          </div>
        ) : (
          <div className="derived">
            {host
              ? `Follows ${host.name}: moving it, or turning it about Z, takes the windows along. Detach to leave them where they are.`
              : 'Detached. The windows stay put when a shape moves, which is what you want for an eccentric opening.'}
            {host ? ' Only Z rotation is inherited — a wedge tipped out of the stack would not match the layer planes.' : ''}
          </div>
        )}
        <label className="field">
          <span className="field-label">Mode</span>
          <span className="field-input">
            <select
              value={mode}
              onChange={(e) => setParam(feature.id, 'mode', e.target.value)}
            >
              <option value="perLayer">Per layer, random</option>
              <option value="band">One set all the way up</option>
            </select>
          </span>
        </label>
        <div className="derived">
          Takes a wedge out of the form, and the piece that came out becomes a
          part of its own on its own sheets — plexi in cardboard. The plug and
          the hole are the same curve by construction, offset only by the fit.
        </div>
      </div>

      {perLayer ? (
        <div className="group">
          <div className="group-head">Rolls</div>
          <NumberField
            label="Chance"
            value={chance}
            step={0.05}
            min={0}
            max={1}
            onChange={(v) => setParam(feature.id, 'chance', v)}
          />
          <NumberField
            label="Count from"
            value={num(feature.params, 'minCount', 1)}
            step={1}
            min={1}
            max={12}
            onChange={(v) => setParam(feature.id, 'minCount', Math.max(Math.round(v), 1))}
          />
          <NumberField
            label="Count to"
            value={num(feature.params, 'maxCount', 2)}
            step={1}
            min={1}
            max={12}
            onChange={(v) => setParam(feature.id, 'maxCount', Math.max(Math.round(v), 1))}
          />
          <NumberField
            label="Width from"
            value={num(feature.params, 'minWidth', 20)}
            unit="°"
            step={5}
            min={0}
            max={180}
            onChange={(v) => setParam(feature.id, 'minWidth', v)}
          />
          <NumberField
            label="Width to"
            value={num(feature.params, 'maxWidth', 60)}
            unit="°"
            step={5}
            min={0}
            max={180}
            onChange={(v) => setParam(feature.id, 'maxWidth', v)}
          />
          <div className="derived">
            Every layer inside the band rolls for itself: at {(chance * 100).toFixed(0)}%
            about {(chance * 100).toFixed(0)} layers in a hundred get windows, the rest
            stay whole. Seeded from the global seed and this feature&rsquo;s id, so the
            same lamp comes out the same, and changing one setting does not
            reshuffle which layers were chosen.
          </div>
        </div>
      ) : null}

      <div className="group">
        <div className="group-head">{perLayer ? 'Placement' : 'Wedge'}</div>
        {perLayer ? null : (
          <>
            <NumberField
              label="Count"
              value={count}
              step={1}
              min={1}
              max={48}
              onChange={(v) => setParam(feature.id, 'count', Math.max(Math.round(v), 1))}
            />
            <NumberField
              label="Width"
              value={width}
              unit="°"
              step={5}
              min={0}
              max={180}
              onChange={(v) => setParam(feature.id, 'width', v)}
            />
          </>
        )}
        <NumberField
          label="Angle"
          value={num(feature.params, 'angle', 0)}
          unit="°"
          step={5}
          min={-360}
          max={360}
          onChange={(v) => setParam(feature.id, 'angle', v)}
        />
        {perLayer ? null : (
          <NumberField
            label="Twist"
            value={num(feature.params, 'twist', 0)}
            unit="°/mm"
            step={0.1}
            min={-20}
            max={20}
            onChange={(v) => setParam(feature.id, 'twist', v)}
          />
        )}
        {!perLayer && clamped < width - 1e-9 ? (
          <div className="warn">
            {width}° will not fit {count} times round; using {clamped.toFixed(1)}°.
            Wider windows would meet and the ring would fall into loose arcs.
          </div>
        ) : null}
        <div className="derived">
          {perLayer
            ? 'Angle offsets where each layer starts placing its windows. Each layer jitters them within their own share of the circle, so two never merge into one wide opening.'
            : 'Twist turns the set as it goes up, so the windows spiral through the stack and no two layers line up.'}
        </div>
      </div>

      <div className="group">
        <div className="group-head">Axis and band</div>
        <NumberField
          label="Position X"
          value={num(feature.params, 'px', 0)}
          unit="mm"
          step={0.5}
          onChange={(v) => setParam(feature.id, 'px', v)}
        />
        <NumberField
          label="Position Y"
          value={num(feature.params, 'py', 0)}
          unit="mm"
          step={0.5}
          onChange={(v) => setParam(feature.id, 'py', v)}
        />
        <NumberField
          label="Position Z"
          value={num(feature.params, 'pz', 0)}
          unit="mm"
          step={1}
          onChange={(v) => setParam(feature.id, 'pz', v)}
        />
        <NumberField
          label="Height"
          value={num(feature.params, 'length', 60)}
          unit="mm"
          step={1}
          min={0}
          onChange={(v) => setParam(feature.id, 'length', v)}
        />
        <button
          type="button"
          className="btn btn-wide"
          onClick={() => centreOnModel(feature.id)}
        >
          Centre on model
        </button>
        <div className="derived">
          The wedges radiate from this axis, so move it with the shape. A window
          is its own volume rather than something applied to the form, which is
          why it does not follow along the way a shell does. Drag it in the Top
          view; rotation about the stack is the Angle above.
          <br />
          Only layers whose mid-plane falls inside the band can get windows.
          Everything above and below is solid stock.
        </div>
      </div>

      <div className="group">
        <div className="group-head">Fit</div>
        <NumberField
          label="Clearance"
          value={fit}
          unit="mm"
          step={0.05}
          min={0}
          max={5}
          onChange={(v) => setParam(feature.id, 'fit', v)}
        />
        <NumberField
          label="Window kerf"
          value={windowKerf}
          unit="mm"
          step={0.01}
          min={0}
          max={2}
          onChange={(v) => setParam(feature.id, 'windowKerf', v)}
        />
        <div className="derived">
          The finished plug comes out {fit.toFixed(2)} mm smaller than its hole,{' '}
          {(fit / 2).toFixed(2)} mm on each face for glue. The two kerfs pull in
          opposite directions — the hole is cut narrow so it burns out to size,
          the plug is cut wide so it burns down to size — so both numbers have to
          be right. Stock kerf is {stockKerf} mm; this material&rsquo;s is{' '}
          {windowKerf} mm.
        </div>
      </div>
    </>
  );
}

interface PaintProps {
  feature: Feature;
  slices: SliceSet | null;
}

function PaintInspector({ feature, slices }: PaintProps) {
  const setParam = useKerros((s) => s.setParam);
  const renameFeature = useKerros((s) => s.renameFeature);
  const undoStroke = useKerros((s) => s.undoStroke);
  const clearStrokes = useKerros((s) => s.clearStrokes);
  const brushRadius = useKerros((s) => s.brushRadius);
  const setBrushRadius = useKerros((s) => s.setBrushRadius);

  const strokes = feature.strokes ?? [];
  const added = strokes.filter((s) => s.op !== 'subtract').length;
  const carved = strokes.length - added;

  /*
   * A stroke is anchored to the height it was drawn at, so changing the
   * material thickness can leave one outside the stack entirely. It is dropped
   * rather than clamped to an end — clamping would move somebody's edit onto a
   * sheet they never drew on — and a drop that says nothing is the silence this
   * program keeps having to fix.
   */
  const planes = slices?.planes ?? [];
  const lowest = planes.length > 0 ? planes[0].z0 : 0;
  const highest =
    planes.length > 0 ? planes[planes.length - 1].z0 + planes[planes.length - 1].thickness : 0;
  const stranded =
    planes.length === 0
      ? 0
      : strokes.filter((s) => {
          const z = s.points.length >= 3 ? s.points[2] : 0;
          return z < lowest || z > highest;
        }).length;

  /** Which sheets carry a stroke, by the height each was drawn at. */
  const touched = new Set<number>();
  for (const stroke of strokes) {
    const z = stroke.points.length >= 3 ? stroke.points[2] : 0;
    const slice = slices?.slices.find((s) => Math.abs(s.z - z) < 1e-6);
    if (slice) touched.add(slice.index);
  }
  const layers = [...touched].sort((a, b) => a - b);

  return (
    <>
      <div className="group">
        <div className="group-head">Brush</div>
        <label className="field">
          <span className="field-label">Name</span>
          <span className="field-input">
            <input
              type="text"
              value={feature.name}
              onChange={(e) => renameFeature(feature.id, e.target.value)}
            />
          </span>
        </label>
        <div className="derived">
          {strokes.length === 0
            ? 'No strokes yet. Pick Paint or Carve in the slice view and draw.'
            : `${added} painted on, ${carved} carved off${
                layers.length > 0
                  ? ` · ${layers.length === 1 ? 'layer' : 'layers'} ${layers.join(', ')}`
                  : ''
              }`}
        </div>
        {stranded > 0 ? (
          <div className="warn">
            {stranded} stroke{stranded === 1 ? '' : 's'} sit{stranded === 1 ? 's' : ''} outside the
            stack and {stranded === 1 ? 'does' : 'do'} nothing. A stroke is anchored to the height
            it was drawn at, so changing the material thickness can leave one above the top sheet
            or below the bottom one.
          </div>
        ) : null}
        <div className="derived">
          Unlike a fixture or a perforation, these are in the field — so the
          Model view shows them, and each one edits the single sheet it was drawn
          on and reaches neither neighbour.
        </div>
      </div>

      <div className="group">
        <div className="group-head">The brush</div>
        <NumberField
          label="Radius"
          value={brushRadius}
          unit="mm"
          step={brushRadius <= 2 ? 0.2 : 0.5}
          min={0.2}
          max={60}
          onChange={setBrushRadius}
        />
        <div className="derived">
          The next stroke only. Strokes already made keep the radius they were
          made with, so changing this does not disturb what is there. Shared with
          the model view's sculpt brush — there is one brush, not two.
        </div>
        <NumberField
          label="Blend"
          value={num(feature.params, 'k', 0)}
          unit="mm"
          step={0.5}
          min={0}
          onChange={(v) => setParam(feature.id, 'k', v)}
        />
      </div>

      <div className="group">
        <div className="group-head">Undo</div>
        {/*
          A stroke is the unit of undo, the same as in the model view. There is
          no vertex to take back because there is no vertex: a contour point is
          produced by the field and has no identity that survives the form
          changing, which is why this is a brush and not a set of handles.
        */}
        <button
          type="button"
          className="btn btn-wide"
          disabled={strokes.length === 0}
          onClick={() => undoStroke(feature.id)}
        >
          Undo last stroke
        </button>
        <button
          type="button"
          className="btn btn-wide"
          disabled={strokes.length === 0}
          onClick={() => clearStrokes(feature.id)}
        >
          Clear all {strokes.length} strokes
        </button>
      </div>
    </>
  );
}

interface ProfileProps {
  feature: Feature;
}

function ProfileInspector({ feature }: ProfileProps) {
  const setParam = useKerros((s) => s.setParam);
  const renameFeature = useKerros((s) => s.renameFeature);
  const setProfileSize = useKerros((s) => s.setProfileSize);
  const loadProfile = useKerros((s) => s.loadProfile);

  const rings = feature.rings ?? [];
  const path = text(feature.params, 'path', '');
  const fill = text(feature.params, 'fill', 'holes');
  const size = num(feature.params, 'size', 120);
  const height = num(feature.params, 'height', 100);
  const warnings = num(feature.params, 'warnings', 0);
  const blend = num(feature.params, 'k', 10);

  // The reach the index will use, so the panel can say when a blend outruns it.
  const reach = rings.length > 0 ? indexProfile({ rings, fill: fill as 'outline' | 'holes' }).reach : 0;

  return (
    <>
      <div className="group">
        <div className="group-head">Profile</div>
        <label className="field">
          <span className="field-label">Name</span>
          <span className="field-input">
            <input
              type="text"
              value={feature.name}
              onChange={(e) => renameFeature(feature.id, e.target.value)}
            />
          </span>
        </label>
        {/*
          Same trade as a mesh import, and it has to be said the same way: the
          project file keeps the path, not the outline, so a reopened lamp needs
          the drawing again. Presenting an empty feature without saying why is
          the silence this program keeps having to fix.
        */}
        {rings.length === 0 ? (
          <div className="warn">
            No outline loaded. The project file records the path and not the
            drawing, so an SVG has to be located again after opening.
          </div>
        ) : (
          <div className="derived">
            {rings.length} {rings.length === 1 ? 'outline' : 'outlines'} from{' '}
            {path.split(/[\\/]/).pop()}
          </div>
        )}
        {warnings > 0 ? (
          <div className="warn">
            {warnings} part{warnings === 1 ? '' : 's'} of the drawing could not be
            read — text and images are not outlines, and an open path has no
            inside. Convert them to closed paths in your editor.
          </div>
        ) : null}
        <button
          type="button"
          className="btn btn-wide"
          onClick={() => {
            void openText(['svg'], '.svg,image/svg+xml').then((file) => {
              if (file) loadProfile(feature.id, file.name, file.contents);
            });
          }}
        >
          {rings.length === 0 ? 'Locate the SVG…' : 'Replace the SVG…'}
        </button>
      </div>

      <div className="group">
        <div className="group-head">The outline</div>
        <label className="field">
          <span className="field-label">Inner paths</span>
          <span className="field-input">
            <select value={fill} onChange={(e) => setParam(feature.id, 'fill', e.target.value)}>
              <option value="holes">Are holes</option>
              <option value="outline">Are ignored</option>
            </select>
          </span>
        </label>
        <div className="derived">
          {fill === 'holes'
            ? 'A path inside another is a hole, and one inside that is solid again.'
            : 'Only the outermost paths count, so a letter O comes out a disc.'}
        </div>
        <NumberField
          label="Longest axis"
          value={size}
          unit="mm"
          step={5}
          min={1}
          onChange={(v) => setProfileSize(feature.id, v)}
        />
        <div className="derived">
          A drawing arrives at whatever size the editor left it, so it is sized
          here rather than multiplied. Uniform, which is what keeps the field a
          true distance.
        </div>
      </div>

      <div className="group">
        <div className="group-head">Extrusion</div>
        <NumberField
          label="Height"
          value={height}
          unit="mm"
          step={5}
          min={0.5}
          onChange={(v) => setParam(feature.id, 'height', v)}
        />
        <NumberField
          label="Round"
          value={num(feature.params, 'round', 0)}
          unit="mm"
          step={0.5}
          min={0}
          onChange={(v) => setParam(feature.id, 'round', v)}
        />
        <div className="derived">
          Height stretches Z only and leaves the outline alone, so unlike an
          import's scale it can be anything. The round takes a radius off every
          edge of the solid.
        </div>
        {/*
          The one limit worth stating, and the same one a mesh import carries: a
          profile's distance is exact out to a reach and clamped beyond it, so a
          blend wider than that reads a clamped number and comes out wrong.
        */}
        {rings.length > 0 && blend > reach ? (
          <div className="warn">
            The blend is {blend} mm and this outline is exact to {reach.toFixed(1)}{' '}
            mm. Past that the distance is clamped, so a blend that wide will not
            land where it says. Use a smaller blend, or a larger profile.
          </div>
        ) : null}
      </div>
    </>
  );
}

interface BossProps {
  feature: Feature;
  slices: SliceSet | null;
}

function BossInspector({ feature, slices }: BossProps) {
  const setParam = useKerros((s) => s.setParam);
  const renameFeature = useKerros((s) => s.renameFeature);
  const features = useKerros((s) => s.features);

  const rods = features.filter((f) => f.kind === 'rod');
  const attachTo = typeof feature.params.attachTo === 'string' ? feature.params.attachTo : '';
  const rod = rods.find((r) => r.id === attachTo);

  const radius = num(feature.params, 'radius', 10);
  const spokes = Math.max(Math.round(num(feature.params, 'spokes', 3)), 0);
  const spokeLength = num(feature.params, 'spokeLength', 40);
  const reaches = spokesStickOut({ spokes, radius, spokeLength });

  return (
    <>
      <div className="group">
        <div className="group-head">Boss</div>
        <label className="field">
          <span className="field-label">Name</span>
          <span className="field-input">
            <input
              type="text"
              value={feature.name}
              onChange={(e) => renameFeature(feature.id, e.target.value)}
            />
          </span>
        </label>
        {/*
          A boss has no position of its own — it thickens a rod. One pointing at
          a rod that has been deleted or switched off adds nothing, and saying
          which rod it wanted is the difference between a fixable mistake and a
          feature that appears to do nothing.
        */}
        {!rod ? (
          <div className="warn">
            {attachTo === ''
              ? 'Not attached to a rod, so it has nowhere to stand and adds nothing.'
              : `The rod this thickens (${attachTo}) is gone or switched off, so it adds nothing.`}
          </div>
        ) : null}
        <div className="derived">
          A local thickening so a rod standing in the cavity has material to be
          drilled through. Added after the shell has hollowed the form, which is
          why it survives it, and clipped to the form's outside, so it fills the
          cavity without bulging out of the lamp.
        </div>
      </div>

      <div className="group">
        <div className="group-head">Placement</div>
        <label className="field">
          <span className="field-label">Around rod</span>
          <span className="field-input">
            <select
              value={attachTo}
              onChange={(e) => setParam(feature.id, 'attachTo', e.target.value)}
            >
              <option value="">Nothing — adds nothing</option>
              {rods.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </span>
        </label>
        <div className="derived">
          {rod
            ? `Stands where ${rod.name} does, and follows it when it moves.`
            : 'Pick a rod. A boss is a lump around something, not a shape of its own.'}
        </div>
      </div>

      <div className="group">
        <div className="group-head">The thickening</div>
        <NumberField
          label="Radius"
          value={radius}
          unit="mm"
          step={0.5}
          min={0.5}
          onChange={(v) => setParam(feature.id, 'radius', v)}
        />
        <NumberField
          label="Blend"
          value={num(feature.params, 'blend', 2)}
          unit="mm"
          step={0.5}
          min={0}
          onChange={(v) => setParam(feature.id, 'blend', v)}
        />
        <div className="derived">
          The blend is a fillet where the boss meets the form. In a flat cut part
          that is a rounded inside corner rather than a place that tears.
        </div>
      </div>

      <div className="group">
        <div className="group-head">Spokes</div>
        <NumberField
          label="Spokes"
          value={spokes}
          step={1}
          min={0}
          max={12}
          onChange={(v) => setParam(feature.id, 'spokes', Math.round(v))}
        />
        <NumberField
          label="Width"
          value={num(feature.params, 'spokeWidth', 4)}
          unit="mm"
          step={0.5}
          min={0.5}
          onChange={(v) => setParam(feature.id, 'spokeWidth', v)}
        />
        <NumberField
          label="Reach from the axis"
          value={spokeLength}
          unit="mm"
          step={1}
          min={0}
          onChange={(v) => setParam(feature.id, 'spokeLength', v)}
        />
        <NumberField
          label="First spoke at"
          value={num(feature.params, 'angle', 0)}
          unit="°"
          step={5}
          min={-360}
          max={360}
          onChange={(v) => setParam(feature.id, 'angle', v)}
        />
        {/*
          The mistake that fails quietly. A spoke shorter than the boss is inside
          it, the boss is then an island in the cavity, and an island shows up as
          a loose disc on the sheet — on every layer, and only once it is cut.
        */}
        {/*
          Zero is the useful answer, not a missing one. The reach that lands on
          the wall differs on every layer of a curved form, so a typed number is
          only right once — and the clip means overshooting costs nothing.
        */}
        {spokes === 0 ? (
          <div className="warn">
            No spokes, so the boss is an island in the cavity: a loose disc on
            every sheet it appears on.
          </div>
        ) : spokeLength === 0 ? (
          <div className="derived">
            Reaching the wall on every layer. A boss is kept inside the form, so
            a spoke runs until the wall stops it — which is a different distance
            on every sheet of a curved shape and not a number worth typing.
          </div>
        ) : !reaches ? (
          <div className="warn">
            The spokes reach {spokeLength} mm from the axis and the boss is{' '}
            {radius} mm — they do not stick out at all, so it is an island on
            every sheet. Set the reach to 0 to let them run to the wall.
          </div>
        ) : (
          <div className="derived">
            Reach is measured from the axis, and overshooting costs nothing: the
            boss is kept inside the form, so the wall decides where a spoke
            stops. Falling short is the mistake — the slice then shows a loose
            disc and the thin-feature check rings it. 0 reaches the wall on
            every layer.
          </div>
        )}
      </div>

      <LayerSelectorFields feature={feature} slices={slices} />
    </>
  );
}

interface PinsProps {
  feature: Feature;
  slices: SliceSet | null;
  /** Sheets left held on one side only. */
  loose: number[] | undefined;
}

function PinsInspector({ feature, slices, loose }: PinsProps) {
  const setParam = useKerros((s) => s.setParam);
  const renameFeature = useKerros((s) => s.renameFeature);
  const kerf = useKerros((s) => s.material.kerf);

  const restorePins = useKerros((st) => st.restorePins);
  const count = Math.max(Math.round(num(feature.params, 'pinCount', 3)), 1);
  const stagger = num(feature.params, 'stagger', 0);
  const removedCount = String(feature.params.removed ?? '').split(' ').filter(Boolean).length;
  const turn = stagger % 360 === 0 ? defaultStagger(count) : stagger;

  return (
    <>
      <div className="group">
        <div className="group-head">Pins</div>
        <label className="field">
          <span className="field-label">Name</span>
          <span className="field-input">
            <input
              type="text"
              value={feature.name}
              onChange={(e) => renameFeature(feature.id, e.target.value)}
            />
          </span>
        </label>
        {/*
          The one warning that matters. A pattern of holes is not a structure:
          if a gap's pins do not fit, the two sheets either side are not
          fastened to each other, and a stack that comes apart in the middle is
          worse than one that was never pinned.
        */}
        {loose && loose.length > 0 ? (
          <div className="warn">
            {loose.length === 1 ? 'Sheet' : 'Sheets'} {loose.join(', ')}{' '}
            {loose.length === 1 ? 'is' : 'are'} held on one side only — the pins
            in the gap next to {loose.length === 1 ? 'it' : 'them'} would not fit
            both sheets. Move the ring in or out, or use a smaller pin.
          </div>
        ) : null}
        <div className="derived">
          Each pin passes through two neighbouring sheets, so every gap between
          the chosen layers gets a set. Cut per slice, so the Model view cannot
          show them. In the slice view the green holes join the sheet above and
          the violet ones the sheet below; click one and Backspace takes it out.
        </div>
        {removedCount > 0 ? (
          <>
            <button type="button" className="btn btn-wide" onClick={() => restorePins(feature.id)}>
              Put back {removedCount} removed {removedCount === 1 ? 'pin' : 'pins'}
            </button>
            {/*
              A removed pin is a deliberate act, not a miss, so it gets a count
              rather than a warning. Emptying a gap entirely is a different
              matter and the loose-sheet warning above says so.
            */}
            <div className="derived">
              Taken out by hand. They are not counted as holes that would not
              fit — they never had to.
            </div>
          </>
        ) : null}
      </div>

      <div className="group">
        <div className="group-head">The ring</div>
        <NumberField
          label="Pins per gap"
          value={count}
          step={1}
          min={1}
          max={12}
          onChange={(v) => setParam(feature.id, 'pinCount', Math.round(v))}
        />
        <NumberField
          label="Diameter"
          value={num(feature.params, 'diameter', 4)}
          unit="mm"
          step={0.5}
          min={0.5}
          onChange={(v) => setParam(feature.id, 'diameter', v)}
        />
        <NumberField
          label="Radius"
          value={num(feature.params, 'radius', 40)}
          unit="mm"
          step={1}
          min={0}
          onChange={(v) => setParam(feature.id, 'radius', v)}
        />
        <NumberField
          label="First pin at"
          value={num(feature.params, 'angle', 0)}
          unit="°"
          step={5}
          min={-360}
          max={360}
          onChange={(v) => setParam(feature.id, 'angle', v)}
        />
        <NumberField
          label="Turn per gap"
          value={stagger}
          unit="°"
          step={5}
          min={0}
          max={360}
          onChange={(v) => setParam(feature.id, 'stagger', v)}
        />
        {/*
          Why the turn is not decoration: neighbouring gaps drill the sheet they
          share, so at the same angle their pins would meet inside it.
        */}
        <div className="derived">
          {stagger % 360 === 0
            ? `0 uses half a position — ${turn.toFixed(1)}°, as far apart as neighbouring gaps go. `
            : `Each gap is turned ${turn.toFixed(1)}° from the one below. `}
          Two gaps share a sheet, so at the same angle their pins would meet
          inside it. Holes are cut {kerf} mm under size so they open out to the
          diameter above.
        </div>
        {/*
          The default turns each gap as far as it can from its neighbour, which
          is not the same as making the pattern climb: half a position twice is
          a whole position, so the rings repeat every second gap and every sheet
          looks alike. Saying the period out loud is the difference between
          choosing that and not noticing it.
        */}
        <div className="derived">
          {(() => {
            const spacing = 360 / count;
            const steps = Math.round(spacing / turn);
            const exact = Math.abs(steps * turn - spacing) < 1e-6;
            if (exact && steps <= 1) {
              return 'Every gap lands on the same angles — nothing is interleaved.';
            }
            if (exact) {
              return `The rings repeat every ${steps} gaps, so a sheet looks like the one ${steps} above it. For a pattern that keeps climbing, use a turn that does not divide ${spacing.toFixed(1)}° evenly — ${(spacing / (steps + 1)).toFixed(1)}° gives ${steps + 1}.`;
            }
            return `The rings do not line up again for a long way, so the pattern climbs the stack.`;
          })()}
        </div>
      </div>

      <div className="group">
        <div className="group-head">Placement</div>
        <NumberField
          label="Axis X"
          value={num(feature.params, 'px', 0)}
          unit="mm"
          step={0.5}
          onChange={(v) => setParam(feature.id, 'px', v)}
        />
        <NumberField
          label="Axis Y"
          value={num(feature.params, 'py', 0)}
          unit="mm"
          step={0.5}
          onChange={(v) => setParam(feature.id, 'py', v)}
        />
      </div>

      <LayerSelectorFields feature={feature} slices={slices} />
    </>
  );
}

interface LegsProps {
  feature: Feature;
  slices: SliceSet | null;
  /** Chosen layers that produced no sheet — a different thing to a refused hole. */
  gaps: number | undefined;
}

function LegsInspector({ feature, slices, gaps }: LegsProps) {
  const setParam = useKerros((s) => s.setParam);
  const renameFeature = useKerros((s) => s.renameFeature);
  const kerf = useKerros((s) => s.material.kerf);
  const thickness = useKerros((s) => s.material.thickness);

  const count = Math.max(Math.round(num(feature.params, 'legCount', 3)), 1);
  const tilt = num(feature.params, 'tilt', 15);
  const diameter = num(feature.params, 'diameter', 12);
  const sweep = thickness * Math.tan((Math.min(Math.max(tilt, 0), MAX_TILT) * Math.PI) / 180);
  const across = diameter / Math.cos((Math.min(Math.max(tilt, 0), MAX_TILT) * Math.PI) / 180);

  return (
    <>
      <div className="group">
        <div className="group-head">Legs</div>
        <label className="field">
          <span className="field-label">Name</span>
          <span className="field-input">
            <input
              type="text"
              value={feature.name}
              onChange={(e) => renameFeature(feature.id, e.target.value)}
            />
          </span>
        </label>
        {/*
          Nothing is refused any more: legs are cut from the field, so one over
          the rim takes a bite out of it and one entirely off the sheet does
          nothing. What can still surprise somebody is a chosen layer with no
          sheet at all, where a form comes apart along Z.
        */}
        {gaps !== undefined && gaps > 0 ? (
          <div className="warn">
            {gaps} of the chosen layers have no sheet — the form has a gap
            there, so nothing is cut on them. Layers here are counted as planes
            from the bottom, and a plane in a void produces no part.
          </div>
        ) : null}
        <div className="derived">
          Cut from the field, so a leg running over the rim takes a bite out of
          it rather than vanishing, and one entirely off the sheet does nothing.
          The Model view shows them as real holes.
        </div>
      </div>

      <div className="group">
        <div className="group-head">Arrangement</div>
        <label className="field">
          <span className="field-label">Legs</span>
          <span className="field-input">
            <select
              value={count}
              onChange={(e) => setParam(feature.id, 'legCount', Number(e.target.value))}
            >
              {LEG_COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n} · {legSpacing(n).toFixed(n === 7 ? 1 : 0)}° apart
                </option>
              ))}
            </select>
          </span>
        </label>
        <NumberField
          label="Spread"
          value={num(feature.params, 'radius', 50)}
          unit="mm"
          step={1}
          min={0}
          onChange={(v) => setParam(feature.id, 'radius', v)}
        />
        <NumberField
          label="First leg at"
          value={num(feature.params, 'angle', 0)}
          unit="°"
          step={5}
          min={-360}
          max={360}
          onChange={(v) => setParam(feature.id, 'angle', v)}
        />
        {/*
          The Rotate tool is off for legs, and a disabled button that does not
          say why is the same silence this program keeps having to fix. Legs are
          aimed by the angle above, the way a window is: the only rotation that
          means anything here is about the stack's axis, and a free orientation
          would let you tip a set of legs sideways.
        */}
        <div className="derived">
          Aim the set here rather than with the Rotate tool, which is off for
          legs — turning about anything but the stack axis would tip them over.
        </div>
        <div className="derived">
          The spread is measured at the bottom of the model, so it is where the
          legs meet the lamp rather than where the feet land.
        </div>
      </div>

      <div className="group">
        <div className="group-head">The leg</div>
        <NumberField
          label="Diameter"
          value={diameter}
          unit="mm"
          step={0.5}
          min={0.5}
          onChange={(v) => setParam(feature.id, 'diameter', v)}
        />
        <NumberField
          label="Tilt"
          value={tilt}
          unit="°"
          step={1}
          min={0}
          max={MAX_TILT}
          onChange={(v) => setParam(feature.id, 'tilt', v)}
        />
        {/*
          The thing nobody expects, said before it costs a sheet: the hole is
          not the leg's cross-section. A tilted leg leaves an ellipse, and it
          moves sideways on its way through the sheet, so the shape cut is the
          sweep between the two faces.
        */}
        <div className="derived">
          At {tilt.toFixed(0)}° a Ø{diameter} mm leg leaves a hole{' '}
          {across.toFixed(1)} mm across and {(across + sweep).toFixed(1)} mm
          long: the section is an ellipse, and the leg moves {sweep.toFixed(1)} mm
          sideways crossing {thickness} mm of stock. Cutting only the mid-plane
          ellipse would not let it through. Holes are cut {kerf} mm under size so
          they open out to the numbers above.
        </div>
      </div>

      <div className="group">
        <div className="group-head">Placement</div>
        <NumberField
          label="Axis X"
          value={num(feature.params, 'px', 0)}
          unit="mm"
          step={0.5}
          onChange={(v) => setParam(feature.id, 'px', v)}
        />
        <NumberField
          label="Axis Y"
          value={num(feature.params, 'py', 0)}
          unit="mm"
          step={0.5}
          onChange={(v) => setParam(feature.id, 'py', v)}
        />
      </div>

      <LayerSelectorFields feature={feature} slices={slices} />
    </>
  );
}

interface FixtureProps {
  feature: Feature;
  slices: SliceSet | null;
  misses: number | undefined;
}

function FixtureInspector({ feature, slices, misses }: FixtureProps) {
  const setParam = useKerros((s) => s.setParam);
  const renameFeature = useKerros((s) => s.renameFeature);
  const centreOnModel = useKerros((s) => s.centreOnModel);
  const features = useKerros((s) => s.features);
  const setFixtureParent = useKerros((s) => s.setFixtureParent);
  const kerf = useKerros((s) => s.material.kerf);
  const thickness = useKerros((s) => s.material.thickness);
  const spacer = useKerros((s) => s.stack.spacerHeight);

  const kind = text(feature.params, 'fixture', 'socket') as FixtureKind;
  const preset = text(feature.params, 'preset', 'nipple');
  const shape = text(feature.params, 'shape', 'round');
  const pitch = thickness + spacer;
  const band = num(feature.params, 'length', pitch);
  const selectorKind = selectorFromParams(feature.params, { kind: 'band' }).kind;
  const layers = Math.max(Math.floor(band / Math.max(pitch, 0.01)) + 1, 1);

  const spec = {
    kind,
    preset,
    diameter: num(feature.params, 'diameter', 8),
    screws: num(feature.params, 'screws', 0),
    boltCircle: num(feature.params, 'boltCircle', 30),
    screwDiameter: num(feature.params, 'screwDiameter', 3.2),
    shape,
    slotLength: num(feature.params, 'slotLength', 24),
    width: num(feature.params, 'width', 32),
    depth: num(feature.params, 'depth', 22),
  };
  const extent = fixtureExtent(spec as never);
  const attachTo = text(feature.params, 'attachTo', '');
  const hosts = attachableShapes(features);
  const host = hosts.find((f) => f.id === attachTo);
  const orphaned = attachTo !== '' && host === undefined;

  return (
    <>
      <div className="group">
        <div className="group-head">{FIXTURE_LABELS[kind]}</div>
        <label className="field">
          <span className="field-label">Name</span>
          <span className="field-input">
            <input
              type="text"
              value={feature.name}
              onChange={(e) => renameFeature(feature.id, e.target.value)}
            />
          </span>
        </label>
        {misses !== undefined && misses > 0 ? (
          <div className="warn">
            {misses} of these holes will not fit the layer they land on and were
            left out. They need {extent.toFixed(1)} mm of material across —
            usually that means aiming the band at a solid layer, a cap or a foot,
            rather than at a ring.
          </div>
        ) : null}
        <div className="derived">
          Cut per slice, so the Model view cannot show it as a hole — it draws
          the volume it will remove as a see-through ghost you can grab instead.
          The actual holes appear in Slice, Stack and Sheet.
        </div>
        <div className="derived">
          Every dimension here is a default, not a fact. Sockets vary by make,
          Wago cases by series, cable by whatever was in the drawer. Measure the
          part in your hand before the first cut.
        </div>
      </div>

      {kind === 'socket' ? (
        <div className="group">
          <div className="group-head">Socket</div>
          <label className="field">
            <span className="field-label">Fit</span>
            <span className="field-input">
              <select
                value={preset}
                onChange={(e) => setParam(feature.id, 'preset', e.target.value)}
              >
                <option value="nipple">M10 nipple · Ø{SOCKET_PRESETS.nipple} mm</option>
                <option value="body">Socket body · Ø{SOCKET_PRESETS.body} mm</option>
                <option value="custom">Measured</option>
              </select>
            </span>
          </label>
          {preset === 'custom' ? (
            <NumberField
              label="Diameter"
              value={num(feature.params, 'diameter', 10.5)}
              unit="mm"
              step={0.1}
              min={0.5}
              max={120}
              onChange={(v) => setParam(feature.id, 'diameter', v)}
            />
          ) : null}
          <NumberField
            label="Screws"
            value={num(feature.params, 'screws', 0)}
            step={1}
            min={0}
            max={8}
            onChange={(v) => setParam(feature.id, 'screws', Math.max(Math.round(v), 0))}
          />
          {num(feature.params, 'screws', 0) > 0 ? (
            <>
              <NumberField
                label="Bolt circle"
                value={num(feature.params, 'boltCircle', 30)}
                unit="mm"
                step={0.5}
                min={1}
                max={200}
                onChange={(v) => setParam(feature.id, 'boltCircle', v)}
              />
              <NumberField
                label="Screw Ø"
                value={num(feature.params, 'screwDiameter', 3.2)}
                unit="mm"
                step={0.1}
                min={0.5}
                max={20}
                onChange={(v) => setParam(feature.id, 'screwDiameter', v)}
              />
            </>
          ) : null}
          <div className="derived">
            The nipple fit passes the socket&rsquo;s threaded tube through and
            lets its own nut clamp the plate. The body fit drops the socket in
            to sit on its shoulder, and that diameter varies more between makes
            than anything else here.
          </div>
        </div>
      ) : null}

      {kind === 'cable' ? (
        <div className="group">
          <div className="group-head">Channel</div>
          <label className="field">
            <span className="field-label">Shape</span>
            <span className="field-input">
              <select
                value={shape}
                onChange={(e) => setParam(feature.id, 'shape', e.target.value)}
              >
                <option value="round">Round</option>
                <option value="slot">Slot</option>
              </select>
            </span>
          </label>
          <NumberField
            label={shape === 'slot' ? 'Width' : 'Diameter'}
            value={num(feature.params, 'diameter', 8)}
            unit="mm"
            step={0.5}
            min={0.5}
            max={60}
            onChange={(v) => setParam(feature.id, 'diameter', v)}
          />
          {shape === 'slot' ? (
            <NumberField
              label="Length"
              value={num(feature.params, 'slotLength', 24)}
              unit="mm"
              step={1}
              min={1}
              max={300}
              onChange={(v) => setParam(feature.id, 'slotLength', v)}
            />
          ) : null}
          <div className="derived">
            A slot lets the cable lie flat and gives it room to move as the stack
            goes together; a round hole holds it where it is put.
          </div>
        </div>
      ) : null}

      {kind === 'chamber' ? (
        <div className="group">
          <div className="group-head">Pocket</div>
          <NumberField
            label="Width"
            value={num(feature.params, 'width', 32)}
            unit="mm"
            step={1}
            min={1}
            max={400}
            onChange={(v) => setParam(feature.id, 'width', v)}
          />
          <NumberField
            label="Depth"
            value={num(feature.params, 'depth', 22)}
            unit="mm"
            step={1}
            min={1}
            max={400}
            onChange={(v) => setParam(feature.id, 'depth', v)}
          />
          <NumberField
            label="Corner"
            value={num(feature.params, 'corner', 3)}
            unit="mm"
            step={0.5}
            min={0}
            max={50}
            onChange={(v) => setParam(feature.id, 'corner', v)}
          />
          <div className="derived">
            A pocket through several layers is the chamber the connectors sit in.
            Leave a couple of millimetres over the case size: a Wago goes in
            with fingers, not with a mallet.
          </div>
        </div>
      ) : null}

      <div className="group">
        <div className="group-head">Placement</div>
        <label className="field">
          <span className="field-label">Attached to</span>
          <span className="field-input">
            <select
              value={orphaned ? '' : attachTo}
              onChange={(e) => setFixtureParent(feature.id, e.target.value)}
            >
              <option value="">Nothing — stays where it is</option>
              {hosts.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </span>
        </label>
        {orphaned ? (
          <div className="warn">
            The shape this followed is gone, so the fixture is on its own. Pick
            another, or leave it detached.
          </div>
        ) : (
          <div className="derived">
            {host
              ? `Follows ${host.name}: moving it, or turning it about Z, takes this along. Only Z rotation is inherited — a hole belongs to one horizontal sheet, and there is nowhere for a tipped one to go.`
              : 'Detached. Stays where it is when a shape moves.'}
          </div>
        )}
        <NumberField
          label="Position X"
          value={num(feature.params, 'px', 0)}
          unit="mm"
          step={0.5}
          onChange={(v) => setParam(feature.id, 'px', v)}
        />
        <NumberField
          label="Position Y"
          value={num(feature.params, 'py', 0)}
          unit="mm"
          step={0.5}
          onChange={(v) => setParam(feature.id, 'py', v)}
        />
        <NumberField
          label="Position Z"
          value={num(feature.params, 'pz', 0)}
          unit="mm"
          step={1}
          onChange={(v) => setParam(feature.id, 'pz', v)}
        />
        {selectorKind === 'band' ? (
          <NumberField
            label="Band"
            value={band}
            unit="mm"
            step={1}
            min={0}
            onChange={(v) => setParam(feature.id, 'length', v)}
          />
        ) : null}
        <NumberField
          label="Rotation"
          value={num(feature.params, 'rot', 0)}
          unit="°"
          step={5}
          min={-360}
          max={360}
          onChange={(v) => setParam(feature.id, 'rot', v)}
        />
        <button
          type="button"
          className="btn btn-wide"
          onClick={() => centreOnModel(feature.id)}
        >
          Centre on model
        </button>
        <div className="derived">
          {selectorKind === 'band'
            ? `Reaches ${layers} ${layers === 1 ? 'layer' : 'layers'} at the current ${pitch.toFixed(1)} mm pitch. `
            : 'The position follows the layers chosen below, so the ghost stands where the holes are cut. '}
          Holes are cut {kerf} mm under size so they open out to the numbers
          above.
        </div>
      </div>

      <LayerSelectorFields feature={feature} slices={slices} bandIsPosition />
    </>
  );
}

function ShellInspector({ feature }: { feature: Feature }) {
  const setParam = useKerros((s) => s.setParam);
  const renameFeature = useKerros((s) => s.renameFeature);

  const wall = num(feature.params, 't', 6);
  const capTop = num(feature.params, 'capTop', 0) > 0;
  const capBottom = num(feature.params, 'capBottom', 0) > 0;
  const spec = (key: string) => shellModifier.params.find((p) => p.key === key);

  return (
    <>
      <div className="group">
        <div className="group-head">Shell</div>
        <label className="field">
          <span className="field-label">Name</span>
          <span className="field-input">
            <input
              type="text"
              value={feature.name}
              onChange={(e) => renameFeature(feature.id, e.target.value)}
            />
          </span>
        </label>
        <NumberField
          label="Wall"
          value={wall}
          unit="mm"
          step={0.5}
          min={spec('t')?.min}
          max={spec('t')?.max}
          onChange={(v) => setParam(feature.id, 't', v)}
        />
        <div className="derived">
          Hollows everything above it in the tree. The wall comes off the
          inside, so the silhouette you designed stays exactly where it is.
        </div>
      </div>

      <div className="group">
        <div className="group-head">Caps</div>
        <label className="field">
          <span className="field-label">Solid top</span>
          <span className="field-input field-check">
            <input
              type="checkbox"
              checked={capTop}
              onChange={(e) => setParam(feature.id, 'capTop', e.target.checked ? 1 : 0)}
            />
            <span className="field-unit-wide">keep the top closed</span>
          </span>
        </label>
        {capTop ? (
          <NumberField
            label="Above z"
            value={num(feature.params, 'capTopZ', 0)}
            unit="mm"
            step={1}
            onChange={(v) => setParam(feature.id, 'capTopZ', v)}
          />
        ) : null}
        <label className="field">
          <span className="field-label">Solid base</span>
          <span className="field-input field-check">
            <input
              type="checkbox"
              checked={capBottom}
              onChange={(e) => setParam(feature.id, 'capBottom', e.target.checked ? 1 : 0)}
            />
            <span className="field-unit-wide">keep the base closed</span>
          </span>
        </label>
        {capBottom ? (
          <NumberField
            label="Below z"
            value={num(feature.params, 'capBottomZ', 0)}
            unit="mm"
            step={1}
            onChange={(v) => setParam(feature.id, 'capBottomZ', v)}
          />
        ) : null}
        <div className="derived">
          A cap stops the cavity at a height, leaving solid slices there. Both
          off gives a wall all the way through — which for a stack of slices
          means every layer is a ring.
        </div>
      </div>
    </>
  );
}

interface PatternProps {
  feature: Feature;
  placed: number | undefined;
  slices: SliceSet | null;
  sliced: boolean;
}

function PatternInspector({ feature, placed, slices, sliced }: PatternProps) {
  const setParam = useKerros((s) => s.setParam);
  const renameFeature = useKerros((s) => s.renameFeature);
  const kerf = useKerros((s) => s.material.kerf);
  const wall = useKerros((s) => shellWallOf(s.features));

  const kind = text(feature.params, 'patternKind', 'hex') as PatternKind;
  const radius = num(feature.params, 'radius', 2);
  const pitch = num(feature.params, 'pitch', 8);
  const minBridge = num(feature.params, 'minBridge', 1.5);
  const perLayer = num(feature.params, 'rotatePerLayer', 0) > 0;
  const wallNeeded = 2 * radius + 2 * minBridge;

  return (
    <>
      <div className="group">
        <div className="group-head">Perforation</div>
        <label className="field">
          <span className="field-label">Name</span>
          <span className="field-input">
            <input
              type="text"
              value={feature.name}
              onChange={(e) => renameFeature(feature.id, e.target.value)}
            />
          </span>
        </label>
        <label className="field">
          <span className="field-label">Kind</span>
          <span className="field-input">
            <select
              value={kind}
              onChange={(e) => setParam(feature.id, 'patternKind', e.target.value)}
            >
              {PATTERN_KINDS.map((k) => (
                <option key={k} value={k}>
                  {PATTERN_LABELS[k]}
                </option>
              ))}
            </select>
          </span>
        </label>
        {!sliced ? (
          <div className="warn">
            Cut per slice, so perforation never appears in the Model preview —
            not as holes, and not as ghosts either, since a few hundred of them
            would bury the form. Open Slice, Stack or Sheet to see it.
          </div>
        ) : placed === 0 ? (
          <div className="warn">
            No holes placed. This pattern needs {wallNeeded.toFixed(1)} mm of
            wall and{' '}
            {wall > 0
              ? `the shell gives ${wall.toFixed(1)} mm`
              : 'there is no shell in the tree, so there is no wall to perforate'}
            . Make the holes smaller, the bridge narrower, or the wall thicker.
          </div>
        ) : (
          <div className="derived derived-strong">
            {placed} holes
            <span className="derived-sub">
              across the stack · visible in Slice, Stack and Sheet, never in the
              Model preview
            </span>
          </div>
        )}
        <div className="derived">
          Perforates each slice as a flat part, not the solid. A hole carved
          through the form becomes a different shape on every layer it crosses,
          and the layer where it is half a millimetre wide is the one that falls
          apart on the bed. Clearance is measured in the plane of the slice,
          which is where you would measure it with calipers.
        </div>
      </div>

      <div className="group">
        <div className="group-head">Holes</div>
        <NumberField
          label="Radius"
          value={radius}
          unit="mm"
          step={0.1}
          min={0}
          max={50}
          onChange={(v) => setParam(feature.id, 'radius', v)}
        />
        <NumberField
          label="Pitch"
          value={pitch}
          unit="mm"
          step={0.5}
          min={0.5}
          max={200}
          onChange={(v) => setParam(feature.id, 'pitch', v)}
        />
        <NumberField
          label="Density"
          value={num(feature.params, 'density', 1)}
          step={0.05}
          min={0}
          max={1}
          onChange={(v) => setParam(feature.id, 'density', v)}
        />
        <NumberField
          label="Band"
          value={num(feature.params, 'band', 0)}
          unit="mm"
          step={1}
          min={0}
          max={200}
          onChange={(v) => setParam(feature.id, 'band', v)}
        />
        <div className="derived">
          Band keeps the holes within that distance of an edge. 0 fills the
          whole part — which a shelled slice already is, being a narrow ring,
          but a solid cap or foot is not.
        </div>
        <div className="derived">
          Cut at Ø{Math.max(radius * 2 - kerf, 0.1).toFixed(2)} mm so the
          finished hole is Ø{(radius * 2).toFixed(2)} mm.
        </div>
      </div>

      <div className="group">
        <div className="group-head">Bridges</div>
        <NumberField
          label="Min bridge"
          value={minBridge}
          unit="mm"
          step={0.1}
          min={0}
          max={20}
          onChange={(v) => setParam(feature.id, 'minBridge', v)}
        />
        <label className="field">
          <span className="field-label">Per layer</span>
          <span className="field-input field-check">
            <input
              type="checkbox"
              checked={perLayer}
              onChange={(e) => setParam(feature.id, 'rotatePerLayer', e.target.checked ? 1 : 0)}
            />
            <span className="field-unit-wide">turn the pattern each layer</span>
          </span>
        </label>
        <div className="derived">
          No hole is placed unless this much material is left to the wall face,
          to a rod hole and to every other hole. Needs{' '}
          {wallNeeded.toFixed(1)} mm of wall
          {wall > 0 ? `; the shell gives ${wall.toFixed(1)} mm` : ''}. A thinner
          wall is simply not perforated, which is the honest answer rather than
          holes that break out of it.
        </div>
      </div>

      <LayerSelectorFields feature={feature} slices={slices} />
    </>
  );
}

/**
 * The size a shape actually is, where its parameters do not say.
 *
 * Some primitives are dimensioned by a part of themselves rather than by their
 * overall size, and the difference is not guessable: a capsule's length is its
 * straight section and the two caps add a diameter on top, so an 80 mm capsule
 * of radius 25 stands 130 mm tall. Measured in the model view and compared with
 * the panel, that reads as the measuring tape being broken.
 *
 * Only the ones that differ get a line. A sphere needs no help.
 */
function overallSize(kind: string, params: Feature['params']): string | null {
  const n = (key: string, fallback: number) => num(params, key, fallback);
  if (kind === 'capsule') {
    const h = n('h', 80);
    const r = n('r', 25);
    return `${h} mm straight plus two ${r} mm caps — ${(h + 2 * r).toFixed(1)} mm tall, ${(2 * r).toFixed(1)} mm across.`;
  }
  if (kind === 'torus') {
    const R = n('R', 60);
    const r = n('r', 15);
    return `${(2 * (R + r)).toFixed(1)} mm across the outside, ${(2 * (R - r)).toFixed(1)} mm across the hole, ${(2 * r).toFixed(1)} mm thick.`;
  }
  if (kind === 'prism') {
    const sides = Math.max(Math.round(n('n', 6)), 3);
    const r = n('r', 45);
    return `${(2 * r).toFixed(1)} mm corner to corner, ${(2 * r * Math.cos(Math.PI / sides)).toFixed(1)} mm across the flats.`;
  }
  if (kind === 'cone') {
    return `${(2 * n('r1', 50)).toFixed(1)} mm across the bottom, ${(2 * n('r2', 0)).toFixed(1)} mm across the top, ${n('h', 90)} mm tall.`;
  }
  return null;
}

function ShapeInspector({ feature }: { feature: Feature }) {
  const features = useKerros((s) => s.features);
  const setParam = useKerros((s) => s.setParam);
  const setShapeParent = useKerros((s) => s.setShapeParent);
  const groupedUnder = text(feature.params, 'attachTo', '');
  const parents = groupableParents(features, feature.id);
  const leader = parents.find((f) => f.id === groupedUnder);
  const groupOrphaned = groupedUnder !== '' && leader === undefined;
  const children = groupChildren(features, feature.id);
  const renameFeature = useKerros((s) => s.renameFeature);

  const mod = findModule(feature.kind);
  if (!mod) {
    return (
      <div className="inspector-empty">
        Unknown module <code>{feature.kind}</code>. This feature will be skipped
        when the tree is evaluated.
      </div>
    );
  }

  const op = text(feature.params, 'op', 'smoothUnion') as Op;
  const isFirst = features.findIndex((f) => f.id === feature.id) === 0;

  return (
    <>
      <div className="group">
        <div className="group-head">{mod.name}</div>
        <label className="field">
          <span className="field-label">Name</span>
          <span className="field-input">
            <input
              type="text"
              value={feature.name}
              onChange={(e) => renameFeature(feature.id, e.target.value)}
            />
          </span>
        </label>
        <label className="field">
          <span className="field-label">Operation</span>
          <span className="field-input">
            <select value={op} onChange={(e) => setParam(feature.id, 'op', e.target.value)}>
              {OPS.map((o) => (
                <option key={o} value={o}>
                  {OP_LABELS[o]}
                </option>
              ))}
            </select>
          </span>
        </label>
        {opUsesBlend(op) ? (
          <NumberField
            label={BLEND_PARAM.label}
            value={num(feature.params, 'k', BLEND_PARAM.def)}
            unit={BLEND_PARAM.unit}
            step={BLEND_PARAM.step}
            min={BLEND_PARAM.min}
            max={BLEND_PARAM.max}
            onChange={(v) => setParam(feature.id, 'k', v)}
          />
        ) : null}
        {isFirst ? (
          <div className="derived">
            First in the tree, so it starts the solid. Its operation only
            matters once something sits above it.
          </div>
        ) : null}
      </div>

      <div className="group">
        <div className="group-head">Shape</div>
        {mod.params.map((spec) => (
          <NumberField
            key={spec.key}
            label={spec.label}
            value={num(feature.params, spec.key, spec.def)}
            unit={spec.unit}
            step={spec.step}
            min={spec.min}
            max={spec.max}
            onChange={(v) => setParam(feature.id, spec.key, v)}
          />
        ))}
        {(() => {
          const size = overallSize(feature.kind, feature.params);
          return size ? <div className="derived">{size}</div> : null;
        })()}
      </div>

      <div className="group">
        <div className="group-head">Placement</div>
        <label className="field">
          <span className="field-label">Grouped under</span>
          <span className="field-input">
            <select
              value={groupOrphaned ? '' : groupedUnder}
              onChange={(e) => setShapeParent(feature.id, e.target.value)}
            >
              <option value="">Nothing — stands alone</option>
              {parents.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </span>
        </label>
        {groupOrphaned ? (
          <div className="warn">
            The shape this was grouped under is gone, so this one stands alone
            again where it was.
          </div>
        ) : leader ? (
          <div className="derived">
            Its numbers below are in {leader.name}&rsquo;s coordinates, so moving or
            turning {leader.name} carries this shape with it. A group is a
            coordinate unit, not a boolean one — how the shapes combine is still
            the tree order and the operations.
          </div>
        ) : children.length > 0 ? (
          <div className="derived">
            {children.length} {children.length === 1 ? 'shape follows' : 'shapes follow'} this
            one. Move or turn it and they come along.
          </div>
        ) : (
          <div className="derived">
            Group a shape under another to move several as one. Only shapes above
            it in the tree are offered, which is what keeps a group from becoming
            a loop.
          </div>
        )}

        {TRANSFORM_PARAMS.map((spec) => (
          <NumberField
            key={spec.key}
            label={spec.label}
            value={num(feature.params, spec.key, spec.def)}
            unit={spec.unit}
            step={spec.step}
            min={spec.min}
            max={spec.max}
            onChange={(v) => setParam(feature.id, spec.key, v)}
          />
        ))}
        <div className="derived">
          No scale on purpose: non-uniform scaling breaks the distance field,
          and blends and kerf offsets depend on it. Size the primitive instead.
        </div>
      </div>
    </>
  );
}

interface InspectorProps {
  /** The sliced stack, so a layer selector can say what it picked. */
  slices: SliceSet | null;
  /** Holes each pattern feature placed, from the last slicing run. */
  patternCounts: Record<string, number>;
  /** Fixture holes that did not fit, by feature id. */
  holeMisses: Record<string, number>;
  /** Chosen layers with no sheet, by legs feature. */
  legGaps: Record<string, number>;
  pinLoose: Record<string, number[]>;
  /** Whether slicing has run at all — it does not while modelling. */
  sliced: boolean;
}

export function Inspector({ slices, patternCounts, holeMisses, legGaps, pinLoose, sliced }: InspectorProps) {
  const features = useKerros((s) => s.features);
  const selectedId = useKerros((s) => s.selectedId);

  const feature = features.find((f) => f.id === selectedId) ?? null;

  if (!feature) {
    return (
      <div className="inspector-empty">
        Select a feature to edit it. Add one from the tree on the left.
      </div>
    );
  }

  /*
   * Fixtures before rods, and by kind rather than by stage.
   *
   * A fixture's stage is RIG, so `stage === 'RIG'` caught it three lines before
   * the fixture branch and `FixtureInspector` was unreachable — from the day it
   * was written. Every socket, cable channel and Wago chamber has been edited
   * through the rod panel, which is why a fixture's band arrived here labelled
   * "Length" with a rod's tooltip under it.
   *
   * The rod test is on the kind now. Matching a whole stage was always going to
   * catch whatever else moved into that stage next, and something did.
   */
  if (feature.kind.startsWith('fixture:')) {
    return <FixtureInspector feature={feature} slices={slices} misses={holeMisses[feature.id]} />;
  }
  if (feature.kind === 'paint') {
    return <PaintInspector feature={feature} slices={slices} />;
  }
  if (feature.kind === 'profile') {
    return <ProfileInspector feature={feature} />;
  }
  if (feature.kind === 'boss') {
    return <BossInspector feature={feature} slices={slices} />;
  }
  if (feature.kind === 'pins') {
    return <PinsInspector feature={feature} slices={slices} loose={pinLoose[feature.id]} />;
  }
  if (feature.kind === 'legs') {
    return <LegsInspector feature={feature} slices={slices} gaps={legGaps[feature.id]} />;
  }
  if (feature.kind === 'rod') {
    return <RodInspector feature={feature} />;
  }
  if (feature.kind === 'import') return <ImportInspector feature={feature} />;
  if (feature.kind === 'sculpt') return <SculptInspector feature={feature} />;
  if (feature.kind === 'window') return <WindowInspector feature={feature} />;
  if (feature.stage === 'CARVE') return <ShellInspector feature={feature} />;
  if (feature.stage === 'PATTERN') {
    return (
      <PatternInspector
        feature={feature}
        placed={patternCounts[feature.id]}
        slices={slices}
        sliced={sliced}
      />
    );
  }
  /*
   * An unknown RIG kind is named, not guessed at. Falling through to
   * ShapeInspector would hand it a shape's panel the way fixtures once got a
   * rod's — and a wrong panel that looks like it works is worse than one that
   * says it is missing. A new RIG kind adds its own branch above this.
   */
  if (feature.stage === 'RIG') {
    return (
      <div className="inspector-empty">
        No inspector for kind &lsquo;{feature.kind}&rsquo; — a dispatch branch
        is missing here, not anything in your model.
      </div>
    );
  }
  return <ShapeInspector feature={feature} />;
}
