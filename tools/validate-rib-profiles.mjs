#!/usr/bin/env node
/** Actual shared/morphed rib cuts, stable membership and per-contact support choices. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { runSliceJob, profileVolume, ribProfileDrawing } from '../src/core/pipeline.ts';
import { assemblyFeatures } from '../src/core/assemblyFeatures.ts';
import { profileRibs, selectRibRange, sketchFromRib } from '../src/core/ribProfiles.ts';
import { supportJointStyle } from '../src/core/assembly.ts';
import { curveBounds, copyCurveSketch, resizeCurveLoops, ellipseCurve } from '../src/core/curves.ts';
import { simplifyRing } from '../src/core/slice.ts';
import { parseProject, serializeProject } from '../src/core/project.ts';

const nodes=points=>points.map(point=>({point,incoming:[0,0],outgoing:[0,0],smooth:false}));
const body={id:'f1',kind:'profile',stage:'SHAPE',name:'Body',enabled:true,params:{profileMode:'radial',axisX:0,op:'union',k:0},
  sketch:{base:[nodes([[0,-100],[60,-100],[60,100],[0,100]])],keys:[],nextKey:1}};
const volume=profileVolume(body), created=assemblyFeatures('radial',2,{min:volume.min,max:volume.max});
const original=[body,...created.features];
const options={thickness:3,kerf:.15,materialName:'Test',spacerHeight:6,resolution:120,tolerance:.025,smoothing:0,minFeature:1,seed:1};
const run=(features,patch={})=>runSliceJob({...options,...patch,features},new Map()).set;
const errors=set=>set.assembly.issues.filter(i=>i.severity==='error');
const part=(set,id)=>set.slices.find(s=>s.part.id===id);
const ribs=profileRibs(original,created.id), supports=original.filter(f=>f.kind==='assembly:support');
assert.deepEqual(selectRibRange(ribs,'1-6, 9'),[...ribs.slice(0,6),ribs[8]].map(r=>r.id));
assert.throws(()=>selectRibRange(ribs,'6-1'));assert.throws(()=>selectRibRange(ribs,'1-90'));assert.throws(()=>selectRibRange(ribs,'0'));
assert.throws(()=>selectRibRange(ribs,'99999999999999999999'));
const plain=run(original);assert.deepEqual(errors(plain),[]);
const source=part(plain,ribs[0].id),sketch=sketchFromRib(source.ribProfileContours,simplifyRing);
assert.notDeepEqual(source.ribProfileContours,source.nominalContours,'profile snapshots exclude generated notches');
const group={id:`f${created.next}`,kind:'assembly:profile',stage:'SLICE',name:'Tall ribs',enabled:true,params:{groupId:created.id,curveMode:'repeat',easing:'linear'},sketch:copyCurveSketch(sketch)};
const selected=ribs.slice(0,6).map(r=>r.id);
const grouped=[...structuredClone(original),group];
for(const r of grouped.filter(f=>selected.includes(f.id)))r.params.profileId=group.id;
const box=curveBounds(group.sketch.base),height=box.height+35;
group.sketch.base=resizeCurveLoops(group.sketch.base,box.width,height);
for(const loop of group.sketch.base)for(const node of loop)node.point[1]+=17.5;
const repeated=run(grouped);assert.deepEqual(errors(repeated),[]);
for(const r of ribs){
  const got=part(repeated,r.id),before=part(plain,r.id);
  if(selected.includes(r.id)){
    const b=curveBounds(sketchFromRib(got.ribProfileContours,simplifyRing).base);
    assert.ok(Math.abs(b.height-height)<.1);assert.ok(Math.abs(b.minY-box.minY)<.05,'height preserves the foot');
    assert.deepEqual(got.part,before.part,'profile edits preserve pose and stock');
  }else assert.deepEqual(got,before,'other ribs are unchanged');
}
const morph=structuredClone(grouped),mg=morph.at(-1);
mg.params.curveMode='morph';mg.sketch.keys=[{id:'k1',z:1,loops:sketch.base},{id:'k2',z:6,loops:mg.sketch.base}];mg.sketch.nextKey=3;
const morphed=run(morph);assert.deepEqual(errors(morphed),[]);
const heights=ribs.slice(0,6).map(r=>curveBounds(sketchFromRib(part(morphed,r.id).ribProfileContours,simplifyRing).base).height);
assert.ok(Math.abs(heights[0]-box.height)<.1);assert.ok(Math.abs(heights[5]-height)<.1);
for(let i=1;i<6;i++)assert.ok(heights[i]>heights[i-1]+1,'intermediate ribs change progressively');
const sampler=ribProfileDrawing(mg),a=ribProfileDrawing({...group,sketch:{...sketch,base:mg.sketch.keys[0].loops}}),b=ribProfileDrawing(group);
const x=(box.minX+box.maxX)/2,y=box.maxY+10;
assert.ok(Math.abs(sampler.sample(x,y,3)-(a.sample(x,y,1)*.6+b.sample(x,y,6)*.4))<1e-8,'linear distance interpolation uses rib sequence');
assert.notEqual(ribProfileDrawing({...mg,params:{...mg.params,easing:'smooth'}}).sample(x,y,3),sampler.sample(x,y,3));
const reordered=[...morph].reverse();assert.deepEqual(part(run(reordered),ribs[2].id).contours,part(morphed,ribs[2].id).contours);
const broken=structuredClone(morph);broken.at(-1).sketch.base=[];
assert.ok(errors(run(broken)).some(i=>i.ids.includes(group.id)&&/Rib profile/.test(i.message)));
const missing=morph.filter(f=>f.id!==group.id);assert.ok(errors(run(missing)).some(i=>/group is missing/.test(i.message)));
console.log('  ok    shared height, unchanged other ribs, unjointed snapshots, stable sequence, exact keys, intermediate morphs and explicit invalid-group refusal');

const holeX=box.maxX-5;
assert.ok(ribProfileDrawing(group).sample(holeX,0,1)<-3,'the test hole has a full minimum bridge inside the actual rib band');
const holed=structuredClone(grouped);holed.at(-1).sketch.base.push(ellipseCurve(holeX,0,2,2));
assert.equal(part(run(holed),ribs[0].id).nominalContours.filter(c=>c.isHole).length,1,'authored inner loops survive generated joints and manufacturing redistance');
const linearBody={id:'f1',kind:'roundBox',stage:'SHAPE',name:'Linear body',enabled:true,params:{op:'union',sx:140,sy:120,sz:200,r:0}};
const linear=assemblyFeatures('linear',2,{min:[-70,-60,-100],max:[70,60,100]}),linearFeatures=[linearBody,...linear.features],linearRibs=profileRibs(linearFeatures,linear.id);
const linearSet=run(linearFeatures);assert.deepEqual(errors(linearSet),[]);
const linearSketch=sketchFromRib(part(linearSet,linearRibs[0].id).ribProfileContours,simplifyRing),linearBounds=curveBounds(linearSketch.base);
linearSketch.base=resizeCurveLoops(linearSketch.base,linearBounds.width,linearBounds.height+24);
const linearGroup={...structuredClone(group),id:`f${linear.next}`,params:{groupId:linear.id,curveMode:'repeat'},sketch:linearSketch};
for(const r of linearFeatures.filter(f=>linearRibs.slice(0,2).some(r=>r.id===f.id)))r.params.profileId=linearGroup.id;
const linearEdited=run([...linearFeatures,linearGroup]);assert.deepEqual(errors(linearEdited),[]);
assert.notDeepEqual(part(linearEdited,linearRibs[0].id).contours,part(linearSet,linearRibs[0].id).contours);
assert.notDeepEqual(linearEdited.slices.find(s=>s.part.kind==='backplate').contours,linearSet.slices.find(s=>s.part.kind==='backplate').contours,'the wall frame and joints follow independently taller linear ribs');
console.log('  ok    authored holes and linear groups rebuild the actual wall frame and joints');

const mixed=structuredClone(original),top=mixed.find(f=>f.id===supports[1].id);
Object.assign(top.params,{jointStyle:'sockets',socketSide:'top',socketWidth:8,innerDiameter:0,outerDiameter:180,pz:80,[`joint:${ribs[0].id}`]:'slots'});
assert.equal(supportJointStyle(top,ribs[0].id),'slots');assert.equal(supportJointStyle(top,ribs[1].id),'sockets');
const mixedSet=run(mixed);
assert.ok(mixedSet.assembly.joints.find(j=>j.parts.includes(top.id)&&j.parts.includes(ribs[0].id)).instruction.includes('mixed-joint'));
assert.equal(part(mixedSet,top.id).nominalContours.filter(c=>c.isHole).length,ribs.length-1,'one open contact, the other contacts remain enclosed');
assert.ok(errors(mixedSet).some(i=>/end plate cannot slide/.test(i.message)),'a tall cross-slot rib blocks vertical installation of a mixed cap');
assert.ok(!mixedSet.assembly.cuttable);
assert.ok(!mixedSet.assembly.issues.some(i=>/install closed-socket end plates in this order/.test(i.message)));
// An outward neck above the open contact leaves the cap's vertical path clear.
const neck=structuredClone(mixed),neckGroup={...structuredClone(group),id:`f${created.next+1}`,
  sketch:{base:[nodes([[-7,-100],[18,-100],[18,100],[10,100],[10,81.6],[-7,81.6]])],keys:[],nextKey:1}};
neck.find(f=>f.id===ribs[0].id).params.profileId=neckGroup.id;neck.push(neckGroup);
const neckSet=run(neck);assert.deepEqual(errors(neckSet),[],'a mixed cap is allowed when its actual finished geometry has a clear insertion path');
assert.ok(neckSet.assembly.issues.some(i=>/install closed-socket end plates in this order/.test(i.message)));
const allSlots=structuredClone(mixed);for(const r of ribs)allSlots.find(f=>f.id===top.id).params[`joint:${r.id}`]='slots';
assert.deepEqual(errors(run(allSlots)),[],'explicit open contacts override a closed default without creating a cap');
const allClosed=structuredClone(mixed);allClosed.find(f=>f.id===top.id).params[`joint:${ribs[0].id}`]='';
const closedSet=run(allClosed);assert.deepEqual(errors(closedSet),[]);assert.equal(part(closedSet,top.id).nominalContours.filter(c=>c.isHole).length,ribs.length);
const noRibs=structuredClone(allClosed);for(const r of noRibs.filter(f=>f.kind==='assembly:rib'))r.enabled=false;
assert.ok(errors(run(noRibs)).some(i=>/0 of 0/.test(i.message)),'a closed default with no enabled ribs keeps its explicit attachment refusal');
console.log('  ok    per-contact inheritance, actual open/closed contours, clear and blocked mixed-cap insertion, restored defaults');

const server=await createServer({configFile:false,server:{middlewareMode:true,watch:null,hmr:false,ws:false},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom'});
try{
  const {useKerros}=await server.ssrLoadModule('/src/core/store.ts');
  const {RibProfileTools,RibProfileInspector}=await server.ssrLoadModule('/src/ui/RibProfiles.tsx');
  const {curveKeyLabel}=await server.ssrLoadModule('/src/ui/curveSession.ts');
  const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
  const state=()=>useKerros.getState();
  state().applyProject({...state().projectData(),features:original,nextFeatureNumber:created.next},created.next);
  const sources=state().features;
  assert.equal(state().createRibProfile(ribs[0].id,selected,plain,[...sources]),null,'stale revision cannot supply a profile');
  const id=state().createRibProfile(ribs[0].id,selected,plain,sources);assert.ok(id);assert.equal(state().curveEditorId,id);assert.equal(state().mode,'slice');
  const current=state().features.find(f=>f.id===id),next=copyCurveSketch(current.sketch);next.keys=mg.sketch.keys;next.nextKey=3;
  assert.equal(state().setCurveSketch(id,next,current.sketch),true);assert.equal(state().setCurveSketch(id,next,current.sketch),false);
  state().setParam(id,'curveMode','morph');state().editCurveProfile(id,'k2');assert.equal(state().curveKeyId,'k2');
  assert.equal(curveKeyLabel(state().features.find(f=>f.id===id),state().features,morphed,6),'rib sequence 6');
  const saved=parseProject(serializeProject(state().projectData(),'test','2026-09-19'));assert.equal(saved.ok,true);assert.deepEqual(saved.warnings,[]);
  const before=run(state().features);state().applyProject(saved.data,saved.nextFeatureNumber);assert.deepEqual(run(state().features),before,'roundtrip retains group memberships and every key');
  const sourceNow=state().features,solo=state().createRibProfile(ribs[2].id,[ribs[2].id],before,sourceNow);
  assert.ok(solo&&solo!==id);assert.equal(state().features.find(f=>f.id===ribs[1].id).params.profileId,id);
  assert.equal(profileRibs(state().features,created.id,id).length,5);
  assert.ok(state().assignRibProfile(id,[ribs[1].id,ribs[3].id]));assert.equal(state().features.find(f=>f.id===ribs[0].id).params.profileId,'');
  assert.equal(state().assignRibProfile(id,['missing']),false);
  state().setParam(ribs[1].id,'freePlacement',true);
  assert.ok(state().assignRibProfile(id,[ribs[3].id]));
  assert.equal(state().features.find(f=>f.id===ribs[1].id).params.profileId,id,'free placement retains its profile reference for restoration');
  state().setParam(ribs[1].id,'freePlacement',false);
  assert.ok(renderToStaticMarkup(createElement(RibProfileTools,{feature:original[1],layout:original[1],set:plain,pending:false,sources})).includes('Create shared profile group'));
  const ui=renderToStaticMarkup(createElement(RibProfileInspector,{feature:mg}));
  for(const text of ['Morph across ribs','Copy drawing to rib key','Key 1 height','Apply membership'])assert.ok(ui.includes(text),text);
  const input={...state().projectData(),features:mixed,nextFeatureNumber:created.next};
  const contacts=parseProject(serializeProject(input,'test','2026-09-19'));assert.deepEqual(contacts.data.features,mixed);
  const oldSelf=globalThis.self,replies=[];globalThis.self={postMessage(reply){replies.push(structuredClone(reply));}};
  try{await server.ssrLoadModule('/src/ui/kerros.worker.ts');globalThis.self.onmessage({data:{kind:'slice',token:9,job:{...options,features:morph}}});assert.deepEqual(replies.at(-1).output.set,morphed);}finally{globalThis.self=oldSelf;}
  const {buildParts,sheetToDxf}=await server.ssrLoadModule('/src/core/job.ts');const {nestByMaterial}=await server.ssrLoadModule('/src/core/nest.ts');const {writeDxfR12}=await server.ssrLoadModule('/src/core/dxf.ts');
  const parts=buildParts(morphed,[]),nested=nestByMaterial(parts,{sheetWidth:720,sheetHeight:400,gap:4,labelHeight:3,trueShape:false,cell:2});
  assert.equal(parts.length,morphed.slices.length);assert.equal(nested.unplaced.length,0);for(const sheet of nested.sheets)assert.ok(!/NaN|Infinity/.test(writeDxfR12(sheetToDxf(sheet))));
  console.log('  ok    guarded store creation, shared edits, independent detach, reassignment, save/open, reachable UI, worker parity and manufacturing contours');
}finally{await server.close();}
console.log('OK    rib profile groups, sequence morphs and individual support contacts');
