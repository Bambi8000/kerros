import { rodSpanOf, useKerros } from '../core/store';
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
import { PATTERN_KINDS, PATTERN_LABELS } from '../core/pattern';
import type { PatternKind } from '../core/pattern';
import type { Feature } from '../core/types';
import { NumberField } from './NumberField';

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

function PatternInspector({ feature }: { feature: Feature }) {
  const setParam = useKerros((s) => s.setParam);
  const renameFeature = useKerros((s) => s.renameFeature);
  const kerf = useKerros((s) => s.material.kerf);

  const kind = text(feature.params, 'patternKind', 'hex') as PatternKind;
  const radius = num(feature.params, 'radius', 2);
  const pitch = num(feature.params, 'pitch', 8);
  const minBridge = num(feature.params, 'minBridge', 1.5);
  const perLayer = num(feature.params, 'rotatePerLayer', 0) > 0;
  const wallNeeded = 2 * radius + 2 * minBridge;

  return (
    <>
      <div className="group">
        <div className="group-head">Wall pattern</div>
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
        <div className="derived">
          Perforates the wall of every slice, not the solid. A hole carved
          through the form becomes a different shape on every layer it crosses,
          and the layer where it is half a millimetre wide is the one that falls
          apart on the bed.
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
          to a rod hole and to every other hole. A wall thinner than{' '}
          {wallNeeded.toFixed(1)} mm will simply not be perforated, which is the
          honest answer rather than holes that break out of it.
        </div>
      </div>
    </>
  );
}

function ShapeInspector({ feature }: { feature: Feature }) {
  const features = useKerros((s) => s.features);
  const setParam = useKerros((s) => s.setParam);
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
        <div className="derived">
          No scale on purpose: non-uniform scaling breaks the distance field,
          and blends and kerf offsets depend on it. Size the primitive instead.
        </div>
      </div>
    </>
  );
}

export function Inspector() {
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

  if (feature.stage === 'RIG') return <RodInspector feature={feature} />;
  if (feature.stage === 'CARVE') return <ShellInspector feature={feature} />;
  if (feature.stage === 'PATTERN') return <PatternInspector feature={feature} />;
  return <ShapeInspector feature={feature} />;
}
