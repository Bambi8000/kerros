#!/usr/bin/env node
/** Real rod frames, slicing, assembly routing, state and export. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { Euler, Vector3 } from 'three';
import { rodFromFeature, rodPose, rodIsVertical, fitRodToBounds, spacerPlans } from '../src/core/rig.ts';
import { runSliceJob, bossesFromFeatures } from '../src/core/pipeline.ts';
import { assemblyFeatures } from '../src/core/assemblyFeatures.ts';
import { nestByMaterial } from '../src/core/nest.ts';
import { indexProfile, indexedDistance } from '../src/core/profile2d.ts';
const near = (a,b,t=1e-7) => assert.ok(Math.abs(a-b) <= t, `${a} != ${b}, tolerance ${t}`);
const vectorNear = (a,b,t) => a.forEach((v,i)=>near(v,b[i],t));
const body = {id:'body',name:'Body',kind:'roundBox',stage:'SHAPE',enabled:true,params:{sx:100,sy:100,sz:30,pz:15,r:0,op:'union'}};
const rod = (params={}) => ({id:'rod',name:'Rod 1',kind:'rod',stage:'RIG',enabled:true,params:{size:'M5',px:0,py:0,pz:15,length:150,...params}});
const options = {thickness:3,kerf:.2,spacerHeight:3,resolution:120,tolerance:.025,smoothing:0,minFeature:1,seed:7};
const run = (features,extra={}) => runSliceJob({...options,features,...extra},new Map()).set;
for (const angles of [[0,0,0],[29,43,-67],[90,0,0],[0,90,12],[180,0,0],[-60,80,205]]) {
  const f=rod(Object.fromEntries(['rx','ry','rz'].map((k,i)=>[k,angles[i]]))), spec=rodFromFeature(f), pose=rodPose(spec);
  const euler=new Euler(...angles.map(v=>v*Math.PI/180),'ZYX');
  for (const [key,axis] of [['u',[1,0,0]],['v',[0,1,0]],['direction',[0,0,1]]]) vectorNear(pose[key],new Vector3(...axis).applyEuler(euler).toArray());
  near(new Vector3(...pose.end).distanceTo(new Vector3(...pose.start)),f.params.length);
  vectorNear(pose.start.map((v,i)=>(v+pose.end[i])/2),pose.centre);
}
assert.ok(rodIsVertical(rodFromFeature(rod({rz:97}))));
assert.ok(!rodIsVertical(rodFromFeature(rod({ry:30}))));
console.log('  ok    complete ZYX frame, centre pivot, length and vertical spin');
const legacy = {...rod(),params:{px:3,py:-4,zStart:50,zEnd:10,size:'M5'}};
vectorNear(rodPose(rodFromFeature(legacy)).centre,[3,-4,30]);
const bounds={min:[-50,-50,0],max:[50,50,30]};
const fit=fitRodToBounds(rodFromFeature(rod({ry:90})),bounds);
near(fit.length,100);near(fit.pz,15);
assert.deepEqual(run([body,rod()]).slices,run([body,rod({rz:84})]).slices,'axial spin preserves original circle path');
console.log('  ok    old two-end projects, axis-based length fit and unchanged vertical cuts');

const tilted=rod({ry:30}), set=run([body,tilted]);
assert.deepEqual(set.rods.issues,[]);assert.equal(set.rods.routes[0].layers.length,set.slices.length);
for (const slice of set.slices) {
  const hole=slice.contours.find(c=>c.owner==='rod');assert.ok(hole?.isHole);
  assert.ok(!slice.circles.some(c=>c.owner==='rod'));
  const xs=hole.points.filter((_,i)=>i%2===0), ys=hole.points.filter((_,i)=>i%2===1);
  const theta=tilted.params.ry*Math.PI/180, d=5.3;
  near(Math.max(...xs)-Math.min(...xs),d/Math.cos(theta)+options.thickness*Math.tan(theta)-options.kerf,.06);
  near(Math.max(...ys)-Math.min(...ys),d-options.kerf,.06);
  near((Math.max(...xs)+Math.min(...xs))/2,(slice.z-tilted.params.pz)*Math.tan(theta),.04);
}
// Containment of the nominal cylinder through all depths, measured against
// the compensated cut plus half a kerf. Expected points come from its frame.
const pose=rodPose(rodFromFeature(tilted));
for (const slice of set.slices) {
  const hole=slice.contours.find(c=>c.owner==='rod');
  const index=indexProfile({rings:[hole.points],fill:'holes'},1,.02,100);
  for (const z of [slice.zBottom,slice.z,slice.zBottom+options.thickness]) for(let j=0;j<72;j++) {
    const a=j*Math.PI/36, offset=pose.u.map((u,i)=>(u*Math.cos(a)+pose.v[i]*Math.sin(a))*5.3/2);
    const t=(z-pose.centre[2]-offset[2])/pose.direction[2];
    const point=pose.centre.map((c,i)=>c+t*pose.direction[i]+offset[i]);
    assert.ok(indexedDistance(index,point[0],point[1])<=options.kerf/2+.035);
  }
}
const twisted=run([body,rod({rx:12,ry:30,rz:23})],{twistPerLayer:17});
const untwisted=run([body,rod({rx:12,ry:30,rz:23})]);
assert.deepEqual(twisted.rods.issues,[]);
for (const slice of twisted.slices) {
  const hole=slice.contours.find(c=>c.owner==='rod'), other=untwisted.slices.find(s=>s.index===slice.index).contours.find(c=>c.owner==='rod');
  const centre=points=>[0,1].map(k=>(Math.min(...points.filter((_,i)=>i%2===k))+Math.max(...points.filter((_,i)=>i%2===k)))/2);
  const c=centre(hole.points), a=(slice.index-1)*17*Math.PI/180;
  vectorNear([c[0]*Math.cos(a)-c[1]*Math.sin(a),c[0]*Math.sin(a)+c[1]*Math.cos(a)],centre(other.points),.05);
}
console.log('  ok    full-stock inclined openings, in-plane kerf and layer twist alignment');
assert.ok(run([body,rod({ry:30,length:15})]).rods.issues.some(i=>i.severity==='error'&&i.message.includes('complete crossing')));
assert.ok(run([body,rod({ry:90,pz:1.5})]).rods.issues.some(i=>i.severity==='error'));
assert.ok(run([body,rod({ry:10,px:48})]).rods.issues.some(i=>i.message.includes('edge')));
assert.ok(run([body,rod({ry:30,px:200})]).rods.issues.some(i=>i.severity==='warning'&&i.message.includes('misses')));
assert.ok(run([body,tilted,{...rod({ry:30,py:2}),id:'second'}]).rods.issues.some(i=>i.id==='second'&&i.severity==='error'));
assert.deepEqual(spacerPlans([rodFromFeature(tilted)],set.slices,{...options,ringWidth:3}),[]);
const boss={id:'boss',kind:'boss',stage:'RIG',name:'Boss',enabled:true,params:{attachTo:'rod',radius:9,selKind:'all'}};
assert.deepEqual(bossesFromFeatures([tilted,boss],set.planes),[]);
assert.ok(run([body,tilted,boss]).rods.issues.some(i=>i.id==='boss'&&i.severity==='error'));
console.log('  ok    finite ends, along-face and edge refusals, misses, overlapping holes and incompatible attachments');

const tall={...body,params:{...body.params,sx:140,sy:120,sz:200,pz:100,r:4}};
const makeAssembly=kind=>assemblyFeatures(kind,2,{min:[-70,-60,0],max:[70,60,200]}).features;
const linear=makeAssembly('linear'), across=rod({ry:90,px:0,py:24,pz:100,length:180});
const upright=run([tall,...linear,across]);
const route=upright.assembly.channels.find(c=>c.id==='rod');
assert.equal(route.kind,'rod');assert.equal(route.hits.length,9);assert.ok(upright.assembly.cuttable,JSON.stringify(upright.assembly.issues));
vectorNear(route.start,rodPose(rodFromFeature(across)).start);vectorNear(route.end,rodPose(rodFromFeature(across)).end);
assert.ok(upright.slices.filter(s=>s.part.kind==='rib').every(s=>s.contours.some(c=>c.isHole)));
const moved=structuredClone(linear);Object.assign(moved[0].params,{angle:37,px:8,py:-11,pz:6});
const local=[0,24,0], a=37*Math.PI/180;
const worldRod=rod({ry:90,rz:37,px:local[0]*Math.cos(a)-local[1]*Math.sin(a)+8,py:local[0]*Math.sin(a)+local[1]*Math.cos(a)-11,pz:106,length:180});
const transformed=run([tall,...moved,worldRod]);
assert.equal(transformed.assembly.channels[0].hits.length,9);assert.ok(transformed.assembly.cuttable);
vectorNear(transformed.assembly.channels[0].start,rodPose(rodFromFeature(worldRod)).start);
const radial=makeAssembly('radial');
const radialSet=run([tall,...radial,rod({px:50,py:14,pz:100,rx:1.5,length:220})]);
assert.ok(radialSet.assembly.channels[0].hits.length>=2,JSON.stringify(radialSet.assembly.issues));
assert.ok(radialSet.assembly.channels[0].hits.some(id=>radialSet.slices.find(s=>s.part.id===id)?.part.kind==='support'));
const bad=run([tall,...linear,rod({ry:90,py:24,pz:100,length:25})]);
assert.ok(!bad.assembly.cuttable&&bad.assembly.issues.some(i=>i.ids.includes('rod')&&i.severity==='error'));
console.log('  ok    linear ribs, globally transformed layout, radial supports and finite assembly rod checks');

const server=await createServer({configFile:false,server:{middlewareMode:true,watch:null,hmr:false,ws:false},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom'});
try {
  const {useKerros,hasRotation,worldTransformOf}=await server.ssrLoadModule('/src/core/store.ts');
  const {parseProject,serializeProject}=await server.ssrLoadModule('/src/core/project.ts');
  const {buildParts,manifestText,assemblyDocument,sheetToDxf}=await server.ssrLoadModule('/src/core/job.ts');
  const {writePdf}=await server.ssrLoadModule('/src/core/pdf.ts');
  const {writeDxfR12}=await server.ssrLoadModule('/src/core/dxf.ts');
  const state=()=>useKerros.getState();
  state().addShape('roundBox');state().addRod();
  const id=state().selectedId, original=state().features.find(f=>f.id===id);
  assert.ok(hasRotation(original));
  state().setTransformWorld(id,[10,20,30],[12,45,67]);
  const edited=state().features.find(f=>f.id===id);
  assert.equal(edited.params.length,original.params.length);
  vectorNear(worldTransformOf(state().features,edited).rotation,[12,45,67]);
  const data=state().projectData();data.features=[body,legacy];state().applyProject(data,2);
  vectorNear(worldTransformOf(state().features,legacy).position,[3,-4,30]);
  state().setTransformWorld('rod',[3,-4,30],[0,45,0]);
  assert.equal(state().features.find(f=>f.id==='rod').params.length,40);
  const saved=serializeProject(state().projectData(),'0.33.0','2026-09-14T00:00:00Z');
  assert.deepEqual(parseProject(saved).data.features,state().features);
  const parts=buildParts(set,[]);
  assert.ok(parts.length>0);
  const nested=nestByMaterial(parts,{sheetWidth:700,sheetHeight:390,gap:3,labelHeight:3});
  assert.equal(nested.unplaced.length,0);
  const sheet=nested.sheets[0];
  assert.ok(parts.every(p=>p.holes.length===1),'cut contours reach nesting parts');
  const dxf=writeDxfR12(sheetToDxf(sheet));
  assert.ok(dxf.includes('POLYLINE')&&!dxf.includes('NaN'),'oblique holes reach DXF');
  const manifestInput={set,sheets:[],spacers:[],version:'0.33.0',machineName:'Test',materialName:'Test',thickness:3,kerf:.2,spacerHeight:3,spacerAchieved:3,projectName:'Rod rotation'};
  const manifest=manifestText(manifestInput);assert.ok(manifest.includes('INCLINED RODS')&&manifest.includes('Rod 1'));
  assert.ok(assemblyDocument(manifestInput).length>assemblyDocument({...manifestInput,set:{...set,rods:undefined}}).length,'PDF carries a separate rod instruction page');
  assert.ok(writePdf(assemblyDocument(manifestInput)).length>1000);
  assert.ok(manifestText({...manifestInput,set:upright}).includes('Rod rod:'));
  console.log('  ok    reachable transform state, legacy pivot, project persistence and rod manifest/PDF');
} finally {await server.close();}
console.log('OK    rod rotation, full-thickness holes, assembly routing and state/export');
