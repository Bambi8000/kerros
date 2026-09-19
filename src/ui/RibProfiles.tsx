import { useState } from 'react';
import type { Feature } from '../core/types';
import type { SliceSet } from '../core/slice';
import { useKerros } from '../core/store';
import { profileRibs, selectRibRange } from '../core/ribProfiles';
import { copyCurveLoops, copyCurveSketch, curveBounds, resizeCurveLoops } from '../core/curves';
import { NumberField } from './NumberField';

const sequence = (rib: Feature) => Number(rib.params.ordinal) + 1;
const label = (rib: Feature) => `${sequence(rib)} · ${rib.name}${rib.enabled ? '' : ' (disabled)'}`;

function RangeButtons({ ribs, onChange }: { ribs: Feature[]; onChange: (text: string) => void }) {
  return <div className="assembly-scope">{(['All', 'Odd', 'Even'] as const).map(scope => <button className="btn" key={scope} onClick={() =>
    onChange(ribs.filter(r => scope === 'All' || sequence(r) % 2 === (scope === 'Odd' ? 1 : 0)).map(sequence).join(', '))}>{scope}</button>)}</div>;
}

export function RibProfileTools({ feature, layout, set, pending, sources }: {
  feature: Feature; layout: Feature; set: SliceSet | null; pending: boolean; sources?: Feature[] | null;
}) {
  const state = useKerros(), ribs = profileRibs(state.features, layout.id);
  const selected = feature.kind === 'assembly:rib' ? feature : ribs[0];
  const [sourceId, setSourceId] = useState(selected?.id ?? '');
  const [range, setRange] = useState(selected ? String(sequence(selected)) : '');
  const [notice, setNotice] = useState('');
  const groups = state.features.filter(f => f.kind === 'assembly:profile' && f.params.groupId === layout.id);
  const create = (ids?: string[]) => {
    try {
      if (!set || !sources || pending) throw new Error('Wait for the current rib profiles to finish rebuilding.');
      if (!state.createRibProfile(ids ? feature.id : sourceId, ids ?? selectRibRange(ribs, range), set, sources))
        throw new Error('The selected rib has no current profile to copy. Resolve its source checks first.');
      setNotice('');
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };
  return <div className="group"><div className="group-head">Rib profiles</div>
    {feature.kind === 'assembly:rib' && <>
      <label className="field"><span className="field-label">Profile source</span><select value={String(feature.params.profileId || '')} onChange={e => state.setParam(feature.id, 'profileId', e.target.value)}>
        <option value="">Follow source</option>
        {feature.params.profileId && !groups.some(g => g.id === feature.params.profileId) && <option value={String(feature.params.profileId)}>Missing group</option>}
        {groups.map(g => <option key={g.id} value={g.id}>{g.name}{g.enabled ? '' : ' (disabled)'}</option>)}
      </select></label>
      {!!feature.params.profileId && <button className="btn" onClick={() => state.editCurveProfile(String(feature.params.profileId))}>Edit shared profile</button>}
      <button className="btn" disabled={pending || !feature.enabled} onClick={() => create([feature.id])}>Edit this rib independently</button>
    </>}
    <label className="field"><span className="field-label">Rib sequences</span><input aria-label="Rib sequences" value={range} onChange={e => setRange(e.target.value)} placeholder="1-6, 9" /></label>
    <RangeButtons ribs={ribs} onChange={setRange} />
    <label className="field"><span className="field-label">Copy profile from</span><select value={sourceId} onChange={e => setSourceId(e.target.value)}>{ribs.map(r => <option key={r.id} value={r.id}>{label(r)}</option>)}</select></label>
    <button className="btn" disabled={pending || !ribs.length} onClick={() => create()}>Create shared profile group</button>
    <p className="hint">Copies the unjointed shape once, with up to 0.05 mm simplification. Selected ribs share this drawing; placement and stock stay individual. Joints rebuild after every edit. Other ribs keep their current profiles.</p>
    {groups.map(g => <button className="btn" key={g.id} onClick={() => state.selectFeature(g.id)}>{g.name} · {profileRibs(state.features, layout.id, g.id).length} ribs</button>)}
    {notice && <p className="warn" role="status">{notice}</p>}
  </div>;
}

export function RibProfileInspector({ feature }: { feature: Feature }) {
  const state = useKerros(), sketch = feature.sketch;
  const all = profileRibs(state.features, String(feature.params.groupId)), members = profileRibs(state.features, String(feature.params.groupId), feature.id);
  const [range, setRange] = useState(members.map(sequence).join(', ')), [target, setTarget] = useState(members[0]?.id ?? '');
  const [notice, setNotice] = useState('');
  if (!sketch) return <p className="warn">This group has no drawing. Choose Follow source on its ribs, then create a new group.</p>;
  const key = feature.params.curveMode === 'morph'
    ? sketch.keys.find(k => feature.id === state.curveEditorId && k.id === state.curveKeyId) ?? sketch.keys[0] : undefined;
  const loops = key?.loops ?? sketch.base;
  let bounds: ReturnType<typeof curveBounds> | null = null;
  try { bounds = curveBounds(loops); } catch { /* The editor can replace an invalid loaded drawing. */ }
  const update = (next: typeof sketch) => { if (!state.setCurveSketch(feature.id, next, sketch)) setNotice('The drawing could not be applied. Check its closed loops and distinct keys.'); };
  const addKey = () => {
    const rib = members.find(r => r.id === target) ?? members[0];
    if (!rib) return;
    const z = sequence(rib), existing = sketch.keys.find(k => k.z === z);
    if (existing) { state.editCurveProfile(feature.id, existing.id); return; }
    if (sketch.keys.length >= 32) { setNotice('A group can have at most 32 morph keys.'); return; }
    const next = copyCurveSketch(sketch), id = `k${next.nextKey++}`;
    next.keys.push({ id, z, loops: copyCurveLoops(loops) });
    if (state.setCurveSketch(feature.id, next, sketch)) { state.setParam(feature.id, 'curveMode', 'morph'); state.editCurveProfile(feature.id, id); setNotice(''); }
  };
  const resize = (height: number) => {
    if (!bounds || height <= 0) return;
    const next = copyCurveSketch(sketch), changed = resizeCurveLoops(loops, bounds.width, height);
    // Keep the bottom edge fixed so making a taller rib does not move its foot.
    const shift = curveBounds(changed).minY - bounds.minY;
    for (const loop of changed) for (const node of loop) node.point[1] -= shift;
    if (key) next.keys.find(k => k.id === key.id)!.loops = changed; else next.base = changed;
    update(next);
  };
  return <>
    <div className="group"><div className="group-head">Shared rib drawing</div>
      <p className="derived">Members: {members.length ? members.map(label).join('; ') : 'None. Assign ribs below.'}</p>
      <label className="field"><span className="field-label">Rib sequences</span><input aria-label="Group rib sequences" value={range} onChange={e => setRange(e.target.value)} /></label>
      <RangeButtons ribs={all} onChange={setRange} />
      <button className="btn" onClick={() => { try { state.assignRibProfile(feature.id, selectRibRange(all, range)); setNotice('Membership updated. Ribs removed from this group now follow the source.'); } catch (e) { setNotice(String(e instanceof Error ? e.message : e)); } }}>Apply membership</button>
      <label className="field"><span className="field-label">Profile mode</span><select value={String(feature.params.curveMode || 'repeat')} onChange={e => { state.setParam(feature.id, 'curveMode', e.target.value); state.editCurveProfile(feature.id); }}>
        <option value="repeat">Repeat shared profile</option><option value="morph">Morph across ribs</option>
      </select></label>
      <button className="btn" onClick={() => state.editCurveProfile(feature.id)}>Edit drawing in Slice</button>
      {bounds && <NumberField label={key ? `Key ${key.z} height` : 'Shared profile height'} value={bounds.height} unit="mm" min={0.1} onChange={resize} />}
      <p className="hint">Height keeps the drawing’s bottom fixed. Edit points, lines or curves in Slice. Group drawings are saved independently from the source model; choose Follow source on a rib to restore that link.</p>
      <button className="btn" onClick={() => state.setMode('stack')}>Preview ribs in Assembly</button>
    </div>
    <div className="group"><div className="group-head">Morph keys · rib sequence</div>
      <label className="field"><span className="field-label">Key at rib</span><select value={members.some(r => r.id === target) ? target : members[0]?.id ?? ''} onChange={e => setTarget(e.target.value)}>{members.map(r => <option key={r.id} value={r.id}>{label(r)}</option>)}</select></label>
      <button className="btn" disabled={!members.length} onClick={addKey}>Copy drawing to rib key</button>
      <label className="field"><span className="field-label">Transition</span><select value={String(feature.params.easing || 'smooth')} onChange={e => state.setParam(feature.id, 'easing', e.target.value)}><option value="smooth">Smooth</option><option value="linear">Linear</option></select></label>
      {sketch.keys.slice().sort((a, b) => a.z - b.z).map(k => <div className="assembly-scope" key={k.id}>
        <button className={`btn${key?.id === k.id ? ' is-active' : ''}`} onClick={() => { if (feature.params.curveMode !== 'morph') state.setParam(feature.id, 'curveMode', 'morph'); state.editCurveProfile(feature.id, k.id); }}>Rib {k.z}{members.some(r => sequence(r) === k.z) ? '' : ' · saved position'}</button>
        <button className="btn" aria-label={`Remove rib key ${k.z}`} onClick={() => { const next = copyCurveSketch(sketch); next.keys = next.keys.filter(v => v.id !== k.id); update(next); if (key?.id === k.id) state.editCurveProfile(feature.id); }}>Remove</button>
      </div>)}
      <p className="hint">Use keys at ribs 1 and 6, or add intermediate keys. Only this group morphs. End drawings hold beyond the keys; one key repeats. Sequence positions survive hiding, reordering or removing ribs. Repeat retains the saved keys.</p>
    </div>
    {notice && <p className="derived" role="status">{notice}</p>}
  </>;
}
