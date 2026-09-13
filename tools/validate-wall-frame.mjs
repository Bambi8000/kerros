#!/usr/bin/env node
/** Shape-following wall frames through the real feature factory and cutting pipeline. */
import assert from 'node:assert/strict';
import { runSliceJob } from '../src/core/pipeline.ts';
import { assemblyFeatures, assemblyMember } from '../src/core/assemblyFeatures.ts';
import { sheetLocal, sheetWorld } from '../src/core/assembly.ts';
import { groupContours } from '../src/core/slice.ts';
import { indexProfile, indexedDistance } from '../src/core/profile2d.ts';

const base={id:'f1',kind:'sphere',stage:'SHAPE',name:'Body',enabled:true,params:{op:'union',r:40}};
const bounds={min:[-40,-40,-40],max:[40,40,40]};
const options={thickness:3,kerf:.15,spacerHeight:6,resolution:120,tolerance:.025,smoothing:1,minFeature:1.5,seed:7};
const create=()=>assemblyFeatures('linear',2,bounds);
const run=(features,overrides={})=>runSliceJob({...options,features:[base,...features],...overrides},new Map()).set;
const backFeature=features=>features.find(f=>f.kind==='assembly:backplate');
const backSlice=set=>set.slices.find(s=>s.part.kind==='backplate');
const errors=set=>set.assembly.issues.filter(i=>i.severity==='error');
const near=(a,b,t=.08)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
const box=c=>{const x=c.points.filter((_,i)=>i%2===0),y=c.points.filter((_,i)=>i%2===1);return {cx:(Math.max(...x)+Math.min(...x))/2,cy:(Math.max(...y)+Math.min(...y))/2,w:Math.max(...x)-Math.min(...x),h:Math.max(...y)-Math.min(...y)};};
const slots=(set)=>groupContours(backSlice(set).contours)[0].holes.filter(c=>Math.abs(box(c).h-(backFeature(assembly.features).params.tabHeight+2*assembly.features[0].params.jointClearance-options.kerf))<.1).sort((a,b)=>box(a).cx-box(b).cx||box(a).cy-box(b).cy);
const assembly=create(), wall=backFeature(assembly.features);
assert.equal(wall.params.outline,'frame','new wall mounts default to the open frame');
const set=run(assembly.features), back=backSlice(set);
assert.deepEqual(errors(set),[]);assert.equal(set.assembly.joints.length,9);
assert.equal(groupContours(back.contours).length,1,'the frame is one connected part');
assert.equal(back.contours.filter(c=>c.isHole).length,9*2+2+1,'two tab slots per rib, two screws and an open centre');
const rectangular=structuredClone(assembly.features);backFeature(rectangular).params.outline='rectangle';
const rectangle=run(rectangular);
const area=back.contours.reduce((sum,c)=>sum+c.area,0), rectangleArea=backSlice(rectangle).contours.reduce((sum,c)=>sum+c.area,0);
assert.ok(area<rectangleArea*.4,'the frame removes most of the old rectangular plate');
const oldProject=structuredClone(rectangular);delete backFeature(oldProject).params.outline;
assert.deepEqual(run(oldProject),rectangle,'missing outline preserves the original rectangular workflow');
console.log(`  ok    connected open frame, all joints and screws; ${(100*(1-area/rectangleArea)).toFixed(1)}% less backplate area in the sphere fixture`);

// The slots follow actual rib shoulders: outer sphere stations are shorter.
const tabSlots=slots(set);assert.equal(tabSlots.length,18);
const positive=tabSlots.map(box).filter(b=>b.cy>0);
assert.ok(positive.find(b=>Math.abs(b.cx)<1).cy>positive[0].cy+5,'upper rail follows the curved source rather than a fixed-height row');
const moved=structuredClone(assembly.features), rib=moved.find(f=>f.kind==='assembly:rib'&&f.params.ordinal===4);
rib.params.pz=6;
const movedSet=run(moved);assert.deepEqual(errors(movedSet),[]);
const centreSlots=slots(movedSet).map(box).filter(b=>Math.abs(b.cx)<1).sort((a,b)=>a.cy-b.cy);
const originalCentre=tabSlots.map(box).filter(b=>Math.abs(b.cx)<1).sort((a,b)=>a.cy-b.cy);
centreSlots.forEach((b,i)=>near(b.cy-originalCentre[i].cy,6));
assert.notDeepEqual(backSlice(movedSet).contours,back.contours,'the support follows rib placement as well as the source shape');

// Every slot centre maps into the matching generated tab in the rib drawing.
for (const slot of tabSlots) {
  const b=box(slot), world=sheetWorld(back.part,b.cx,b.cy);
  const rib=set.slices.find(s=>s.part.kind==='rib'&&Math.abs(s.part.origin[0]-world[0])<.1);
  assert.ok(rib);
  const p=sheetLocal(rib.part,world), index=indexProfile({rings:rib.contours.map(c=>c.points),fill:'holes'},1,.025,4);
  assert.ok(indexedDistance(index,p[0],p[1])<0,'a cut slot has its actual mating tab');
}
console.log('  ok    curved rails, rib movement and actual tab/slot alignment');

for (const mount of ['none','keyhole']) {
  const features=structuredClone(assembly.features);backFeature(features).params.mount=mount;
  const result=run(features);assert.deepEqual(errors(result),[]);
  assert.equal(backSlice(result).contours.filter(c=>c.isHole).length,18+1+(mount==='none'?0:2));
}
const adjusted=structuredClone(assembly.features);
Object.assign(backFeature(adjusted).params,{frameWidth:16,profileInset:2,ownMaterial:true,thickness:5,kerf:.12});
const adjustedSet=run(adjusted);assert.deepEqual(errors(adjustedSet),[]);
assert.notDeepEqual(backSlice(adjustedSet).contours,back.contours,'width and inset affect actual cut geometry');
adjusted[0].params.angle=37;adjusted[0].params.px=11;
assert.deepEqual(run(adjusted).slices.map(s=>s.contours),adjustedSet.slices.map(s=>s.contours),'whole-layout rotation leaves local cuts unchanged');
console.log('  ok    keyholes, no mounting holes, width/inset, mixed stock and whole-layout rotation');

const oblique=structuredClone(assembly.features);oblique[0].params.ribAngle=25;
assert.deepEqual(errors(run(oblique)),[],'frame slots include the full oblique tab sweep');
const nominal=backSlice(run(assembly.features,{kerf:0})), compensated=backSlice(run(assembly.features,{kerf:.2}));
near(box(compensated.contours.find(c=>!c.isHole)).w-box(nominal.contours.find(c=>!c.isHole)).w,.2,.025);
const centreHole=s=>s.contours.filter(c=>c.isHole).sort((a,b)=>a.area-b.area)[0];
near(box(centreHole(nominal)).w-box(centreHole(compensated)).w,.2,.04);
console.log('  ok    oblique frame joints and opposite kerf shifts on outer rim and centre opening');

const channel=assemblyMember('channel',assembly.features[0],assembly.features,assembly.next++);
const withLed=run([...assembly.features,channel]);assert.deepEqual(errors(withLed),[]);assert.equal(withLed.assembly.channels[0].hits.length,9);
for (const patch of [{frameWidth:2},{profileInset:100},{frameWidth:45},{px:30}]) {
  const features=structuredClone(assembly.features);Object.assign(backFeature(features).params,patch);
  const invalid=run(features);assert.equal(invalid.assembly.cuttable,false);assert.ok(errors(invalid).some(i=>i.ids.includes(wall.id)));
}
const manual=structuredClone(assembly.features);Object.assign(backFeature(manual).params,{mountPlacement:'manual',mountZ:0,mountSpacing:12});
assert.ok(errors(run(manual)).some(i=>i.message.includes('mounting opening')),'manual holes in the empty centre are refused');
const single=assembly.features.filter(f=>f.kind!=='assembly:rib'||f.params.ordinal===0);
assert.ok(errors(run(single)).some(i=>i.message.includes('at least two usable ribs')));
console.log('  ok    LED route and explicit refusals for narrow/closed/missing frames, offsets and unsupported mounting holes');
console.log('OK    wall frames');
