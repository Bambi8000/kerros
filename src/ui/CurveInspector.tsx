import { useMemo, useState } from 'react';
import { useKerros } from '../core/store';
import type { Feature } from '../core/types';
import type { SliceSet } from '../core/slice';
import { copyCurveLoops, copyCurveSketch, curveHeight, curveSketchError, flattenCurve } from '../core/curves';
import { radialProfile } from '../core/radialProfile';
import { NumberField } from './NumberField';
import { curveKeyLabel, curveLayerTarget } from './curveSession';

export function CurveInspector({ feature, slices, fresh }: { feature: Feature; slices: SliceSet | null; fresh: boolean }) {
  const features = useKerros(s => s.features), editorId = useKerros(s => s.curveEditorId), selectedKey = useKerros(s => s.curveKeyId);
  const layer = useKerros(s => s.currentLayer), setLayer = useKerros(s => s.setCurrentLayer);
  const mode = useKerros(s => s.mode), edit = useKerros(s => s.editCurveProfile), close = useKerros(s => s.closeCurveEditor);
  const setParam = useKerros(s => s.setParam), rename = useKerros(s => s.renameFeature), update = useKerros(s => s.setCurveSketch);
  const addAssembly = useKerros(s => s.addAssembly);
  const [message, setMessage] = useState('');
  const sketch = feature.sketch!, morph = feature.params.curveMode === 'morph', radial = feature.params.profileMode === 'radial';
  const axisX = Number(feature.params.axisX ?? 0);
  const radialError = useMemo(() => {
    if (!radial) return '';
    try { radialProfile(sketch.base.map(loop => flattenCurve(loop)), axisX); return ''; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }, [radial, sketch, axisX]);
  const target = curveLayerTarget(feature, features, slices, layer);
  const open = editorId === feature.id && mode === 'slice';
  const error = curveSketchError(sketch);
  const changeMode = (value: string) => {
    setParam(feature.id, 'curveMode', value);
    if (open) edit(feature.id, value === 'morph' ? sketch.keys[0]?.id ?? null : null);
    setMessage('');
  };
  const addKey = () => {
    if (!fresh || target.z === null) return;
    const existing = sketch.keys.find(key => Math.abs(key.z - target.z!) < 1e-6);
    if (existing) { if (!morph) setParam(feature.id, 'curveMode', 'morph'); edit(feature.id, existing.id); setMessage('A key already exists here. Its drawing is selected.'); return; }
    const copy = copyCurveSketch(sketch), id = `k${copy.nextKey++}`;
    const source = sketch.keys.find(key => key.id === selectedKey);
    copy.keys.push({ id, z: target.z, loops: copyCurveLoops(source?.loops ?? sketch.base) });
    if (!update(feature.id, copy, sketch)) { setMessage('The drawing changed. Select the layer and try again.'); return; }
    if (!morph) setParam(feature.id, 'curveMode', 'morph'); edit(feature.id, id); setMessage('');
  };
  return <>
    <div className="group">
      <div className="group-head">Curve profile</div>
      <label className="field"><span className="field-label">Name</span><span className="field-input"><input aria-label="Profile name" value={feature.name} onChange={e => rename(feature.id, e.target.value)} /></span></label>
      <div className="derived">Closed Bézier curves, with editable points and handles. Drawings are saved inside the project.</div>
      {error && <div className="warn">{error} Open the editor and replace the outline to recover it.</div>}
      <button className="btn btn-wide" onClick={() => open ? close() : edit(feature.id, morph ? sketch.keys[0]?.id ?? null : null)}>{open ? 'View cuts' : 'Edit curves in Slice'}</button>
      <label className="field"><span className="field-label">Use drawing as</span><span className="field-input"><select value={radial ? 'radial' : 'layers'} onChange={e => {
        setParam(feature.id, 'profileMode', e.target.value); if (open) edit(feature.id); setMessage('');
      }}><option value="layers">Layer profiles</option><option value="radial">Radial side profile</option></select></span></label>
      {radial ? <>
        <div className="derived">The outline to the right of the rotation axis defines the lamp's side. Horizontal distance from the axis is radius; drawing Y is height. The same outer contour repeats around Z.</div>
        <NumberField label="Axis X" unit="mm" value={axisX} min={-100000} max={100000} onChange={v => setParam(feature.id, 'axisX', v)} />
        <div className="derived">Edit the drawing height in Slice. Extrusion height, distribution and {sketch.keys.length} saved morph keys are retained but inactive here.</div>
        {radialError && <div className="warn">{radialError}</div>}
        <button className="btn btn-wide" disabled={!!error || !!radialError} onClick={() => { close(); addAssembly('radial'); }}>Preview radial ribs</button>
        <div className="derived">Rib depth, clear centre and ring supports remain in Assembly settings. Adjust support heights and diameters to meet the new profile; other enabled source shapes still contribute.</div>
      </> : <>
      <label className="field"><span className="field-label">Distribution</span><span className="field-input"><select value={morph ? 'morph' : 'repeat'} onChange={e => changeMode(e.target.value)}>
        <option value="repeat">Repeat one profile</option><option value="morph">Morph between keys</option>
      </select></span></label>
      <div className="derived">{morph ? 'Copy a drawing to a layer, then reshape that key. Intermediate layers morph automatically; the end drawings continue to the ends of the profile.' : 'Edits to the base drawing repeat through the full height. Saved morph keys are retained when switching modes.'}</div>
      <NumberField label="Profile height" unit="mm" value={curveHeight(sketch, Number(feature.params.height))} min={Math.max(0.5, ...sketch.keys.map(k => 2 * Math.abs(k.z) + 0.5))} onChange={v => setParam(feature.id, 'height', curveHeight(sketch, v))} />
      <div className="derived">Layer count follows the material and spacer settings. Height includes every saved key.</div>
      </>}
    </div>
    {!radial && <div className="group">
      <div className="group-head">Morph keys</div>
      <NumberField label="New key at layer" value={layer} min={1} max={slices?.slices.length ?? 1} onChange={v => { setLayer(v); setMessage(''); }} />
      <button className="btn btn-wide" disabled={!fresh || target.z === null || sketch.keys.length >= 32 || !!error} onClick={addKey}>Copy drawing to layer {layer}</button>
      <div className="derived">{sketch.keys.length >= 32 ? 'This drawing has 32 keys. Remove a key before adding another.' : !fresh ? 'Wait for the current layers before choosing a key.' : target.reason || `Copies ${selectedKey ? 'the selected key' : 'the base drawing'}. Keys stay at their saved heights when the layer plan changes.`}</div>
      {message && <div className="derived" role="status">{message}</div>}
      {sketch.keys.map(key => <div className="curve-key-row" key={key.id}>
        <button className={`btn${open && selectedKey === key.id ? ' is-active' : ''}`} onClick={() => { if (!morph) setParam(feature.id, 'curveMode', 'morph'); edit(feature.id, key.id); setMessage(''); }}>{curveKeyLabel(feature, features, fresh ? slices : null, key.z)}</button>
        <button className="btn" aria-label={`Remove key ${key.id}`} title="Remove this key" onClick={() => {
          const copy = copyCurveSketch(sketch); copy.keys = copy.keys.filter(k => k.id !== key.id);
          if (update(feature.id, copy, sketch)) { if (open) edit(feature.id, copy.keys[0]?.id ?? null); setMessage(''); }
        }}>×</button>
      </div>)}
      {!sketch.keys.length && <div className="derived">No keys yet. Start at layer 1, then copy to layers such as 5 and 10.</div>}
      <label className="field"><span className="field-label">Transition</span><span className="field-input"><select value={feature.params.easing === 'linear' ? 'linear' : 'smooth'} onChange={e => setParam(feature.id, 'easing', e.target.value)}>
        <option value="smooth">Smooth</option><option value="linear">Linear</option>
      </select></span></label>
    </div>}
  </>;
}
