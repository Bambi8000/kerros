import { useMemo, useState, type ReactNode } from 'react';
import type { Feature } from '../core/types';
import type { SliceSet } from '../core/slice';
import { gridMembers, gridPosition, gridSpacing, gridPlannedParts, GRID_LIMITS, type GridAxis } from '../core/grid';
import { useKerros, composeField, isFieldFeature } from '../core/store';
import { NumberField } from './NumberField';

function PlaneCount({ axis, count, onApply }: { axis: GridAxis; count: number; onApply: (count: number) => void }) {
  const [draft, setDraft] = useState<{ count: number; text: string } | null>(null);
  const text = draft?.count === count ? draft.text : String(count);
  const next = Number(text), min = axis === 'z' ? 0 : 1, max = GRID_LIMITS[axis];
  const valid = text.trim() !== '' && Number.isInteger(next) && next >= min && next <= max;
  return <form onSubmit={event => { event.preventDefault(); if (valid && next !== count) onApply(next); setDraft(null); }}>
    <label className="field"><span className="field-label">{axis.toUpperCase()} planes</span><span className="field-input">
      <input type="number" min={min} max={max} step={1} required value={text} onChange={event => setDraft({ count, text: event.target.value })} />
    </span></label>
    <div className="assembly-scope"><span className="hint">{min}–{max} planes</span><button className="btn" type="submit" aria-label={`Apply ${axis.toUpperCase()} plane count`} disabled={!valid || next === count}>Apply</button></div>
    {!valid && <p className="warn">Enter a whole number from {min} to {max}.</p>}
  </form>;
}

export function GridInspector({ feature, layout, set, pending, children }: { feature: Feature; layout: Feature; set: SliceSet | null; pending: boolean; children: ReactNode }) {
  const state = useKerros();
  const { features, material, seed, importRevision } = state;
  const bounds = useMemo(() => {
    // Imported volumes live outside the feature tree; their revision invalidates bounds.
    void importRevision;
    return composeField(features.filter(isFieldFeature), material.kerf, seed, material.thickness, { spacerHeight: 0 }).bounds;
  }, [features, material.kerf, material.thickness, seed, importRevision]);
  const position = (f: Feature) => bounds ? gridPosition(f, features, layout, bounds, material.thickness) : null;
  const field = (f: Feature, key: string, label: string, fallback = 0, unit = 'mm', step = 1) => <NumberField label={label} value={Number(f.params[key] ?? fallback)} unit={unit} step={step} onChange={value => state.setParam(f.id, key, value)} />;
  const parts = set?.slices.filter(s => s.part?.id === feature.id || s.part?.featureId === feature.id) ?? [];
  const planned = gridPlannedParts(state.features, layout);
  return <div className="inspector assembly-inspector">
    <div className="group"><div className="group-head">Grid · X / Y / Z</div>
      <label className="field"><span className="field-label">Name</span><input value={feature.name} onChange={e => state.renameFeature(feature.id, e.target.value)} /></label>
      {feature.id !== layout.id && <button className="btn" onClick={() => state.selectFeature(layout.id)}>Grid settings</button>}
      <button className="btn" disabled={!bounds} onClick={() => state.fitGridToSource(layout.id)}>Fit all axes to source</button>
      <p className="hint">Fit spaces each family inside the current source bounds and follows count, stock and source changes. Manual spacing and offsets are retained for switching back. Joints still need enough material.</p>
      {!layout.enabled && <p className="warn">This layout is disabled. Choose Grid in the tree footer to activate it.</p>}
      {feature.id !== layout.id && !feature.enabled && <p className="warn">This plane is disabled and produces no parts.</p>}
    </div>
    {feature.id === layout.id ? <>
      {(['x', 'y', 'z'] as const).map(axis => {
        const upper = axis.toUpperCase(), fitted = layout.params[`fit${upper}`] === true;
        const stations = gridMembers(features, layout, axis).filter(f => f.enabled).flatMap(f => { const p = position(f); return p === null ? [] : [p]; });
        const extent = bounds ? bounds.max['xyz'.indexOf(axis)] - bounds.min['xyz'.indexOf(axis)] : null;
        return <div className="group" key={axis}><div className="group-head">{upper} · {axis === 'z' ? 'Horizontal cells' : 'Upright planes'}</div>
        <PlaneCount key={`${layout.id}:${axis}`} axis={axis} count={gridMembers(state.features, layout, axis).length} onApply={count => state.setGridCount(layout.id, axis, count)} />
        <label className="field"><span className="field-label">{upper} placement</span><select value={fitted ? 'fit' : 'manual'} onChange={e => state.setParam(layout.id, `fit${upper}`, e.target.value === 'fit')}><option value="manual">Manual spacing</option><option value="fit">Fit to source</option></select></label>
        {fitted ? <p className="derived">{bounds ? `Fitted ${upper} spacing: ${gridSpacing(features, layout, axis, bounds, material.thickness).toFixed(2)} mm.` : 'Add or restore the source to fit these planes.'}</p> : field(layout, `spacing${upper}`, `${upper} spacing`, 30)}
        <p className="derived">{stations.length ? `${upper} coverage: ${Math.min(...stations).toFixed(1)} to ${Math.max(...stations).toFixed(1)} mm from the source centre (${(Math.max(...stations) - Math.min(...stations)).toFixed(1)} mm span).` : 'No enabled stations in the current source.'}{extent !== null && ` Source span: ${extent.toFixed(1)} mm.`}</p>
        {axis === 'z' && <p className="hint">Apply the count with Enter or Apply. Fit to source distributes more planes through the available height. Manual spacing extends the range when the count increases.</p>}
        <div className="assembly-scope grid-plane-links">{gridMembers(state.features, layout, axis).map(f => <button key={f.id} className="btn" onClick={() => state.selectFeature(f.id)}>{axis.toUpperCase()}{f.id.slice(1)}{f.enabled ? '' : ' (off)'}</button>)}</div>
      </div>; })}
      <div className="group"><p className="hint">Each family is centred on the source. Count changes redistribute its stations; retained planes keep their IDs. Manual offsets apply only in Manual spacing. Disable a plane in the tree to omit it without moving the others. Source edits rebuild the profiles and all joints.</p></div>
      <div className="group"><p className={planned > GRID_LIMITS.parts ? 'warn' : 'hint'}>Up to {planned} cut parts before empty cells are removed; limit {GRID_LIMITS.parts}.{planned > GRID_LIMITS.parts ? ' Reduce X, Y or Z planes to generate cut parts.' : planned > 256 ? ' Large grids take longer to calculate.' : ''}</p></div>
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
        {layout.params[`fit${String(feature.params.axis).toUpperCase()}`] === true ? <p className="hint">This family uses Fit to source. Switch its placement to Manual spacing in Grid settings to edit individual offsets.</p> : field(feature, 'offset', 'Station offset')}
        <p className="derived">{position(feature) === null ? 'No source bounds available.' : `Position from source centre: ${position(feature)!.toFixed(2)} mm.`}</p>
        <p className="hint">This regenerates the source profile and its joints. Grid planes stay perpendicular; use the whole-grid rotation to turn the arrangement.</p>
      </div>
      <div className="group"><div className="group-head">{pending ? 'Rebuilding cells…' : `${parts.length} cut ${parts.length === 1 ? 'part' : 'parts'}`}</div>
        {!pending && parts.map(slice => <button key={slice.part!.id} className="btn" onClick={() => { state.setCurrentLayer(slice.index); state.setMode('slice'); }}>{slice.part!.label} · Inspect part</button>)}
      </div>
    </>}
    {children}
  </div>;
}
