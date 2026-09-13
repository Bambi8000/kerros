import { useState } from 'react';
import { importEntry, usableProfileKeys, useKerros } from '../core/store';
import { OP_LABELS, SHAPE_MODULES, findModule, text } from '../core/sdf';
import type { Op } from '../core/sdf';
import { STAGES, STAGE_NOTES } from '../core/types';
import { openBinary, openText } from './download';
import type { Feature } from '../core/types';

/** One line under a feature's name, saying what it does at a glance. */
function subtitleFor(f: Feature, index: number, op: Op): string {
  if (f.kind.startsWith('assembly:')) return `${f.id} · ${f.kind.slice(9)}${f.kind === 'assembly:layout' ? ` · ${f.params.layout}` : ''}`;
  if (f.kind === 'holePunch') return `hole · Ø${f.params.diameter} mm · z ${Number(f.params.pz).toFixed(2)} mm`;
  if (f.kind === 'profile') {
    const keys = usableProfileKeys(f);
    if (keys.length >= 2) {
      const span = Math.max(...keys.map((k) => k.z)) - Math.min(...keys.map((k) => k.z));
      return `morph · ${keys.length} keys · ${span.toFixed(1)} mm tall`;
    }
    const rings = f.rings?.length ?? 0;
    if (rings === 0) return 'outline · not loaded';
    return `outline · ${rings} path${rings === 1 ? '' : 's'} · ${Number(f.params.height) || 0} mm tall`;
  }
  if (f.kind === 'import') {
    const triangles = importEntry(f.id)?.soup.triangleCount ?? 0;
    return triangles > 0 ? `mesh · ${triangles.toLocaleString('en-US')} triangles` : 'mesh · not loaded';
  }
  if (f.kind === 'paint') {
    const strokes = f.strokes ?? [];
    const carved = strokes.filter((s) => s.op === 'subtract').length;
    if (strokes.length === 0) return 'brush · nothing drawn yet';
    return `brush · ${strokes.length - carved} on, ${carved} off`;
  }
  if (f.kind === 'sculpt') {
    const count = f.strokes?.length ?? 0;
    const attached = typeof f.params.attachTo === 'string' && f.params.attachTo !== '';
    return `${count} ${count === 1 ? 'stroke' : 'strokes'}${attached ? ' · attached' : ''}`;
  }
  if (f.kind.startsWith('fixture:')) {
    const kind = f.kind.slice('fixture:'.length);
    const attached = typeof f.params.attachTo === 'string' && f.params.attachTo !== '';
    const tail = attached ? ' · attached' : '';
    if (kind === 'socket') return `socket · ${f.params.preset ?? 'nipple'}${tail}`;
    if (kind === 'cable') return `cable · ${f.params.shape ?? 'round'} Ø${Number(f.params.diameter) || 0}${tail}`;
    return `pocket · ${Number(f.params.width) || 0}×${Number(f.params.depth) || 0} mm${tail}`;
  }
  if (f.kind === 'window') {
    const attached = typeof f.params.attachTo === 'string' && f.params.attachTo !== '';
    const mode = f.params.mode === 'band' ? 'band' : 'per layer';
    return `${mode}${attached ? ' · attached' : ''}`;
  }
  // Before the stage test, not after it. Legs and pins are RIG too, and
  // matching the stage is what made the fixture inspector unreachable for its
  // whole life.
  if (f.kind === 'boss') {
    const attached = typeof f.params.attachTo === 'string' && f.params.attachTo !== '';
    return `Ø${(Number(f.params.radius) || 0) * 2} · ${Number(f.params.spokes) || 0} spokes${
      attached ? '' : ' · no rod'
    }`;
  }
  if (f.kind === 'pins') {
    const n = Math.max(Math.round(Number(f.params.pinCount) || 3), 1);
    return `${n} per gap · Ø${Number(f.params.diameter) || 0} at ${Number(f.params.radius) || 0} mm`;
  }
  if (f.kind === 'legs') {
    const n = Math.max(Math.round(Number(f.params.legCount) || 3), 1);
    return `${n} legs · ${Number(f.params.tilt) || 0}° · Ø${Number(f.params.diameter) || 0}`;
  }
  if (f.stage === 'RIG') {
    return `${f.params.size ?? 'M5'} · ${Number(f.params.length) || 0} mm`;
  }
  if (f.stage === 'CARVE') {
    return `hollow · ${Number(f.params.t) || 0} mm wall`;
  }
  if (f.stage === 'PATTERN') {
    return `${f.params.patternKind ?? 'hex'} · Ø${
      (Number(f.params.radius) || 0) * 2
    } at ${Number(f.params.pitch) || 0} mm`;
  }
  return index === 0 ? 'base solid' : OP_LABELS[op];
}

/**
 * How deeply a feature is nested under other features, for indenting the row.
 *
 * A group has no row of its own — it is just shapes pointing at a leader — so the
 * indent is the only thing that shows it in the tree, and it is worth the six
 * lines.
 */
function groupDepth(features: Feature[], feature: Feature): number {
  if (feature.params.groupId) return 1;
  let depth = 0;
  const seen = new Set<string>([feature.id]);
  let target = typeof feature.params.attachTo === 'string' ? feature.params.attachTo : '';

  while (target !== '' && depth < 8) {
    if (seen.has(target)) break;
    seen.add(target);
    const parent = features.find((f) => f.id === target);
    if (!parent) break;
    depth += 1;
    target = typeof parent.params.attachTo === 'string' ? parent.params.attachTo : '';
  }

  return depth;
}

export function FeatureTree() {
  const features = useKerros((s) => s.features);
  const selectedId = useKerros((s) => s.selectedId);
  const addShape = useKerros((s) => s.addShape);
  const addAssembly = useKerros((s) => s.addAssembly);
  const addRod = useKerros((s) => s.addRod);
  const addLegs = useKerros((s) => s.addLegs);
  const addPins = useKerros((s) => s.addPins);
  const addBoss = useKerros((s) => s.addBoss);
  const addShell = useKerros((s) => s.addShell);
  const addPattern = useKerros((s) => s.addPattern);
  const addWindow = useKerros((s) => s.addWindow);
  const addFixture = useKerros((s) => s.addFixture);
  const ensureSculpt = useKerros((s) => s.ensureSculpt);
  const loadImport = useKerros((s) => s.loadImport);
  const loadProfile = useKerros((s) => s.loadProfile);
  const removeFeature = useKerros((s) => s.removeFeature);
  const moveFeature = useKerros((s) => s.moveFeature);
  const toggleFeature = useKerros((s) => s.toggleFeature);
  const selectFeature = useKerros((s) => s.selectFeature);

  const assembly = features.some((f) => f.enabled && f.kind === 'assembly:layout');
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
            const known = findModule(f.kind) !== undefined || ['import', 'profile', 'sculpt', 'paint', 'holePunch'].includes(f.kind);
            return (
              <li
                key={f.id}
                className={`tree-row${f.id === selectedId ? ' is-selected' : ''}${
                  f.enabled ? '' : ' is-off'
                }`}
                onClick={() => selectFeature(f.id)}
              >
                <span
                  className="row-main"
                  style={{ paddingLeft: groupDepth(features, f) * 12 }}
                >
                  <span className="row-name">{f.name}</span>
                  <span className="row-sub">
                    {subtitleFor(f, i, op)}
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
          <button className="btn" disabled={!features.some((f) => f.enabled && f.stage === 'SHAPE')} title="Create upright radial ribs with horizontal ring supports" onClick={() => addAssembly('radial')}>Radial ribs</button>
          <button className="btn" disabled={!features.some((f) => f.enabled && f.stage === 'SHAPE')} title="Create parallel upright ribs with a wall backplate" onClick={() => addAssembly('linear')}>Linear ribs</button>
        </div>
        <details className="source-tools" open={!assembly}>
          <summary>Source shapes and layer tools</summary>
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
        <div className="add-row">
          <button type="button" className="btn" onClick={addPattern}>
            Perforation
          </button>
          <button type="button" className="btn" onClick={addWindow}>
            Window
          </button>
        </div>
        <div className="add-row">
          <button type="button" className="btn" onClick={() => ensureSculpt()}>
            Sculpt
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void openBinary(['stl', 'obj'], '.stl,.obj').then((file) => {
                if (file) loadImport(null, file.name, file.bytes);
              });
            }}
          >
            Import…
          </button>
        </div>
        <div className="add-row">
          <button
            type="button"
            className="btn btn-wide"
            onClick={() => {
              void openText(['svg'], '.svg,image/svg+xml').then((file) => {
                if (file) loadProfile(null, file.name, file.contents);
              });
            }}
          >
            SVG outline…
          </button>
        </div>
        <div className="add-row">
          <button type="button" className="btn" onClick={addLegs}>
            Legs
          </button>
          <button type="button" className="btn" onClick={addPins}>
            Pins
          </button>
        </div>
        <div className="add-row">
          <button type="button" className="btn" onClick={addBoss}>
            Boss
          </button>
        </div>
        <div className="add-row-three">
          <button type="button" className="btn" onClick={() => addFixture('socket')}>
            E27
          </button>
          <button type="button" className="btn" onClick={() => addFixture('cable')}>
            Cable
          </button>
          <button type="button" className="btn" onClick={() => addFixture('chamber')}>
            Wago
          </button>
        </div>
        <span className="foot-note">
          Order is evaluation order — drag a subtract below what it cuts into.
          Rods are drilled after slicing and ignore tree order.
        </span>
        </details>
      </footer>
    </section>
  );
}
