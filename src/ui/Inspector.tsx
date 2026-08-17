import { useKerros } from '../core/store';
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
import { NumberField } from './NumberField';

export function Inspector() {
  const features = useKerros((s) => s.features);
  const selectedId = useKerros((s) => s.selectedId);
  const setParam = useKerros((s) => s.setParam);
  const renameFeature = useKerros((s) => s.renameFeature);

  const feature = features.find((f) => f.id === selectedId) ?? null;

  if (!feature) {
    return (
      <div className="inspector-empty">
        Select a feature to edit it. Add one from the tree on the left.
      </div>
    );
  }

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
  const index = features.findIndex((f) => f.id === feature.id);
  const isFirst = index === 0;

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
            <select
              value={op}
              onChange={(e) => setParam(feature.id, 'op', e.target.value)}
            >
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
