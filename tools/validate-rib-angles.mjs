#!/usr/bin/env node
/** Additive angle groups and fan placement through real geometry and store. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { assemblyFeatures } from '../src/core/assemblyFeatures.ts';
import { ribAngleGroup, ribAngleTargets, ribAngleValue, ribPlacementAngles } from '../src/core/assembly.ts';
import { runSliceJob } from '../src/core/pipeline.ts';
const bounds={min:[-60,-60,-60],max:[60,60,60]};
const base={id:'f1',kind:'sphere',stage:'SHAPE',name:'Body',enabled:true,params:{op:'union',r:60}};
const options={thickness:3,kerf:.15,spacerHeight:6,resolution:120,tolerance:.025,smoothing:1,minFeature:1,seed:7};
const run=fs=>runSliceJob({...options,features:[base,...fs]},new Map()).set;
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const a=assemblyFeatures('linear',2,bounds),layout=a.features[0],ribs=a.features.filter(f=>f.kind==='assembly:rib');
const original=run(a.features);
Object.assign(layout.params,{oddAngle:0,evenAngle:0,fanAngle:0});
assert.deepEqual(run(a.features),original,'missing angle fields preserve old projects exactly');
Object.assign(layout.params,{ribAngle:3,oddAngle:7,evenAngle:-5,fanAngle:16});
ribs[3].params.angle=2;
const angles=ribPlacementAngles(a.features,layout),combined=run(a.features);
for(let i=0;i<ribs.length;i++){
  const expected=3+(i%2===0?7:-5)+16*(1-2*i/(ribs.length-1))+(i===3?2:0);
  near(angles.get(ribs[i].id),expected);
  const p=combined.slices.find(s=>s.part.id===ribs[i].id).part;
  near(p.u[0],-Math.sin(expected*Math.PI/180));near(p.u[1],Math.cos(expected*Math.PI/180));
}
// A flattened legacy-angle model must produce exactly the same cuts, wall
// joints, collision checks and insertion order as the new composition.
const flat=structuredClone(a.features);
Object.assign(flat[0].params,{ribAngle:0,oddAngle:0,evenAngle:0,fanAngle:0});
flat.filter(f=>f.kind==='assembly:rib').forEach(f=>f.params.angle=angles.get(f.id));
assert.deepEqual(run(flat),combined);
assert.notDeepEqual(combined.slices.find(s=>s.part.kind==='backplate').contours,original.slices.find(s=>s.part.kind==='backplate').contours,'wall slots actually follow the new angles');
console.log('  ok    legacy identity, additive groups, actual part frames and identical cuts/joints to flattened angles');

const odd=ribs.filter((_,i)=>i%2===0).map(f=>f.id),even=ribs.filter((_,i)=>i%2===1).map(f=>f.id);
assert.deepEqual(ribAngleTargets(a.features,ribs[1].id,'odd'),odd,'Odd does not depend on the inspected rib belonging to it');
assert.deepEqual(ribAngleTargets(a.features,ribs[0].id,'even'),even);
assert.deepEqual(ribAngleTargets(a.features,ribs[2].id,'selected'),[ribs[2].id]);
assert.deepEqual(ribAngleTargets(a.features,ribs[0].id,'all'),ribs.map(r=>r.id));
assert.equal(ribAngleGroup({...ribs[0],id:'f104',name:'Renamed'}),'odd','parity is sequence, not feature ID or editable name');
const hidden=structuredClone(a.features);hidden.find(f=>f.id===ribs[0].id).enabled=false;
assert.deepEqual(ribPlacementAngles(hidden,hidden[0]),angles,'hiding a rib does not redistribute the fan');
assert.deepEqual(ribAngleTargets(hidden,ribs[1].id,'odd'),odd.slice(1));
assert.deepEqual(ribPlacementAngles([...a.features].reverse(),layout),angles,'tree order does not redistribute the fan');
for(const count of [1,2,8,9]){
  const fs=structuredClone(a.features).filter(f=>f.kind!=='assembly:rib'||f.params.ordinal<count);
  Object.assign(fs[0].params,{ribAngle:0,oddAngle:0,evenAngle:0,fanAngle:30});
  fs.filter(f=>f.kind==='assembly:rib').forEach(f=>f.params.angle=0);
  const values=[...ribPlacementAngles(fs,fs[0]).values()];
  values.forEach((v,i)=>near(v,-values.at(-i-1)));
  if(count%2)near(values[Math.floor(count/2)],0);
  if(count>1){near(values[0],30);near(values.at(-1),-30);}
  fs[0].params.fanAngle=-30;
  [...ribPlacementAngles(fs,fs[0]).values()].forEach((v,i)=>near(v,-values[i]));
}
const moved=structuredClone(a.features);moved.find(f=>f.id===ribs[0].id).params.px=200;
const movedAngles=ribPlacementAngles(moved,moved[0]);
near(movedAngles.get(ribs[0].id),3+7-16);
assert.equal(ribAngleGroup(moved.find(f=>f.id===ribs[0].id)),'odd','moving across the row changes fan position but not parity');
const radial=assemblyFeatures('radial',2,bounds);Object.assign(radial.features[0].params,{fanAngle:80,oddAngle:9,evenAngle:-9});
[...ribPlacementAngles(radial.features,radial.features[0]).values()].forEach((v,i)=>near(v,i%2===0?9:-9));
console.log('  ok    stable parity, hidden ribs, reordered tree, odd/even counts, inward/outward fans, moved stations and radial groups');

const server=await createServer({configFile:false,server:{middlewareMode:true,watch:null,hmr:false,ws:false},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom'});
try{
  const {useKerros}=await server.ssrLoadModule('/src/core/store.ts');
  const {parseProject,serializeProject}=await server.ssrLoadModule('/src/core/project.ts');
  const {buildParts,sheetToDxf,manifestText,assemblyDocument}=await server.ssrLoadModule('/src/core/job.ts');
  const {runNestJob,rehydrateNest}=await server.ssrLoadModule('/src/core/pipeline.ts');
  const {writeDxfR12}=await server.ssrLoadModule('/src/core/dxf.ts');
  const state=()=>useKerros.getState();state().addShape('sphere');state().setParam('f1','r',60);state().addAssembly('linear');
  const group=state().features.find(f=>f.kind==='assembly:layout'),rs=state().features.filter(f=>f.kind==='assembly:rib');
  const before=structuredClone(state().features);
  for(const scope of ['odd','even','all','selected'])state().setAssemblyAngleScope(scope);
  assert.deepEqual(state().features,before,'scope selection causes no geometry edit');
  state().setAssemblyAngle(rs[0].id,2,'selected');
  const manual=structuredClone(state().features.filter(f=>f.kind==='assembly:rib'));
  state().setAssemblyAngle(rs[1].id,4,'odd');state().setAssemblyAngle(rs[0].id,-3,'even');state().setAssemblyAngle(rs[0].id,1,'all');state().setParam(group.id,'fanAngle',12);
  assert.deepEqual(state().features.filter(f=>f.kind==='assembly:rib'),manual,'group changes never rewrite individual values');
  // A gizmo commits a delta to the current scope once, using the same value
  // the inspector shows. Every target changes by that delta, all others stay.
  for(const scope of ['selected','odd','even','all']){
    const fs=state().features,g=fs.find(f=>f.id===group.id),r=fs.find(f=>f.id===rs[0].id),initial=ribPlacementAngles(fs,g);
    let notifications=0;const stop=useKerros.subscribe(()=>notifications++);
    state().setAssemblyAngle(r.id,ribAngleValue(r,g,scope)+3,scope);stop();assert.equal(notifications,1);
    const after=ribPlacementAngles(state().features,state().features.find(f=>f.id===g.id)),targets=ribAngleTargets(fs,r.id,scope);
    rs.forEach(rib=>near(after.get(rib.id)-initial.get(rib.id),targets.includes(rib.id)?3:0));
  }
  state().setAssemblyAngle(rs[0].id,2,'selected');state().setAssemblyAngle(rs[0].id,4,'odd');state().setAssemblyAngle(rs[0].id,-3,'even');state().setAssemblyAngle(rs[0].id,1,'all');
  const valid=state().features;state().setAssemblyAngle(rs[0].id,NaN,'odd');assert.deepEqual(state().features,valid);
  const saved=serializeProject(state().projectData(),'0.32.0','2026-09-14T00:00:00Z'),opened=parseProject(saved);state().applyProject(opened.data,opened.nextFeatureNumber);
  assert.deepEqual(state().features,valid);assert.equal(state().assemblyAngleScope,'selected');
  const job={...options,features:state().features},out=runSliceJob(job,new Map());assert.equal(out.set.assembly.cuttable,true,JSON.stringify(out.set.assembly.issues));
  const parts=buildParts(out.set,[]),nestOptions={sheetWidth:730,sheetHeight:410,gap:4,labelHeight:3,trueShape:false,cell:2};
  const nested=rehydrateNest(runNestJob({parts,options:nestOptions}),parts);assert.equal(nested.unplaced.length,0);
  for(const sheet of nested.sheets)assert.ok(!/NaN|Infinity/.test(writeDxfR12(sheetToDxf(sheet))));
  const input={set:out.set,sheets:nested.sheets,spacers:[],machineName:'Test bed',materialName:'Stock',thickness:3,kerf:.15,spacerHeight:6,spacerAchieved:0,version:'0.32.0',projectName:'Angle groups',ringThickness:3};
  assert.ok(manifestText(input).includes('JOINTS AND INSERTION'));assert.ok(assemblyDocument(input).every(p=>p.polylines.every(l=>l.points.every(Number.isFinite))));
  const previous=globalThis.self,replies=[];globalThis.self={postMessage(m){replies.push(structuredClone(m));}};
  try{await server.ssrLoadModule('/src/ui/kerros.worker.ts');globalThis.self.onmessage({data:{kind:'slice',token:71,job}});assert.deepEqual(replies.at(-1).output.set,out.set);}finally{globalThis.self=previous;}
  const previousOrdinal=rs.at(-1).params.ordinal;state().addAssemblyMember(group.id,'rib');
  const added=state().features.at(-1);assert.equal(added.params.ordinal,previousOrdinal+1);assert.equal(ribAngleGroup(added),'even');
  const newAngles=ribPlacementAngles(state().features,state().features.find(f=>f.id===group.id));near(newAngles.get(added.id),1-3-12);
  console.log('  ok    real store scope edits, atomic gizmo deltas, preserved manual angles, save/open, new ribs, nesting, DXF/PDF and worker');
}finally{await server.close();}
console.log('OK    rib angle groups and fan');
