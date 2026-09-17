#!/usr/bin/env node
/** Authored controls, real morph fields, durable keys and reachable drawing UI. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { alignCurvePoint, ellipseCurve, flattenCurve, moveCurveNode, splitCurve, curveNodeMode, copyCurveSketch, curveBounds, resizeCurveLoops, curveSketchError, curveHeight, straightenCurveSegment } from '../src/core/curves.ts';
import { distanceToRing, indexProfile, indexedDistance, easeMorph } from '../src/core/profile2d.ts';
import { profileVolume, runSliceJob } from '../src/core/pipeline.ts';
import { planLayers } from '../src/core/slice.ts';
import { parseProject, serializeProject } from '../src/core/project.ts';

const circle = ellipseCurve(7, -9, 40, 40), ring = flattenCurve(circle);
let worstCircle = 0;
for (let i = 0; i < 720; i++) {
  const a = i * Math.PI / 360;
  worstCircle = Math.max(worstCircle, distanceToRing(ring, 7 + 40 * Math.cos(a), -9 + 40 * Math.sin(a)));
}
assert.ok(worstCircle < .04, `measured circle deviation ${worstCircle} mm`);
assert.deepEqual(curveBounds([circle]), {minX:-33,maxX:47,minY:-49,maxY:31,width:80,height:80,cx:7,cy:-9});
const split = flattenCurve(splitCurve(circle, 0));
for (let i = 0; i < ring.length; i += 2) assert.ok(distanceToRing(split, ring[i], ring[i + 1]) < 1e-9, 'subdivision preserves the curve');
const moved = moveCurveNode(circle, 0, 'point', [55, 3]);
assert.deepEqual(moved[0].outgoing, circle[0].outgoing); assert.deepEqual(circle[0].point, [47,-9]);
const handled = moveCurveNode(circle, 0, 'outgoing', [57,11]);
assert.deepEqual(handled[0].incoming, [-10,-20]); assert.deepEqual(handled[0].outgoing, [10,20]);
const corner = curveNodeMode(circle, 0, false); assert.deepEqual(corner[0].incoming,[0,0]); assert.deepEqual(corner[0].outgoing,[0,0]);
const smooth = curveNodeMode(corner,0,true); assert.ok(Math.hypot(...smooth[0].outgoing)>0);
const reshaped = resizeCurveLoops([circle],120,40), resizedBox = curveBounds(reshaped);
assert.equal(resizedBox.width,120); assert.equal(resizedBox.height,40); assert.equal(resizedBox.cx,7); assert.equal(resizedBox.cy,-9);
const overshoot = [{point:[0,0],incoming:[0,0],outgoing:[80,0],smooth:false},{point:[10,0],incoming:[70,0],outgoing:[0,0],smooth:false},{point:[10,10],incoming:[0,0],outgoing:[0,0],smooth:false},{point:[0,10],incoming:[0,0],outgoing:[0,0],smooth:false}];
assert.ok(curveBounds([overshoot]).maxX>50, 'collinear control overshoot is not flattened to a short straight segment');
assert.throws(()=>flattenCurve(circle,0));assert.throws(()=>curveBounds([]));
console.log(`  ok    adaptive Bézier flattening, preserved subdivision, live handles, corners and reshaping; circle deviation ${worstCircle.toFixed(4)} mm`);

const lineAndArcs=straightenCurveSegment(circle,0), lineRing=flattenCurve(lineAndArcs);
assert.deepEqual(lineRing.slice(0,4),[...circle[0].point,...circle[1].point],'a straight segment has no bowed intermediate samples');
const arcStart=ring.findIndex((v,i)=>i%2===0&&v===circle[1].point[0]&&ring[i+1]===circle[1].point[1]);
assert.deepEqual(lineRing.slice(2),ring.slice(arcStart),'the adjoining arcs retain their exact flattened geometry');
assert.deepEqual(lineAndArcs[0].incoming,circle[0].incoming);assert.deepEqual(lineAndArcs[1].outgoing,circle[1].outgoing);
assert.notDeepEqual(circle[0].outgoing,[0,0],'the original drawing is immutable');
assert.deepEqual(moveCurveNode(lineAndArcs,0,'incoming',[50,-20])[0].outgoing,[0,0],'moving the retained curve handle cannot bend its straight neighbour');
const closedStraight=straightenCurveSegment(lineAndArcs,lineAndArcs.length-1);
assert.deepEqual(closedStraight.at(-1).outgoing,[0,0]);assert.deepEqual(closedStraight[0].incoming,[0,0]);
let polygon=circle;for(let i=0;i<polygon.length;i++)polygon=straightenCurveSegment(polygon,i);
assert.deepEqual(flattenCurve(polygon),circle.flatMap(n=>n.point),'a fully straight closed drawing keeps only its anchors');
for(const [from,to,want] of [[[3,7],[20,9],[20,7]],[[3,7],[-2,-30],[3,-30]],[[3,7],[3,7],[3,7]]])assert.deepEqual(alignCurvePoint(from,to),want);
console.log('  ok    exact straight edges, curved neighbours, straight closure, handle isolation and horizontal/vertical constraints');

const sketch = {base:[ellipseCurve(0,0,40,40)],keys:[],nextKey:1};
const feature = {id:'f1',kind:'profile',stage:'SHAPE',name:'Drawn profile',enabled:true,sketch,
  params:{height:84,round:0,curveMode:'repeat',easing:'smooth',op:'union',k:30,px:0,py:0,pz:0,rx:0,ry:0,rz:0}};
const job = {features:[feature],thickness:3,kerf:.15,spacerHeight:6,resolution:120,tolerance:.02,smoothing:0,minFeature:1,seed:1};
const run = (f=feature, patch={})=>runSliceJob({...job,features:[f],...patch},new Map());
const repeated = run(), volume = profileVolume(feature);
const planned = planLayers({min:volume.min,max:volume.max},job);
assert.deepEqual(repeated.set.slices.map(s=>s.z),planned.map(p=>p.z));
assert.equal(repeated.set.slices.length,10,'the fixture has real layers 1, 5 and 10');
for (const s of repeated.set.slices) assert.deepEqual(s.contours,repeated.set.slices[0].contours,'one drawing repeats on every sheet');
const zFor = layer=>repeated.set.slices[layer-1].z;
const morph = {...feature,params:{...feature.params,curveMode:'morph'},sketch:{...copyCurveSketch(sketch),nextKey:4,
  keys:[{id:'k1',z:zFor(1),loops:[ellipseCurve(0,0,40,40)]},{id:'k2',z:zFor(5),loops:[ellipseCurve(0,0,26,19)]},{id:'k3',z:zFor(10),loops:[ellipseCurve(0,0,35,30)]}]}};
const morphVolume=profileVolume(morph), morphed=run(morph);
assert.deepEqual(morphVolume.min.slice(2),volume.min.slice(2));assert.deepEqual(morphVolume.max.slice(2),volume.max.slice(2));
assert.deepEqual(morphed.set.slices.map(s=>s.z),repeated.set.slices.map(s=>s.z),'adding keys never shortens the source or reassigns layers');
for (const key of morph.sketch.keys) {
  const own=profileVolume({...feature,sketch:{...sketch,base:key.loops}});
  for(let x=-45;x<=45;x+=3)for(let y=-40;y<=40;y+=5)assert.ok(Math.abs(morphVolume.sample(x,y,key.z)-own.sample(x,y,key.z))<1e-9,'key planes reproduce the authored profile');
}
const a=morph.sketch.keys[0],b=morph.sketch.keys[1],z=a.z+(b.z-a.z)/4;
const distance=k=>{const index=indexProfile({rings:k.loops.map(loop=>flattenCurve(loop)),fill:'holes'},1,.06,30);return indexedDistance(index,41,0);};
const expected=(1-easeMorph(.25,'smooth'))*distance(a)+easeMorph(.25,'smooth')*distance(b);
assert.ok(Math.abs(morphVolume.sample(41,0,z)-expected)<1e-9);
assert.ok(Math.abs(profileVolume({...morph,params:{...morph.params,easing:'linear'}}).sample(41,0,z)-expected)>.1,'easing changes the actual field');
assert.equal(curveHeight(morph.sketch,1),2*Math.max(...morph.sketch.keys.map(k=>Math.abs(k.z)))+.5,'height changes cannot clip a saved key');
assert.deepEqual(run({...morph,params:{...morph.params,curveMode:'repeat'}}).set,repeated.set,'repeat preserves saved morph keys without applying them');
const holeProfile={...feature,sketch:{...sketch,base:[...sketch.base,ellipseCurve(0,0,25,25)]}};
assert.ok(run(holeProfile).set.slices.every(s=>s.contours.some(c=>c.isHole)),'inner authored loops survive as holes');
const support={id:'f2',kind:'verticalSupports',stage:'RIG',name:'Supports',enabled:true,params:{fit:'auto',count:3,angle:0,clearance:.2}};
const supported=runSliceJob({...job,features:[holeProfile,support]},new Map());
assert.deepEqual(supported.set.verticalSupports.issues.filter(i=>i.severity==='error'),[]);
assert.equal(supported.set.verticalSupports.parts.length,support.params.count);
assert.equal(supported.set.verticalSupports.contacts.length,supported.set.slices.length*support.params.count,'authored rings accept real vertical support joints');
const noKerf=run(feature,{kerf:0}), edge=s=>Math.max(...s.contours.flatMap(c=>c.points.filter((_,i)=>i%2===0)));
assert.ok(Math.abs(edge(repeated.set.slices[2])-edge(noKerf.set.slices[2])-job.kerf/2)<.025,'kerf comes from the stock profile and is applied once');
const invalid=copyCurveSketch(sketch);invalid.base[0][0].point[0]=NaN;assert.match(curveSketchError(invalid),/coordinates/);
assert.throws(()=>profileVolume({...feature,sketch:invalid}),/coordinates/);
console.log('  ok    repeated layers and exact keys at 1/5/10, real distance morph/easing, full source height, inner loops and one kerf shift');

const mixedDrawing={...feature,sketch:{...copyCurveSketch(sketch),base:[lineAndArcs]}};
const mixedVolume=profileVolume(mixedDrawing), expectedMixed=indexProfile({rings:[lineRing],fill:'holes'},1,.06,30);
for(let x=-30;x<=45;x+=5)for(let y=-45;y<=25;y+=7)assert.ok(Math.abs(mixedVolume.sample(x,y,0)-indexedDistance(expectedMixed,x,y))<1e-9);
const polygonDrawing={...feature,sketch:{...copyCurveSketch(sketch),base:[polygon]}};
assert.ok(run(polygonDrawing).set.slices.every(s=>s.contours.length===1),'straight drawings produce closed cutting contours');
const lineMorph={...morph,sketch:copyCurveSketch(morph.sketch)};lineMorph.sketch.keys[1].loops=[lineAndArcs];
assert.ok(Math.abs(profileVolume(lineMorph).sample(30,10,lineMorph.sketch.keys[1].z)-mixedVolume.sample(30,10,0))<1e-9,'a mixed line/curve key reproduces its authored shape');
const lineSave=parseProject(serializeProject({features:[mixedDrawing],machineId:'laser-730',materialId:'plexi-3'},'test','2026-09-17'));
assert.equal(lineSave.ok,true);assert.deepEqual(lineSave.data.features[0].sketch,mixedDrawing.sketch);
console.log('  ok    line/curve profiles reach the real field, cut layers, morph keys and project persistence');

const server=await createServer({configFile:false,server:{middlewareMode:true,watch:null,hmr:false,ws:false},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom'});
try {
  const {useKerros}=await server.ssrLoadModule('/src/core/store.ts');
  const {curveLayerTarget,curveKeyLabel}=await server.ssrLoadModule('/src/ui/curveSession.ts');
  const {CurveInspector}=await server.ssrLoadModule('/src/ui/CurveInspector.tsx');
  const {CurveEditor}=await server.ssrLoadModule('/src/ui/CurveEditor.tsx');
  const {FeatureTree}=await server.ssrLoadModule('/src/ui/FeatureTree.tsx');
  const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
  const state=()=>useKerros.getState();
  state().addCurveProfile();const id=state().selectedId;
  assert.equal(state().mode,'slice');assert.equal(state().curveEditorId,id);assert.equal(state().panel,'inspector');
  const old=state().features.find(f=>f.id===id).sketch;
  assert.equal(state().setCurveSketch(id,morph.sketch,old),true);
  assert.equal(state().setCurveSketch(id,sketch,old),false,'a stale drag cannot overwrite a newer edit');
  const current=state().features.find(f=>f.id===id);state().setParam(id,'height',84);state().setParam(id,'curveMode','morph');
  assert.notEqual(current.sketch,morph.sketch); assert.notEqual(current.sketch.keys[0].loops,morph.sketch.keys[0].loops);
  const data=state().projectData(), saved=parseProject(serializeProject(data,'test','2026-09-15'));
  assert.equal(saved.ok,true);assert.deepEqual(saved.warnings,[]);assert.deepEqual(saved.data.features[0].sketch,morph.sketch);
  data.features[0].sketch.base[0][0].point[0]=999;assert.notEqual(state().features[0].sketch.base[0][0].point[0],999,'save data does not alias the live drawing');
  const before=runSliceJob({...job,features:state().features},new Map()).set;
  state().applyProject(saved.data,saved.nextFeatureNumber);assert.equal(state().curveEditorId,null);assert.equal(state().curveKeyId,null);
  assert.deepEqual(runSliceJob({...job,features:state().features},new Map()).set,before,'project reopen needs no external SVG and preserves all cuts');
  assert.equal(state().setCurveSketch(id,sketch,current.sketch),false,'an old-project edit cannot claim a reused feature ID');
  const broken=structuredClone(saved.data);broken.features[0].sketch.keys[1].loops[0][0].incoming=[null,0];
  const rejected=parseProject(serializeProject(broken,'test','2026-09-15'));assert.ok(rejected.warnings.some(w=>/invalid curve drawing/.test(w)));
  assert.throws(()=>runSliceJob({...job,features:rejected.data.features},new Map()),/closed loops/,'a broken hole or key is never silently discarded');
  const relocated={...morph,params:{...morph.params,pz:12,rz:27}}, shifted=run(relocated);
  assert.ok(Math.abs(curveLayerTarget(relocated,[relocated],shifted.set,5).z-zFor(5))<1e-9);
  assert.match(curveKeyLabel(relocated,[relocated],shifted.set,zFor(5)),/^Layer 5/);
  assert.equal(curveLayerTarget({...relocated,params:{...relocated.params,rx:20}},[relocated],shifted.set,5).z,null,'oblique source sheets cannot pretend to be horizontal layer keys');
  const graded=run(morph,{spacerHeightTop:12,spacerHeightMid:9,spacerThickness:1});
  assert.equal(curveLayerTarget(morph,[morph],graded.set,3).z,graded.set.slices[2].z,'key placement reads actual graded sheet heights');
  const f=state().features[0], unchanged=state().features;state().editCurveProfile(id,'k2');
  assert.equal(state().features,unchanged,'selecting a key is not a geometry edit');
  state().closeCurveEditor();state().editCurveProfile(id);assert.equal(state().curveKeyId,'k1','reopening a morph edits an active key, not its unused base');
  const inspector=renderToStaticMarkup(createElement(CurveInspector,{feature:f,slices:morphed.set,fresh:true}));
  for(const text of ['Repeat one profile','Morph between keys','Copy drawing to layer','Layer 5','Transition'])assert.ok(inspector.includes(text),text);
  const stale=renderToStaticMarkup(createElement(CurveInspector,{feature:f,slices:morphed.set,fresh:false}));assert.ok(stale.includes('Wait for the current layers'));
  const editor=renderToStaticMarkup(createElement(CurveEditor,{feature:f,slices:morphed.set}));
  for(const text of ['Straight line','Bézier pen','Ellipse / circle','Curve drawing canvas','Loop 1 point 1','Undo','Insert point after'])assert.ok(editor.includes(text),text);
  // Server rendering reads the store's initial snapshot (an empty project).
  // The creation action must therefore be reachable even before any selection.
  assert.ok(renderToStaticMarkup(createElement(FeatureTree)).includes('>Curve profile</button>'));
  const {buildParts,sheetToDxf,assemblyDocument}=await server.ssrLoadModule('/src/core/job.ts');
  const {nestByMaterial}=await server.ssrLoadModule('/src/core/nest.ts');
  const {writeDxfR12}=await server.ssrLoadModule('/src/core/dxf.ts');
  const {writePdf}=await server.ssrLoadModule('/src/core/pdf.ts');
  const parts=buildParts(morphed.set,[]), nested=nestByMaterial(parts,{sheetWidth:720,sheetHeight:400,gap:4,labelHeight:3,trueShape:false,cell:2});
  assert.equal(parts.length,morphed.set.slices.length);assert.equal(nested.unplaced.length,0);
  for(const sheet of nested.sheets)assert.ok(!/NaN|Infinity/.test(writeDxfR12(sheetToDxf(sheet))));
  assert.ok(writePdf(assemblyDocument({set:morphed.set,sheets:nested.sheets,spacers:[],machineName:'Test',materialName:'Test',thickness:job.thickness,kerf:job.kerf,spacerHeight:6,spacerAchieved:6,ringThickness:3,version:'test',projectName:'Drawn morph'})).startsWith('%PDF'));
  const oldSelf=globalThis.self,replies=[];globalThis.self={postMessage(reply){replies.push(structuredClone(reply));}};
  try {await server.ssrLoadModule('/src/ui/kerros.worker.ts');globalThis.self.onmessage({data:{kind:'slice',token:1,job:{...job,features:[morph]}}});assert.deepEqual(replies.at(-1).output.set,morphed.set);} finally {globalThis.self=oldSelf;}
  console.log('  ok    guarded store edits, deep project roundtrip, malformed-data refusal, actual layer mapping, reachable tools, worker, nesting, DXF and PDF');
} finally {await server.close();}
console.log('OK    curve drawing and layer-key morphs');
