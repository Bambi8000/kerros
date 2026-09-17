import type { ReactNode } from 'react';
import type { Feature } from '../core/types';
import type { SliceSet } from '../core/slice';
import { gridMembers, gridPosition } from '../core/grid';
import { useKerros } from '../core/store';
import { NumberField } from './NumberField';

export function GridInspector({ feature, layout, set, pending, children }: { feature: Feature; layout: Feature; set: SliceSet | null; pending: boolean; children: ReactNode }) {
  const state = useKerros();
  const field = (f: Feature, key: string, label: string, fallback = 0, unit = 'mm', step = 1) => <NumberField label={label} value={Number(f.params[key] ?? fallback)} unit={unit} step={step} onChange={value => state.setParam(f.id, key, value)} />;
  const parts = set?.slices.filter(s => s.part?.id === feature.id || s.part?.featureId === feature.id) ?? [];
  return <div className="inspector assembly-inspector">
    <div className="group"><div className="group-head">Grid · X / Y / Z</div>
      <label className="field"><span className="field-label">Name</span><input value={feature.name} onChange={e => state.renameFeature(feature.id, e.target.value)} /></label>
      {feature.id !== layout.id && <button className="btn" onClick={() => state.selectFeature(layout.id)}>Grid settings</button>}
      {!layout.enabled && <p className="warn">This layout is disabled. Choose Grid in the tree footer to activate it.</p>}
      {feature.id !== layout.id && !feature.enabled && <p className="warn">This plane is disabled and produces no parts.</p>}
    </div>
    {feature.id === layout.id ? <>
      {(['x', 'y', 'z'] as const).map(axis => <div className="group" key={axis}><div className="group-head">{axis.toUpperCase()} · {axis === 'z' ? 'Horizontal cells' : 'Upright planes'}</div>
        <NumberField label={`${axis.toUpperCase()} planes`} value={gridMembers(state.features, layout, axis).length} min={axis === 'z' ? 0 : 1} max={8} onChange={count => state.setGridCount(layout.id, axis, count)} />
        {field(layout, `spacing${axis.toUpperCase()}`, `${axis.toUpperCase()} spacing`, 30)}
        <div className="assembly-scope">{gridMembers(state.features, layout, axis).map(f => <button key={f.id} className="btn" onClick={() => state.selectFeature(f.id)}>{axis.toUpperCase()}{f.id.slice(1)}{f.enabled ? '' : ' (off)'}</button>)}</div>
      </div>)}
      <div className="group"><p className="hint">Each family is centred on the source. Count changes redistribute its stations; retained planes keep their IDs and offsets. Disable a plane in the tree to omit it without moving the others. Source edits rebuild the profiles and all joints.</p></div>
      <div className="group"><div className="group-head">Joints</div>
        {field(layout, 'jointClearance', 'Clearance per side', 0.1, 'mm', 0.05)}
        {field(layout, 'tabWidth', 'Horizontal tab width', 8)}
        {field(layout, 'reliefRadius', 'Socket corner relief', 0.5, 'mm', 0.1)}
        {field(layout, 'split', 'Upright slot split', 50, '%', 5)}
        <p className="hint">X slots open upward; Y slots downward. Horizontal profiles split into cells. Each cell has a glued tab on one side and an insertion gap at the opposite upright. A small body margin keeps shoulders clear; circular socket relief helps square tabs fit. Read the resulting gap sizes below.</p>
        <p className="hint">Assemble the upright network first. Lower horizontal cells from above, working bottom to top, then slide each tab into its named upright. Inspect the checked order below.</p>
      </div>
      <div className="group"><div className="group-head">Whole grid</div>
        {field(layout, 'px', 'Move X')}{field(layout, 'py', 'Move Y')}{field(layout, 'pz', 'Move Z')}{field(layout, 'angle', 'Rotation', 0, '°')}
        <p className="hint">Grid uses the current stock profile. Rods, LED channels, free plates and wall/ring supports cannot be combined with Grid yet. Carve the source to define a light cavity.</p>
      </div>
    </> : <>
      <div className="group"><div className="group-head">{String(feature.params.axis).toUpperCase()} plane</div>
        {field(feature, 'offset', 'Station offset')}
        <p className="derived">Position from source centre: {gridPosition(feature, state.features, layout).toFixed(2)} mm.</p>
        <p className="hint">This regenerates the source profile and its joints. Grid planes stay perpendicular; use the whole-grid rotation to turn the arrangement.</p>
      </div>
      <div className="group"><div className="group-head">{pending ? 'Rebuilding cells…' : `${parts.length} cut ${parts.length === 1 ? 'part' : 'parts'}`}</div>
        {!pending && parts.map(slice => <button key={slice.part!.id} className="btn" onClick={() => { state.setCurrentLayer(slice.index); state.setMode('slice'); }}>{slice.part!.label} · Inspect part</button>)}
      </div>
    </>}
    {children}
  </div>;
}
