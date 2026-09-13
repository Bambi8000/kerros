import { useState } from 'react';
import type { Feature } from '../core/types';
import type { SliceSet } from '../core/slice';
import { assemblyNumber as num, sheetWorld } from '../core/assembly';
import { useKerros } from '../core/store';
import { NumberField } from './NumberField';

function RibCollisionActions({ pair }: { pair: [string, string] }) {
  const state = useKerros();
  const [choice, setChoice] = useState(state.selectedId ?? pair[0]);
  const cutId = pair.includes(choice) ? choice : pair[0];
  const otherId = pair.find((id) => id !== cutId)!;
  const existing = state.features.find((f) => f.kind === 'assembly:joint' && pair.every((id) => [f.params.ribA, f.params.ribB].includes(id)));
  return <div>
    {existing ? <button className="btn" onClick={() => state.selectFeature(existing.id)}>Edit rib operation</button> : <>
      <button className="btn" onClick={() => state.addRibOperation(pair[0], pair[1], 'cross')}>Create cross joint</button>
      <label className="field"><span className="field-label">Cut rib</span><select value={cutId} onChange={(e) => setChoice(e.target.value)}>{pair.map((id) => <option key={id} value={id}>R{id.slice(1)}</option>)}</select></label>
      <button className="btn" onClick={() => state.addRibOperation(cutId, otherId, 'clearance')}>Create clearance cut</button>
    </>}
  </div>;
}

export function AssemblyStatus({ set, pending }: { set: SliceSet | null; pending: boolean }) {
  const select = useKerros((s) => s.selectFeature);
  const report = set?.assembly;
  return <div className="assembly-status" aria-live="polite">
    <strong>{pending ? 'Rebuilding parts…' : !report ? 'Add a source shape to build the assembly.' : report.cuttable ? `${set.slices.length} parts · cut geometry ready` : 'Resolve the assembly checks before export'}</strong>
    {!pending && report && <>
      <p className="hint">Dry-fit a small coupon first. Geometry checks do not establish joint strength or hardware suitability.</p>
      {report.issues.map((issue, i) => <div key={i} className={`assembly-issue ${issue.severity}`}>
        <span>{issue.message}</span>
        <div>{issue.ids.map((id) => <button className="part-link" key={id} onClick={() => select(id)}>{set.slices.find((s) => s.part?.id === id)?.part?.label ?? id}</button>)}</div>
        {issue.ribCollision && <RibCollisionActions key={issue.ribCollision.join(':')} pair={issue.ribCollision} />}
      </div>)}
    </>}
  </div>;
}
export function AssemblyInspector({ feature, set, pending }: { feature: Feature; set: SliceSet | null; pending: boolean }) {
  const state = useKerros();
  const [notice, setNotice] = useState('');
  const layout = feature.kind === 'assembly:layout' ? feature : state.features.find((f) => f.id === feature.params.groupId);
  const kind = feature.kind.slice('assembly:'.length);
  const members = state.features.filter((f) => f.params.groupId === layout?.id);
  const p = feature.params;
  const filled = p.outline === 'solid';
  const follows = p.outline === 'frame' || filled;
  const patch = (key: string, value: number | string | boolean) => state.setParam(feature.id, key, value);
  const number = (key: string, label: string, fallback = 0, unit = 'mm', step = 1) => <NumberField key={key} label={label} value={num(feature, key, fallback)} unit={unit} step={step} onChange={(v) => patch(key, v)} />;
  const toggle = (key: string, label: string, fallback = false) => <label className="assembly-check"><input type="checkbox" checked={typeof p[key] === 'boolean' ? Boolean(p[key]) : fallback} onChange={(e) => patch(key, e.target.checked)} />{label}</label>;
  const choose = (key: string, label: string, values: [string, string][], fallback: string) => <label className="field"><span className="field-label">{label}</span><select value={String(p[key] ?? fallback)} onChange={(e) => patch(key, e.target.value)}>{values.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>;
  const count = (kind: 'rib' | 'support', label: string) => <NumberField label={label} value={members.filter((f) => f.kind === `assembly:${kind}`).length} min={kind === 'rib' ? 1 : 0} max={kind === 'rib' ? 64 : 12} onChange={(value) => {
    const all = members.filter((f) => f.kind === `assembly:${kind}`).sort((a, b) => num(a, 'ordinal') - num(b, 'ordinal'));
    const removed = all.slice(Math.max(kind === 'rib' ? 1 : 0, Math.round(value)));
    state.setAssemblyCount(layout!.id, kind, value);
    setNotice(removed.length ? `Removed ${removed.map((f) => f.id).join(', ')}. Retained parts keep their IDs and edits. Explicit channel targets remain visible for correction.` : 'Existing parts keep their placement. New ribs fill the largest radial gap or extend the linear row.');
  }} />;
  const part = set?.slices.find((s) => s.part?.id === feature.id)?.part;
  return <div className="inspector assembly-inspector">
    <div className="group">
      <div className="group-head">{part?.label ?? feature.id} · {kind === 'layout' ? 'Ribs & Supports' : kind === 'backplate' ? 'Wall mount' : kind === 'channel' ? 'LED channel' : kind === 'joint' ? 'Rib intersection' : kind}</div>
      <label className="field"><span className="field-label">Name</span><input value={feature.name} onChange={(e) => state.renameFeature(feature.id, e.target.value)} /></label>
      {layout && kind !== 'layout' && <button className="btn" onClick={() => state.selectFeature(layout.id)}>Assembly settings</button>}
      {!feature.enabled && <p className="warn">This feature is disabled. Enable it in the feature tree to include it.</p>}
    </div>
    {kind === 'layout' && <>
      <div className="group"><div className="group-head">Distribution · {p.layout === 'linear' ? 'Linear' : 'Radial'}</div>
        {count('rib', 'Ribs')}{count('support', 'Horizontal supports')}
        {p.layout === 'linear' ? number('spacing', 'Rib spacing') : <>{number('ribDepth', 'Rib depth')}{number('innerRadius', 'Clear centre radius')}{number('pivotRadius', 'Pivot radius')}</>}
        {number('ribAngle', 'All rib angles', 0, '°')}
        <p className="hint">Shared angle adjustment turns each rib around its own pivot and keeps individual differences.</p>
        <button className="btn" onClick={() => {
          const ribs = members.filter((f) => f.kind === 'assembly:rib').sort((a, b) => num(a, 'ordinal') - num(b, 'ordinal'));
          ribs.forEach((f, i) => {
            if (p.layout === 'linear') { state.setParam(f.id, 'station', i - (ribs.length - 1) / 2); state.setParam(f.id, 'sourceX', (i - (ribs.length - 1) / 2) * num(feature, 'sourceSpacing', num(feature, 'spacing'))); }
            else state.setParam(f.id, 'sourceAngle', i * 360 / ribs.length);
          });
          setNotice('Source stations redistributed evenly. IDs, manual offsets and individual angles are preserved.');
        }}>Distribute source stations evenly</button>
        <p className="hint">Redistribution regenerates source profiles. Moving an individual rib preserves its source profile.</p>
      </div>
      <div className="group"><div className="group-head">Whole assembly</div>
        {number('px', 'Move X')}{number('py', 'Move Y')}{number('pz', 'Move Z')}{number('angle', 'Layout rotation', 0, '°')}
        {number('jointClearance', 'Joint clearance per side', 0.1, 'mm', 0.05)}
        <p className="hint">Joint clearance and laser kerf are separate. Test the fit in your actual stock.</p>
      </div>
      <div className="group"><div className="group-head">Add to assembly</div>
        <button className="btn" disabled={members.some((f) => f.kind === 'assembly:backplate')} onClick={() => state.addAssemblyMember(feature.id, 'backplate')}>Add wall mount</button>
        <button className="btn" onClick={() => state.addAssemblyMember(feature.id, 'channel')}>Add LED channel</button>
        <p className="hint">Use ring supports or a wall mount. Their insertion directions cannot be combined in this version.</p>
      </div>
    </>}
    {kind === 'rib' && <>
      <div className="group"><div className="group-head">Placement</div>
        <div className="assembly-scope" aria-label="Angle scope">
          <button className={`btn${!state.assemblyAllFollow ? ' is-active' : ''}`} onClick={() => state.setAssemblyAllFollow(false)}>Selected</button>
          <button className={`btn${state.assemblyAllFollow ? ' is-active' : ''}`} onClick={() => state.setAssemblyAllFollow(true)}>All follow</button>
        </div>
        <NumberField label="Rib angle" value={num(feature, 'angle')} unit="°" onChange={(v) => state.setAssemblyAngle(feature.id, v, state.assemblyAllFollow)} />
        {number('px', 'Offset X')}{number('py', 'Offset Y')}{number('pz', 'Offset Z')}
        <p className="hint">Drag the selected part with Move or Rotate. Ribs remain upright. All follow affects angles only.</p>
      </div>
      <details className="group"><summary>Source plane</summary>
        {layout?.params.layout === 'linear' ? <>{number('sourceX', 'Source X')}{number('station', 'Layout station', 0, '', 0.5)}</> : number('sourceAngle', 'Source angle', 0, '°')}
        <p className="hint">These controls regenerate the unjointed outline from the source model. Placement controls above do not.</p>
      </details>
    </>}
    {kind === 'joint' && <div className="group"><div className="group-head">Rib intersection</div>
      {choose('operation', 'Action', [['cross', 'Cross joint'], ['clearance', 'Clearance cut']], 'cross')}
      {(['ribA', 'ribB'] as const).map((key) => {
        const choices = members.filter((f) => f.kind === 'assembly:rib').map((f): [string, string] => [f.id, `R${f.id.slice(1)} · ${f.name}${f.enabled ? '' : ' (disabled)'}`]);
        if (!choices.some(([id]) => id === p[key])) choices.unshift([String(p[key] ?? ''), `${p[key] || 'Unset'} (missing)`]);
        return <div key={key}>{choose(key, p.operation === 'clearance' ? key === 'ribA' ? 'Cut rib' : 'Keep rib' : key === 'ribA' ? 'Rib A' : 'Rib B', choices, '')}
          <button className="btn" disabled={!members.some((f) => f.id === p[key])} onClick={() => { state.selectFeature(String(p[key])); state.setMode('slice'); }}>Inspect R{String(p[key]).slice(1)}</button></div>;
      })}
      {p.operation !== 'clearance' ? <>
        {choose('upper', 'Upward-opening slot', [['auto', 'Automatic'], ['a', 'Rib A'], ['b', 'Rib B']], 'auto')}
        {number('split', 'Joint split', 50, '%', 5)}{number('reliefRadius', 'Tip relief radius', 0.5, 'mm', 0.1)}
        <p className="hint">The other slot opens downward. Split is a percentage of the shared crossing height; 50% meets in the middle. Tip relief adds small circular clearances at the closed corners. Assemble the ribs first, then fit the wall plate from behind. Read the checked insertion order below.</p>
      </> : <p className="hint">Removes the other rib’s full-thickness crossing from Cut rib. Keep rib retains its profile. This is a clearance opening, not an attachment. A cut that splits the rib or damages an existing joint is refused.</p>}
      <p className="hint">Uses the assembly’s joint clearance per side: {layout ? num(layout, 'jointClearance', 0.1) : 0.1} mm. Actual angles and both stock thicknesses determine cut width; kerf is applied afterwards. Test the fit in the chosen stock.</p>
    </div>}
    {kind === 'support' && <div className="group"><div className="group-head">Horizontal support</div>
      {number('outerDiameter', 'Outer diameter')}{number('innerDiameter', 'Inner diameter')}{number('pz', 'Height from centre')}{number('px', 'Centre X')}{number('py', 'Centre Y')}
      <p className="hint">Inner diameter 0 makes a disc. Complementary slots open along each rib’s insertion direction.</p>
    </div>}
    {kind === 'backplate' && <>
      <div className="group"><div className="group-head">Backplate</div>
        {choose('outline', 'Outline', [['frame', 'Open frame'], ['solid', 'Minimal solid'], ['rectangle', 'Solid rectangle']], 'rectangle')}
        {follows ? <>
          {number('frameWidth', 'Frame width', num(feature, 'tabHeight', 12) + 6)}{number('profileInset', 'Profile inset', 4)}
          <p className="hint">{filled ? 'The same profile-following outline as Open frame, with its centre filled. Frame width and profile inset keep the same meaning in both modes; tab slots and mounting holes remain open.' : 'Upper and lower rails follow every rib’s usable shoulder band. Rounded ends join them into one open frame. Width sets rail thickness; inset moves the rails inward.'} Short ribs reduce the inset locally or use one centred tab, keeping the requested tab height.</p>
        </> : <>
        {number('width', 'Plate width')}{number('height', 'Plate height')}{number('cornerRadius', 'Corner radius')}{number('margin', 'Fit margin', 8)}
        <button className="btn" disabled={pending || !set?.assembly} onClick={() => {
          const points = set!.slices.filter((s) => s.part?.kind === 'rib').flatMap((s) => s.contours.flatMap((c) => c.points.reduce<number[][]>((out, x, i) => { if (i % 2 === 0) out.push(sheetWorld(s.part!, x, c.points[i + 1])); return out; }, [])));
          if (!points.length || !part) return;
          const back = part;
          const coords = points.map((p) => { const d = p.map((v, i) => v - back.origin[i]); return [d.reduce((sum, v, i) => sum + v * back.u[i], 0), d.reduce((sum, v, i) => sum + v * back.v[i], 0)]; });
          const xs = coords.map((p) => p[0]), zs = coords.map((p) => p[1]);
          patch('width', 2 * Math.max(...xs.map(Math.abs)) + 2 * num(feature, 'margin', 8));
          patch('height', 2 * Math.max(...zs.map(Math.abs)) + 2 * num(feature, 'margin', 8));
        }}>Fit plate to current ribs</button>
        </>}
        {number('px', follows ? 'Frame offset X' : 'Centre X')}{number('py', 'Front face Y')}{number('pz', follows ? 'Frame offset Z' : 'Centre Z')}{number('wallOffset', 'Space behind plate')}
        {follows && <p className="hint">Keep frame offsets at zero to follow the ribs. Offsets move the outline; mating slots stay aligned with the ribs.</p>}
        <p className="hint">The faint plane shows the wall. Mounting spacers and hardware are not generated.</p>
      </div>
      <div className="group"><div className="group-head">Glued tabs</div>
        {number('tabHeight', 'Tab height')}{!follows && number('tabSpacing', 'Tab centre spacing')}{number('tabProtrusion', 'Protrusion behind plate')}
        <p className="hint">{follows ? 'Two tabs per rib where they fit; short ribs use one centred tab. The checks name any adaptation and count attached ribs.' : 'Two tabs per rib.'} Shoulders set insertion depth; oblique slots include both stock thicknesses. Glue choice and strength require a physical test.</p>
      </div>
      <details className="group" open><summary>Wall mounting openings</summary>
        {choose('mount', 'Opening', [['none', 'None'], ['screw', 'Screw holes'], ['keyhole', 'Keyholes']], 'screw')}
        {p.mount !== 'none' && <>
          {follows && choose('mountPlacement', 'Placement', [['auto', 'Follow upper rail'], ['manual', 'Manual coordinates']], 'auto')}
          {(!follows || p.mountPlacement === 'manual') && <>{number('mountSpacing', 'Opening spacing')}{number('mountZ', 'Opening height')}</>}
          {number('screwDiameter', 'Screw shank diameter')}{p.mount === 'keyhole' && number('headDiameter', 'Screw head diameter')}
          {follows && p.mountPlacement !== 'manual' && <p className="hint">Two openings are placed between tab slots along the upper rail, with small local pads where needed. If no clear position fits, the assembly checks say so.</p>}
        </>}
      </details>
    </>}
    {kind === 'channel' && <>
      <div className="group"><div className="group-head">Component envelope</div>
        {choose('shape', 'Cross-section', [['tube', 'Tube'], ['strip', 'Strip / Profile']], 'tube')}
        {p.shape !== 'strip' ? number('diameter', 'Component diameter', 16) : <>{number('width', 'Component width', 12)}{number('height', 'Component height', 5)}{number('cornerRadius', 'Component corner radius')}{number('roll', 'Cross-section rotation', 0, '°')}</>}
        {number('clearance', 'Clearance per side', 0.25, 'mm', 0.05)}
        <p className="hint">Total opening size adds twice the clearance. Kerf is applied separately. Angled crossings widen the cut across the whole sheet thickness.</p>
      </div>
      <div className="group"><div className="group-head">Straight route</div>
        <div className="assembly-scope" aria-label="LED channel handles">
          <button className={`btn${state.mode === 'stack' && state.gizmoMode === 'translate' ? ' is-active' : ''}`} disabled={!feature.enabled || !layout?.enabled} onClick={() => { state.setMode('stack'); state.setGizmoMode('translate'); }}>Move channel</button>
          <button className={`btn${state.mode === 'stack' && state.gizmoMode === 'rotate' ? ' is-active' : ''}`} disabled={!feature.enabled || !layout?.enabled} onClick={() => { state.setMode('stack'); state.setGizmoMode('rotate'); }}>Rotate channel</button>
        </div>
        <p className="hint">In Assembly, drag the channel’s arrows to move or rings to rotate in 3D. M / R switches tools. Rotation pivots around Route X/Y/Z; fitted ends adjust after release. Snap uses 5 mm / 15° steps. All follow applies to ribs only.</p>
        {number('px', 'Route X')}{number('py', 'Route Y')}{number('pz', 'Route Z')}{number('yaw', 'Direction in plan', 0, '°')}{number('elevation', 'Elevation', 0, '°')}
        {toggle('through', 'Fit through targeted parts', true)}
        {!p.through && number('length', 'Flat-ended length', 200)}
        {toggle('open', 'Edge-open notch')}{p.open === true && number('openAngle', 'Opening direction in part', 90, '°')}
        <p className="hint">Opening direction: 0° right, 90° up in Part view. An edge-open notch is a through-cut, not a blind pocket.</p>
      </div>
      <div className="group"><div className="group-head">Cut targets</div>
        {toggle('ribTarget', 'Ribs', true)}{toggle('supportTarget', 'Supports')}{toggle('backplateTarget', 'Backplate')}
        <label className="field"><span className="field-label">Only these IDs</span><input placeholder="All checked types" value={String(p.targetIds || '')} onChange={(e) => patch('targetIds', e.target.value)} /></label>
        <p className="hint">Optional feature IDs, separated by spaces: {members.filter((f) => ['assembly:rib', 'assembly:support', 'assembly:backplate'].includes(f.kind)).map((f) => f.id).join(', ')}.</p>
        {!pending && <p>{set?.assembly?.channels.find((c) => c.id === feature.id)?.status}</p>}
      </div>
    </>}
    {['rib', 'support', 'backplate'].includes(kind) && <details className="group"><summary>Material</summary>
      {toggle('ownMaterial', 'Use separate material')}
      {p.ownMaterial === true ? <><label className="field"><span className="field-label">Stock name</span><input value={String(p.materialName || '')} onChange={(e) => patch('materialName', e.target.value)} /></label>{number('thickness', 'Stock thickness', 3, 'mm', 0.1)}{number('kerf', 'Measured kerf', 0.15, 'mm', 0.01)}</> : <p className="hint">Uses {state.material.name}, {state.material.thickness} mm, kerf {state.material.kerf} mm. Edit the shared stock in Profiles.</p>}
      <p className="hint">Stock name, thickness and kerf determine which parts share a cutting sheet.</p>
    </details>}
    {notice && <p className="derived" role="status">{notice}</p>}
    <AssemblyStatus set={set} pending={pending} />
  </div>;
}
