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
import { ROD_CLEARANCE, ROD_SIZES } from '../core/rig';
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

  return feature.stage === 'RIG' ? (
    <RodInspector feature={feature} />
  ) : (
    <ShapeInspector feature={feature} />
  );
}
