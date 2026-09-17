#!/usr/bin/env node
/** Meridian distance, live radial cuts and the reachable authored-profile path. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { radialProfile } from '../src/core/radialProfile.ts';
import { ellipseCurve, flattenCurve } from '../src/core/curves.ts';
import { profileVolume, composeField, runSliceJob } from '../src/core/pipeline.ts';
import { assemblyFeatures } from '../src/core/assemblyFeatures.ts';
import { parseProject, serializeProject } from '../src/core/project.ts';

const near=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b} (tolerance ${t})`);
const rectangle=(left,right,bottom,top)=>[left,bottom,right,bottom,right,top,left,top];
const nodes=ring=>Array.from({length:ring.length/2},(_,i)=>({point:ring.slice(i*2,i*2+2),incoming:[0,0],outgoing:[0,0],smooth:false}));
const radius=60,halfHeight=95;
const cylinder=radialProfile([rectangle(0,radius,-halfHeight,halfHeight)]);
const asymmetric=radialProfile([rectangle(-2,radius,-halfHeight,halfHeight)]);
for(let x=0;x<=90;x+=9)for(let y=-40;y<=40;y+=10)for(let z=-120;z<=120;z+=13){
  const a=Math.hypot(x,y)-radius,b=Math.abs(z)-halfHeight;
  const expected=Math.hypot(Math.max(a,0),Math.max(b,0))+Math.min(Math.max(a,b),0);
  near(cylinder.sample(x,y,z),expected);near(asymmetric.sample(x,y,z),expected);
}
near(cylinder.sample(0,0,0),-radius);
const shifted=radialProfile([rectangle(17,17+radius,-halfHeight,halfHeight)],17);
near(shifted.sample(7,13,4),cylinder.sample(7,13,4));
assert.deepEqual(shifted.min,cylinder.min);assert.deepEqual(shifted.max,cylinder.max);
const circleRadius=40, sphere=radialProfile([flattenCurve(ellipseCurve(0,0,circleRadius,circleRadius))]);
for(let x=0;x<=55;x+=5)for(let z=-55;z<=55;z+=5)near(sphere.sample(x,0,z),Math.hypot(x,z)-circleRadius,.04);
// An off-axis loop makes a torus; axis closure must not fill its centre.
const major=55,minor=12,torus=radialProfile([flattenCurve(ellipseCurve(major,0,minor,minor))]);
for(let x=0;x<85;x+=7)for(let z=-20;z<=20;z+=5)near(torus.sample(x,0,z),Math.hypot(x-major,z)-minor,.025);
const hollow=radialProfile([rectangle(0,60,-95,95),rectangle(0,40,-75,75)]);
assert.ok(hollow.sample(0,0,0)>0);assert.ok(hollow.sample(50,0,0)<0);near(hollow.sample(39,0,0),1);
const crossing=radialProfile([[0,-40,40,40,0,40,40,-40]]);
assert.ok(crossing.sample(20,0,-30)<0);assert.ok(crossing.sample(20,0,30)<0);assert.ok(crossing.sample(5,0,0)>0);
assert.throws(()=>radialProfile([rectangle(-40,-1,-20,20)]),/no area.*right/);
assert.throws(()=>radialProfile([rectangle(0,40,-20,20)],NaN),/rotation axis/);
for(const point of [[64,5,4],[20,20,97],[43,11,6]]){
  const h=1e-4,gradient=point.map((_,i)=>{const a=[...point],b=[...point];a[i]+=h;b[i]-=h;return(cylinder.sample(...a)-cylinder.sample(...b))/(2*h);});
  near(Math.hypot(...gradient),1,1e-6);
}
console.log('  ok    true meridian distances, clipped axis without seams, asymmetric drawings, sphere, torus, holes and unit gradients');

const feature={id:'f1',kind:'profile',stage:'SHAPE',name:'Radial drawing',enabled:true,
  params:{profileMode:'radial',axisX:0,curveMode:'morph',height:10,round:0,op:'union',k:0,px:0,py:0,pz:0,rx:0,ry:0,rz:0},
  sketch:{base:[nodes(rectangle(0,radius,-halfHeight,halfHeight))],keys:[{id:'k1',z:400,loops:[ellipseCurve(0,0,10,10)]}],nextKey:2}};
const volume=profileVolume(feature);
assert.deepEqual(volume.min,cylinder.min);assert.deepEqual(volume.max,cylinder.max);
near(volume.sample(0,0,0),-radius);assert.equal(volume.reach,Infinity);
const oldMode={...feature,params:{...feature.params,profileMode:'layers'}};
assert.ok(profileVolume(oldMode).max[2]>400,'retained layer keys still set the slab after switching back');
const moved={...feature,params:{...feature.params,px:11,py:-7,pz:19,rz:37}};
const field=composeField([moved],0,1,3,{spacerHeight:0},new Map());
near(field.solid(11,-7,19),-radius);
const options={thickness:3,kerf:.15,spacerHeight:6,resolution:120,tolerance:.025,smoothing:0,minFeature:1,seed:1};
const layout=assemblyFeatures('radial',2,{min:volume.min,max:volume.max});
const features=[feature,...layout.features];
const job={...options,features};
const run=(patch={})=>runSliceJob({...job,...patch},new Map());
const result=run(),set=result.set;
assert.deepEqual(set.assembly.issues.filter(i=>i.severity==='error'),[]);
const ribs=set.slices.filter(s=>s.part.kind==='rib'),supports=set.slices.filter(s=>s.part.kind==='support');
assert.equal(ribs.length,12);assert.equal(supports.length,2);assert.equal(set.assembly.joints.length,ribs.length*supports.length);
const box=s=>{const points=s.contours.flatMap(c=>c.points);return [Math.min(...points.filter((_,i)=>i%2===0)),Math.max(...points.filter((_,i)=>i%2===0)),Math.min(...points.filter((_,i)=>i%2===1)),Math.max(...points.filter((_,i)=>i%2===1))];};
for(const rib of ribs)box(rib).forEach((v,i)=>near(v,box(ribs[0])[i],.025));
const zero=run({kerf:0});near(box(ribs[0])[1]-box(zero.set.slices.find(s=>s.part.kind==='rib'))[1],options.kerf/2,.035);
const changed=structuredClone(features);changed[0].sketch.base=[nodes(rectangle(0,radius+4,-halfHeight,halfHeight))];
const changedSet=run({features:changed}).set;
assert.deepEqual(changedSet.assembly.issues.filter(i=>i.severity==='error'),[]);
assert.ok(box(changedSet.slices.find(s=>s.part.kind==='rib'))[1]>box(ribs[0])[1]+3,'drawing edits rebuild rib outlines and joints');
assert.equal(changedSet.assembly.joints.length,set.assembly.joints.length);
console.log('  ok    pipeline mode, preserved keys, rigid placement, twelve matching ribs, two supports, rebuilt joints and one kerf shift');

const server=await createServer({configFile:false,server:{middlewareMode:true,watch:null,hmr:false,ws:false},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom'});
try{
  const {useKerros}=await server.ssrLoadModule('/src/core/store.ts');
  const {CurveInspector}=await server.ssrLoadModule('/src/ui/CurveInspector.tsx');
  const {CurveEditor}=await server.ssrLoadModule('/src/ui/CurveEditor.tsx');
  const {curveLayerTarget}=await server.ssrLoadModule('/src/ui/curveSession.ts');
  const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
  const state=()=>useKerros.getState();state().addCurveProfile();
  const id=state().selectedId;state().setCurveSketch(id,feature.sketch,state().features[0].sketch);
  state().setParam(id,'profileMode','radial');state().setParam(id,'axisX',0);state().setParam(id,'curveMode','morph');
  state().editCurveProfile(id,'k1');assert.equal(state().curveKeyId,null,'radial mode always edits the base drawing');
  const saved=parseProject(serializeProject(state().projectData(),'test','2026-09-17'));
  assert.equal(saved.ok,true);assert.deepEqual(saved.warnings,[]);assert.equal(saved.data.features[0].params.profileMode,'radial');
  assert.deepEqual(saved.data.features[0].sketch,feature.sketch);
  state().applyProject(saved.data,saved.nextFeatureNumber);state().addAssembly('radial');
  const fromUi=run({features:state().features}).set;assert.equal(fromUi.assembly.joints.length,24);
  const f=state().features[0];assert.match(curveLayerTarget(f,[f],null,1).reason,/inactive/);
  const inspector=renderToStaticMarkup(createElement(CurveInspector,{feature:f,slices:fromUi,fresh:true}));
  for(const text of ['Use drawing as','Radial side profile','Axis X','Preview radial ribs','retained but inactive'])assert.ok(inspector.includes(text),text);
  assert.ok(!inspector.includes('Copy drawing to layer'),'inactive keys cannot be edited through the radial inspector');
  const editor=renderToStaticMarkup(createElement(CurveEditor,{feature:f,slices:fromUi}));
  for(const text of ['Rotation axis','Radial side profile','shaded left side'])assert.ok(editor.includes(text),text);
  const {buildParts,sheetToDxf,assemblyDocument}=await server.ssrLoadModule('/src/core/job.ts');
  const {nestByMaterial}=await server.ssrLoadModule('/src/core/nest.ts');
  const {writeDxfR12}=await server.ssrLoadModule('/src/core/dxf.ts');
  const {writePdf}=await server.ssrLoadModule('/src/core/pdf.ts');
  const parts=buildParts(set,[]),nested=nestByMaterial(parts,{sheetWidth:720,sheetHeight:400,gap:4,labelHeight:3,trueShape:false,cell:2});
  assert.equal(parts.length,14);assert.equal(nested.unplaced.length,0);
  for(const sheet of nested.sheets)assert.ok(!/NaN|Infinity/.test(writeDxfR12(sheetToDxf(sheet))));
  assert.ok(writePdf(assemblyDocument({set,sheets:nested.sheets,spacers:[],machineName:'Test',materialName:'Test',thickness:3,kerf:.15,spacerHeight:6,spacerAchieved:6,ringThickness:3,version:'test',projectName:'Radial drawing'})).startsWith('%PDF'));
  const oldSelf=globalThis.self,replies=[];globalThis.self={postMessage(reply){replies.push(structuredClone(reply));}};
  try{await server.ssrLoadModule('/src/ui/kerros.worker.ts');globalThis.self.onmessage({data:{kind:'slice',token:1,job}});assert.deepEqual(replies.at(-1).output.set,set);}finally{globalThis.self=oldSelf;}
  console.log('  ok    save/open, creation action, inactive keys, reachable axis/editor controls, worker parity, nesting, DXF and PDF');
}finally{await server.close();}
console.log('OK    radial side profiles');
