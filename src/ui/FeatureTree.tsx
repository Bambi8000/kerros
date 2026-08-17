import { useKerros } from '../core/store';
import { STAGES, STAGE_NOTES } from '../core/types';

/**
 * The feature tree panel. M0 wires ordering, selection, enable and delete;
 * M1 replaces the test row with real SDF features from the module registry.
 */
export function FeatureTree() {
  const features = useKerros((s) => s.features);
  const selectedId = useKerros((s) => s.selectedId);
  const addFeature = useKerros((s) => s.addFeature);
  const removeFeature = useKerros((s) => s.removeFeature);
  const moveFeature = useKerros((s) => s.moveFeature);
  const toggleFeature = useKerros((s) => s.toggleFeature);
  const selectFeature = useKerros((s) => s.selectFeature);

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
          {features.map((f, i) => (
            <li
              key={f.id}
              className={`tree-row${f.id === selectedId ? ' is-selected' : ''}${
                f.enabled ? '' : ' is-off'
              }`}
              onClick={() => selectFeature(f.id)}
            >
              <span className="row-stage">{f.stage}</span>
              <span className="row-name">{f.name}</span>
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
          ))}
        </ul>
      )}

      <footer className="panel-foot">
        <button
          type="button"
          className="btn"
          onClick={() => addFeature('placeholder', 'SHAPE', 'Test row')}
        >
          Add test row
        </button>
        <span className="foot-note">Placeholder until M1 lands the SDF core</span>
      </footer>
    </section>
  );
}
