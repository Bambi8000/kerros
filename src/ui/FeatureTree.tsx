import { useState } from 'react';
import { useKerros } from '../core/store';
import { OP_LABELS, SHAPE_MODULES, findModule, text } from '../core/sdf';
import type { Op } from '../core/sdf';
import { STAGES, STAGE_NOTES } from '../core/types';

export function FeatureTree() {
  const features = useKerros((s) => s.features);
  const selectedId = useKerros((s) => s.selectedId);
  const addShape = useKerros((s) => s.addShape);
  const addRod = useKerros((s) => s.addRod);
  const addShell = useKerros((s) => s.addShell);
  const addPattern = useKerros((s) => s.addPattern);
  const removeFeature = useKerros((s) => s.removeFeature);
  const moveFeature = useKerros((s) => s.moveFeature);
  const toggleFeature = useKerros((s) => s.toggleFeature);
  const selectFeature = useKerros((s) => s.selectFeature);

  const [pending, setPending] = useState(SHAPE_MODULES[0].key);

  return (
    <section className="panel panel-tree">
      <header className="panel-head">
        <h2>Feature tree</h2>
        <span className="panel-count">{features.length}</span>
      </header>

      {features.length === 0 ? (
        <div className="tree-empty">
          <p>The tree is empty. Features evaluate top to bottom, in stage order:</p>
          <ol className="stage-list">
            {STAGES.map((stage) => (
              <li key={stage}>
                <span className="stage-name">{stage}</span>
                <span className="stage-note">{STAGE_NOTES[stage]}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <ul className="tree-rows">
          {features.map((f, i) => {
            const op = text(f.params, 'op', 'union') as Op;
            const known = findModule(f.kind) !== undefined;
            return (
              <li
                key={f.id}
                className={`tree-row${f.id === selectedId ? ' is-selected' : ''}${
                  f.enabled ? '' : ' is-off'
                }`}
                onClick={() => selectFeature(f.id)}
              >
                <span className="row-main">
                  <span className="row-name">{f.name}</span>
                  <span className="row-sub">
                    {f.stage === 'RIG'
                      ? `${f.params.size ?? 'M5'} · ${Number(f.params.length) || 0} mm`
                      : f.stage === 'CARVE'
                        ? `hollow · ${Number(f.params.t) || 0} mm wall`
                        : f.stage === 'PATTERN'
                          ? `${f.params.patternKind ?? 'hex'} · Ø${
                              (Number(f.params.radius) || 0) * 2
                            } at ${Number(f.params.pitch) || 0} mm`
                          : i === 0
                          ? 'base solid'
                          : OP_LABELS[op]}
                    {f.stage === 'SHAPE' && !known ? ' · unknown module' : ''}
                  </span>
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    title="Move up"
                    disabled={i === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      moveFeature(f.id, -1);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    disabled={i === features.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      moveFeature(f.id, 1);
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    title={f.enabled ? 'Skip this feature' : 'Include this feature'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFeature(f.id);
                    }}
                  >
                    {f.enabled ? '●' : '○'}
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFeature(f.id);
                    }}
                  >
                    ×
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <footer className="panel-foot">
        <div className="add-row">
          <select value={pending} onChange={(e) => setPending(e.target.value)}>
            {SHAPE_MODULES.map((m) => (
              <option key={m.key} value={m.key}>
                {m.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn" onClick={() => addShape(pending)}>
            Add
          </button>
        </div>
        <div className="add-row">
          <button type="button" className="btn" onClick={addShell}>
            Add shell
          </button>
          <button type="button" className="btn" onClick={addRod}>
            Add rod
          </button>
        </div>
        <button type="button" className="btn btn-wide" onClick={addPattern}>
          Add wall pattern
        </button>
        <span className="foot-note">
          Order is evaluation order — drag a subtract below what it cuts into.
          Rods are drilled after slicing and ignore tree order.
        </span>
      </footer>
    </section>
  );
}
