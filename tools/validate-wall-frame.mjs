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

// Regression: a short end rib used to vanish from the frame plan altogether.
// Check actual slot contours and mating material, not just a joint count.
const field=s=>{const index=indexProfile({rings:s.contours.map(c=>c.points),fill:'holes'},1,.025,4);return (x,y)=>indexedDistance(index,x,y);};
for (const [ordinal,sourceX,expectedTabs] of [[0,-36,2],[0,-38,2],[8,38,2],[0,-39,1],[4,-39,1]]) {
  const features=structuredClone(assembly.features), short=features.find(f=>f.kind==='assembly:rib'&&f.params.ordinal===ordinal);
  Object.assign(short.params,{sourceX,pz:3});
  const result=run(features), plate=backSlice(result), part=result.slices.find(s=>s.part.id===short.id);
  assert.deepEqual(errors(result),[]);
  const expected=features.filter(f=>f.kind==='assembly:rib').map(f=>f.id).sort();
  assert.deepEqual(result.assembly.joints.map(j=>j.parts.find(id=>id!==wall.id)).sort(),expected,'every rib has its wall joint');
  assert.ok(result.assembly.issues.some(i=>i.message==='Wall attachment: 9 of 9 enabled ribs have complete tab joints.'));
  assert.equal(groupContours(plate.contours).length,1,'short-rib contact stays connected to the frame');
  const holes=slots(result).filter(c=>Math.abs(sheetWorld(plate.part,box(c).cx,box(c).cy)[0]-part.part.origin[0])<.1);
  assert.equal(holes.length,expectedTabs,'the short rib has the required separate slots');
  const ribField=field(part), plateField=field(plate);
  for(const hole of holes){
    const b=box(hole), local=sheetLocal(part.part,sheetWorld(plate.part,b.cx,b.cy));
    near(b.h,wall.params.tabHeight+2*assembly.features[0].params.jointClearance-options.kerf);
    assert.ok(ribField(local[0],local[1])<0,'the wall slot meets a full-height rib tab');
    // Both faces of the wall plate sit within the tab's depth, and material
    // beyond the slot is part of the single connected frame.
    for(const n of [-plate.part.thickness/2+.3,plate.part.thickness/2-.3]){
      const q=sheetLocal(part.part,sheetWorld(plate.part,b.cx,b.cy,n));
      assert.ok(ribField(q[0],q[1])<0,'the tab reaches through the wall plate');
    }
    assert.ok(plateField(b.cx+b.w/2+options.minFeature/2,b.cy)<0,'frame material surrounds the tab slot');
  }
  if(sourceX===-38)assert.ok(result.assembly.issues.some(i=>i.ids.includes(short.id)&&i.message.includes('inset is reduced')));
  if(expectedTabs===1){
    near(box(holes[0]).cy,part.part.origin[2]);
    assert.ok(result.assembly.joints.find(j=>j.parts.includes(short.id)).instruction.includes('single centred tab'));
    assert.ok(result.assembly.issues.some(i=>i.ids.includes(short.id)&&i.message.includes('one centred glue tab')));
  }
}
console.log('  ok    short end and middle ribs: fitted pairs or one full-height tab, real frame contact and every rib attached');

for(const sourceX of [-39.7,-41]){
  const features=structuredClone(assembly.features), short=features.find(f=>f.kind==='assembly:rib');
  short.params.sourceX=sourceX;
  const invalid=run(features);
  assert.equal(invalid.assembly.cuttable,false);
  assert.ok(errors(invalid).some(i=>i.ids.includes(short.id)&&i.message.includes('of 9 enabled ribs')),'unattached and empty-source ribs remain in the coverage check');
  if(sourceX===-39.7){
    assert.ok(errors(invalid).some(i=>i.message.includes('even one full-height frame tab')));
    assert.equal(backSlice(invalid),undefined,'never draw a partial frame after dropping an unattachable rib');
  }
  short.enabled=false;
  const disabled=run(features);assert.deepEqual(errors(disabled),[]);
  assert.ok(disabled.assembly.issues.some(i=>i.message==='Wall attachment: 8 of 8 enabled ribs have complete tab joints.'));
}
console.log('  ok    impossible tabs and empty source planes block export; disabled ribs are excluded explicitly');

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

// Minimal solid fills only the frame centre, before any functional cuts.
for(const mount of ['none','screw','keyhole']){
  const features=structuredClone(assembly.features);backFeature(features).params.mount=mount;
  // Also carry a short end rib, a moved rib and mixed stock through both modes.
  features.find(f=>f.kind==='assembly:rib').params.sourceX=-39;
  features.find(f=>f.kind==='assembly:rib'&&f.params.ordinal===4).params.pz=3;
  Object.assign(backFeature(features).params,{ownMaterial:true,thickness:5,kerf:.12});
  const open=run(features), openBack=backSlice(open);
  backFeature(features).params.outline='solid';
  const solid=run(features), solidBack=backSlice(solid);
  assert.deepEqual(errors(open),[]);assert.deepEqual(errors(solid),[]);
  assert.equal(groupContours(solidBack.contours).length,1);
  assert.deepEqual(solidBack.contours.filter(c=>!c.isHole),openBack.contours.filter(c=>!c.isHole),'the outer cut contour is identical');
  const hole=centreHole(openBack), openings=openBack.contours.filter(c=>c.isHole&&c!==hole);
  assert.deepEqual(solidBack.contours.filter(c=>c.isHole),openings,'all tab and mounting cuts are preserved exactly');
  assert.ok(field(openBack)(0,0)>0&&field(solidBack)(0,0)<0,'the actual centre changes from empty to material');
  assert.deepEqual(solid.slices.filter(s=>s.part.kind==='rib'),open.slices.filter(s=>s.part.kind==='rib'),'filling the backplate never changes the ribs');
  assert.deepEqual(solid.assembly.joints,open.assembly.joints);
  backFeature(features).params.outline='frame';
  assert.deepEqual(run(features),open,'switching back restores the complete open frame');
}
const filled=structuredClone(assembly.features);backFeature(filled).params.outline='solid';
const solidNominal=backSlice(run(filled,{kerf:0})), solidKerf=backSlice(run(filled,{kerf:.2}));
near(box(solidKerf.contours.find(c=>!c.isHole)).w-box(solidNominal.contours.find(c=>!c.isHole)).w,.2,.025);
Object.assign(backFeature(filled).params,{mountPlacement:'manual',mountZ:0,mountSpacing:12});
assert.deepEqual(errors(run(filled)),[],'manual mounting holes can use the filled centre');
Object.assign(backFeature(filled).params,{mount:'none',frameWidth:45});
assert.deepEqual(errors(run(filled)),[],'a solid backplate does not require an open centre');
backFeature(filled).params.frameWidth=2;
assert.equal(run(filled).assembly.cuttable,false,'filling keeps the tab edge bridge check');
console.log('  ok    minimal solid: identical outer contour, all functional openings, short ribs, reversible switching, kerf and centre mounting');
console.log('OK    wall frames');
