#!/usr/bin/env node
/** Actual assembly kernel and pipeline, including the oblique full-sheet envelope. */
import assert from 'node:assert/strict';
import { runSliceJob } from '../src/core/pipeline.ts';
import { assemblyFeatures, assemblyMember } from '../src/core/assemblyFeatures.ts';
import { dot3, cross3, sheetLocal, sheetWorld, prismOpening, channelFrame, channelAngles } from '../src/core/assembly.ts';
import { Euler, Quaternion, Vector3 } from 'three';
import { groupContours, traceSheet } from '../src/core/slice.ts';
import { indexProfile, indexedDistance } from '../src/core/profile2d.ts';
const near = (a,b,t=1e-7) => assert.ok(Math.abs(a-b)<=t, `${a} != ${b} (tol ${t})`);
const frame = { id:'r', label:'R', kind:'rib', origin:[0,0,0], u:[0,1,0], v:[0,0,1], n:[1,0,0], thickness:6, kerf:.2, material:'test' };
assert.deepEqual(sheetLocal(frame,sheetWorld(frame,10,-12,3)),[10,-12,3]);
assert.deepEqual(cross3(frame.u,frame.v),frame.n);
near(dot3(frame.u,frame.n),0);
const theta=75*Math.PI/180, d=[Math.cos(theta),Math.sin(theta),0], a=[-Math.sin(theta),Math.cos(theta),0];
const polygon=prismOpening(frame,d.map(v=>v*-100),d.map(v=>v*100),a,[0,0,1],[-4,-2,4,-2,4,2,-4,2]);
const xs=polygon.filter((_,i)=>i%2===0), ys=polygon.filter((_,i)=>i%2===1);
// The width includes both the oblique section and its travel through the slab.
near(Math.max(...xs)-Math.min(...xs),8/Math.cos(theta)+frame.thickness*Math.tan(theta));
near(Math.max(...ys)-Math.min(...ys),4);
console.log('  ok    orthonormal frames and full-thickness oblique prism projection');

// Exercise the same quaternion delta as the viewport, including both poles,
// the section-reference switch at |direction.z|=.95, and a rotated layout.
const vectorNear = (a,b) => a.forEach((value,i)=>near(value,b[i]));
for (const yaw of [-370,0,47,180]) for (const elevation of [-90,-89.999,-72,-71,0,71,72,89.999,90,130]) {
  const original=channelFrame(yaw,elevation,33);
  for (const layoutAngle of [0,37]) for (const delta of [new Quaternion(),new Quaternion().setFromEuler(new Euler(.3,-.7,1.1,'ZYX'))]) {
    const world = vector => new Vector3(...vector).applyAxisAngle(new Vector3(0,0,1),layoutAngle*Math.PI/180).applyQuaternion(delta).toArray();
    const u=world(original.u),v=world(original.v);
    const angles=channelAngles(u,v,layoutAngle);
    const recovered=channelFrame(angles.yaw,angles.elevation,angles.roll);
    const toWorld = vector => new Vector3(...vector).applyAxisAngle(new Vector3(0,0,1),layoutAngle*Math.PI/180).toArray();
    vectorNear(toWorld(recovered.u),u);vectorNear(toWorld(recovered.v),v);
    vectorNear(toWorld(recovered.direction),world(original.direction));
  }
}
console.log('  ok    channel gizmo quaternion roundtrips, vertical poles, section roll and rotated layout');

const base={id:'f1',kind:'roundBox',stage:'SHAPE',name:'Body',enabled:true,params:{op:'union',sx:140,sy:120,sz:200,pz:100,r:4}};
const options={thickness:3,kerf:.2,spacerHeight:6,resolution:120,tolerance:.025,smoothing:1,minFeature:1,seed:7};
const bounds={min:[-70,-60,0],max:[70,60,200]};
const create=(kind)=>assemblyFeatures(kind,2,bounds);
const run=(features,overrides={})=>runSliceJob({...options,features:[base,...features],...overrides},new Map()).set;
const errors=set=>set.assembly.issues.filter(i=>i.severity==='error');
const linear=create('linear');
const layout=linear.features[0], back=linear.features.find(f=>f.kind==='assembly:backplate');
const led=assemblyMember('channel',layout,linear.features,linear.next++);
linear.features.push(led);
let set=run(linear.features);
assert.deepEqual(errors(set),[]);
assert.equal(set.slices.length,10);
assert.equal(set.assembly.channels[0].hits.length,9);
assert.equal(set.assembly.joints.length,9);
const first=set.slices.find(s=>s.part.kind==='rib');
const holes=groupContours(first.contours)[0].holes;
assert.equal(holes.length,1);
const holeBox=points=>{const x=points.filter((_,i)=>i%2===0),y=points.filter((_,i)=>i%2===1);return {w:Math.max(...x)-Math.min(...x),h:Math.max(...y)-Math.min(...y)}};
// Component diameter plus two allowances, minus laser width on the cut path.
near(holeBox(holes[0].points).w,Number(led.params.diameter)+2*Number(led.params.clearance)-options.kerf,.08);
assert.equal(set.slices.find(s=>s.part.kind==='backplate').contours.filter(c=>c.isHole).length,20,'two tabs per rib plus two screw holes');
console.log('  ok    glued tabs, screw holes, aligned LED bores, clearance separate from kerf');
const beforeGlobal=set;
layout.params.angle=37;layout.params.px=11;
set=run(linear.features);
assert.deepEqual(set.slices.map(s=>s.contours),beforeGlobal.slices.map(s=>s.contours));
near(set.assembly.channels[0].u[0],-Math.sin(37*Math.PI/180));
assert.notDeepEqual(set.assembly.channels[0].start,beforeGlobal.assembly.channels[0].start);
layout.params.angle=0;layout.params.px=0;
led.params.targetIds=first.part.id;
set=run(linear.features);
assert.ok(errors(set).some(i=>i.message.includes('excluded part obstructs')));
const excludedId=beforeGlobal.slices[1].part.id;
assert.deepEqual(set.slices.find(s=>s.part.id===excludedId).contours,run(linear.features.filter(f=>f!==led)).slices.find(s=>s.part.id===excludedId).contours,'excluded parts are not cut');
led.params.targetIds='';
console.log('  ok    whole-layout route transforms and untouched, obstructing excluded parts');

const moved=structuredClone(linear.features), movedLayout=moved[0], movedLed=moved.find(f=>f.id===led.id);
Object.assign(movedLayout.params,{angle:37,px:11,py:-9,pz:6});
Object.assign(movedLed.params,{px:17,py:24,pz:7});
const requested=channelFrame(5,4,19);
const toWorld = vector => new Vector3(...vector).applyAxisAngle(new Vector3(0,0,1),37*Math.PI/180).toArray();
Object.assign(movedLed.params,channelAngles(toWorld(requested.u),toWorld(requested.v),37));
const movedSet=run(moved), movedChannel=movedSet.assembly.channels[0];
assert.deepEqual(errors(movedSet),[]);assert.equal(movedChannel.hits.length,9);
vectorNear(movedChannel.localOrigin,[17,24,7]);
vectorNear(movedChannel.origin,toWorld(movedChannel.localOrigin).map((v,i)=>v+[11,-9,106][i]));
assert.ok(Math.hypot(...movedChannel.origin.map((v,i)=>v-(movedChannel.start[i]+movedChannel.end[i])/2))>1,'fitted midpoint must not replace the route anchor');
for (const slice of movedSet.slices.filter(s=>s.part.kind==='rib')) {
  const part=slice.part,d=cross3(movedChannel.u,movedChannel.v);
  const t=dot3(part.origin.map((v,i)=>v-movedChannel.origin[i]),part.n)/dot3(d,part.n);
  const centre=sheetLocal(part,movedChannel.origin.map((v,i)=>v+t*d[i]));
  const points=groupContours(slice.contours)[0].holes[0].points;
  for (let axis=0;axis<2;axis++) { const values=points.filter((_,i)=>i%2===axis);near((Math.max(...values)+Math.min(...values))/2,centre[axis],.05); }
}
console.log('  ok    moved and rotated channel anchor and actual bore centres agree in all ribs');

const plain=structuredClone(linear.features).filter(f=>f.kind!=='assembly:channel');
plain.find(f=>f.kind==='assembly:backplate').enabled=false;
const beforeMove=run(plain);
plain.find(f=>f.kind==='assembly:rib').params.px=17;
plain.find(f=>f.kind==='assembly:rib').params.angle=31;
const afterMove=run(plain);
assert.deepEqual(beforeMove.slices[0].contours,afterMove.slices[0].contours,'placement must not recut the source profile');
assert.notDeepEqual(beforeMove.slices[0].part.origin,afterMove.slices[0].part.origin);
console.log('  ok    manual placement preserves the unjointed source profile');

layout.params.ribAngle=25; back.params.ownMaterial=true; back.params.thickness=6; back.params.kerf=.12;
set=run(linear.features);
assert.deepEqual(errors(set),[]);
const oblique=set.slices.find(s=>s.part.kind==='rib');
const widened=holeBox(groupContours(oblique.contours)[0].holes[0].points);
near(widened.w,(Number(led.params.diameter)+2*Number(led.params.clearance))/Math.cos(25*Math.PI/180)+options.thickness*Math.tan(25*Math.PI/180)-options.kerf,.1);
assert.ok(set.slices.find(s=>s.part.kind==='backplate').part.material.includes('6 mm'));
console.log('  ok    oblique LED cuts and angle-aware wall slots with different stock thicknesses');

layout.params.ribAngle=0;
led.params.shape='strip'; led.params.width=12;led.params.height=5;led.params.cornerRadius=1;led.params.roll=20;
set=run(linear.features); assert.deepEqual(errors(set),[]); assert.equal(set.assembly.channels[0].hits.length,9);
led.params.through=false;led.params.length=1;
set=run(linear.features);assert.ok(errors(set).some(i=>i.message.includes('ends inside')));
led.params.through=true;led.params.py=59;led.params.roll=0;
set=run(linear.features); assert.ok(errors(set).some(i=>i.message.includes('closed LED opening')));
led.params.open=true;led.params.openAngle=0;
set=run(linear.features);assert.deepEqual(errors(set),[]);assert.equal(set.assembly.channels[0].hits.length,9);
led.params.open=false;led.params.py=0;led.params.pz=Number(back.params.tabSpacing)/2;
set=run(linear.features);assert.ok(errors(set).some(i=>i.ids.includes(led.id)),'a channel cannot quietly remove a wall joint');
led.params.targetIds='f999';set=run(linear.features);assert.ok(errors(set).some(i=>i.ids.includes('f999')));
led.params.targetIds='';led.enabled=false;set=run(linear.features);assert.equal(set.assembly.channels[0].status,'Disabled; no cuts applied.');
console.log('  ok    strip roll, finite ends, edge-open notches, joint conflicts and stale targets');

const radial=create('radial');
set=run(radial.features);assert.deepEqual(errors(set),[]);assert.equal(set.assembly.joints.length,24);
const support=radial.features.find(f=>f.kind==='assembly:support');
support.params.ownMaterial=true;support.params.thickness=5;support.params.kerf=.1;
set=run(radial.features);assert.deepEqual(errors(set),[]);
support.params.outerDiameter=20;support.params.innerDiameter=0;
set=run(radial.features);assert.ok(errors(set).some(i=>i.message.includes('No usable cross-slot contact')));
console.log('  ok    radial half slots, assembly order, mixed thickness and missing contacts');

const legacy=run([]);
radial.features[0].enabled=false;
assert.deepEqual(run(radial.features),legacy,'disabled assemblies must leave legacy layer output unchanged');
// Redistancing is in the sheet plane, independent of a 3D surface gradient.
const source=traceSheet((x,y)=>Math.hypot(x,y*.5)-10,{minX:-12,maxX:12,minY:-22,maxY:22},.08);
const index=indexProfile({rings:source.map(c=>c.points),fill:'holes'},1,.06,2);
const final=traceSheet((x,y)=>indexedDistance(index,x,y),{minX:-12,maxX:12,minY:-22,maxY:22},.08,.1);
near(holeBox(final[0].points).h-holeBox(source[0].points).h,.2,.015);
console.log('  ok    legacy output identity and in-plane kerf after redistancing');
console.log('OK    upright assemblies');
