#!/usr/bin/env node
/** Intentional rib intersections through the real factory and cutting pipeline. */
import assert from 'node:assert/strict';
import { assemblyFeatures, assemblyMember, ribOperation } from '../src/core/assemblyFeatures.ts';
import { runSliceJob } from '../src/core/pipeline.ts';
import { sheetWorld, sheetLocal } from '../src/core/assembly.ts';
import { indexProfile, indexedDistance } from '../src/core/profile2d.ts';
const base={id:'f1',kind:'sphere',stage:'SHAPE',name:'Body',enabled:true,params:{op:'union',r:60}};
const options={thickness:3,kerf:0,spacerHeight:6,resolution:120,tolerance:.025,smoothing:1,minFeature:1.5,seed:7};
const run=(features,patch={})=>runSliceJob({...options,features:[base,...features],...patch},new Map()).set;
const create=()=>assemblyFeatures('linear',2,{min:[-60,-60,-60],max:[60,60,60]});
const errors=s=>s.assembly.issues.filter(i=>i.severity==='error');
const has=(s,text)=>s.assembly.issues.some(i=>i.message.includes(text));
const field=s=>{const index=indexProfile({rings:s.contours.map(c=>c.points),fill:'holes'},1,.025,4);return(x,y)=>indexedDistance(index,x,y);};
const slice=(s,id)=>s.slices.find(p=>p.part.id===id);
const pairFixture=()=>{const a=create();a.features=a.features.filter(f=>f.kind==='assembly:layout'||f.kind==='assembly:rib'&&f.params.ordinal<2);const[x,y]=a.features.slice(1);Object.assign(x.params,{station:0,sourceX:0});Object.assign(y.params,{station:0,sourceX:55,angle:65});return a;};
// Check actual output profiles throughout the target thickness, independently
// of the core's collision sampler. Kerf is zero for physical material checks.
function noSlabOverlap(a,b){
  const fa=field(a),fb=field(b);
  for(let x=-10;x<=10;x+=.5)for(let z=-60;z<=60;z+=.75){
    if(fa(x,z)>-.06)continue;
    for(let i=0;i<=10;i++){
      const p=sheetLocal(b.part,sheetWorld(a.part,x,z,a.part.thickness*(i/10-.5)*.98));
      assert.ok(Math.abs(p[2])>=b.part.thickness/2-.03||fb(p[0],p[1])>=-.06,'finished material must not overlap across either stock thickness');
    }
  }
}
const a=create();a.features.find(f=>f.kind==='assembly:backplate').params.outline='solid';
a.features.find(f=>f.kind==='assembly:rib'&&f.params.ordinal===3).params.angle=-50;
const before=run(a.features), collisions=before.assembly.issues.filter(i=>i.ribCollision);
assert.ok(collisions.length>=3,'the wall fixture contains a rib crossing several neighbours');
for(const issue of collisions){const[x,y]=issue.ribCollision.map(id=>a.features.find(f=>f.id===id));a.features.push(ribOperation(x,y,'cross',a.next++));}
const result=run(a.features);assert.deepEqual(errors(result),[]);
assert.equal(result.assembly.joints.length,9+collisions.length);
assert.ok(has(result,'Wall attachment: 9 of 9'));
assert.ok(has(result,'Rib-network assembly order (wall plate off)'));
assert.ok(has(result,'from behind along assembly +Y'));
assert.ok(result.assembly.joints.filter(j=>j.parts.includes('f12')).every(j=>j.instruction.includes('After assembling')));
assert.deepEqual(slice(result,'f12'),slice(before,'f12'),'cross cuts preserve every backplate opening');
for(const s of result.slices)assert.equal(s.contours.filter(c=>!c.isHole).length,1);
const disabled=structuredClone(a.features);disabled.filter(f=>f.kind==='assembly:joint').forEach(f=>f.enabled=false);
assert.deepEqual(run(disabled),before,'disabling operations restores the entire original assembly');
const transformed=structuredClone(a.features);Object.assign(transformed[0].params,{angle:37,px:11,py:-7,pz:9});
assert.deepEqual(run(transformed).slices.map(s=>s.contours),result.slices.map(s=>s.contours));
console.log('  ok    multiple oblique cross joints, all wall attachments, wall-last order, connected parts and reversible operations');

const pair=pairFixture(),[x,y]=pair.features.slice(1);y.params.sourceX=0;
Object.assign(x.params,{ownMaterial:true,thickness:5,kerf:0});
const cross=ribOperation(x,y,'cross',pair.next++);pair.features.push(cross);
const nominal=run(pair.features);assert.deepEqual(errors(nominal),[]);
noSlabOverlap(slice(nominal,x.id),slice(nominal,y.id));
const fields=[field(slice(nominal,x.id)),field(slice(nominal,y.id))];
assert.ok(fields[0](0,15)>0&&fields[0](0,-15)<0);
assert.ok(fields[1](0,15)<0&&fields[1](0,-15)>0);
const atBoundary=(d,z)=>{let lo=0,hi=15;for(let i=0;i<40;i++){const m=(lo+hi)/2;if(d(m,z)>0)lo=m;else hi=m;}return(lo+hi)/2;};
const radians=y.params.angle*Math.PI/180,fit=pair.features[0].params.jointClearance;
const expected=(options.thickness+2*fit+Math.cos(radians)*x.params.thickness)/Math.sin(radians);
assert.ok(Math.abs(2*atBoundary(fields[0],15)-expected)<.08,'actual width includes both thicknesses and oblique projection');
cross.params.upper='b';const swapped=run(pair.features);assert.deepEqual(errors(swapped),[]);
assert.ok(field(slice(swapped,x.id))(0,15)<0&&field(slice(swapped,y.id))(0,15)>0);
cross.params.upper='a';cross.params.split=65;const shifted=run(pair.features);assert.deepEqual(errors(shifted),[]);
assert.ok(field(slice(shifted,x.id))(0,10)<0,'the split moves the actual closed end');
cross.params.split=50;cross.params.reliefRadius=0;
const square=run(pair.features);assert.notDeepEqual(slice(square,x.id).contours,slice(nominal,x.id).contours);
x.params.kerf=.2;const compensated=run(pair.features,{kerf:.2});
assert.ok(Math.abs(2*(atBoundary(field(slice(square,x.id)),15)-atBoundary(field(slice(compensated,x.id)),15))-.2)<.08,'kerf shrinks the toolpath opening after nominal geometry');
console.log('  ok    real full-thickness fit, mixed stock, measured slot width, opening directions, split, relief and kerf');

for(const [patch,text] of [[{split:0},'Joint split'],[{reliefRadius:10},'tip relief'],[{ribB:'f999'},'missing'],[{ribB:x.id},'same rib'],[{operation:'unknown'},'Unknown rib operation']]){
  const fs=structuredClone(pair.features);Object.assign(fs.at(-1).params,patch);const invalid=run(fs);assert.equal(invalid.assembly.cuttable,false);assert.ok(has(invalid,text));
}
for(const [patch,text] of [[{angle:1},'crossing angle'],[{px:200},'shared band']]){
  const fs=structuredClone(pair.features);Object.assign(fs[2].params,patch);assert.ok(has(run(fs),text));
}
const missing=structuredClone(pair.features);missing[2].enabled=false;assert.ok(has(run(missing),'missing'));
const duplicate=structuredClone(pair.features);duplicate.push({...structuredClone(cross),id:'f99',params:{...cross.params,ribA:y.id,ribB:x.id}});assert.ok(has(run(duplicate),'more than one enabled operation'));
const rings=structuredClone(pair.features);rings.push(assemblyMember('support',rings[0],rings,99));assert.ok(has(run(rings),'Horizontal ring supports'));
// Three separate crossings form a cycle when each rib needs a different
// neighbour removed first. A star with mixed openings is still assemblable.
const trapped=create();trapped.features=trapped.features.filter(f=>f.kind==='assembly:layout'||f.kind==='assembly:rib'&&f.params.ordinal<3);
const cycle=trapped.features.slice(1);cycle.forEach(r=>Object.assign(r.params,{station:0,sourceX:0}));
Object.assign(cycle[1].params,{angle:60,px:20});Object.assign(cycle[2].params,{angle:120,px:-20,py:30});
for(let i=0;i<3;i++){const j=ribOperation(cycle[i],cycle[(i+1)%3],'cross',trapped.next++);j.params.upper='a';trapped.features.push(j);}
assert.ok(has(run(trapped.features),'No straight individual-rib assembly sequence'));
trapped.features.at(-1).params.upper='b';assert.deepEqual(errors(run(trapped.features)),[],'reversing one joint breaks the dependency cycle');
console.log('  ok    explicit refusals for invalid, missing, duplicate, near-parallel and ring-supported joints; trapped assembly order');

const clearance=pairFixture(),[cut,keep]=clearance.features.slice(1),uncut=run(clearance.features);
Object.assign(cut.params,{ownMaterial:true,thickness:5,kerf:0});
const operation=ribOperation(cut,keep,'clearance',clearance.next++);clearance.features.push(operation);
const cleared=run(clearance.features);assert.deepEqual(errors(cleared),[]);
assert.equal(cleared.assembly.joints.length,0);assert.ok(has(cleared,'No rib-to-rib attachment'));
assert.equal(slice(cleared,cut.id).contours.filter(c=>c.isHole).length,1);
assert.deepEqual(slice(cleared,keep.id),slice(uncut,keep.id),'the kept rib is completely unchanged');
noSlabOverlap(slice(cleared,cut.id),slice(cleared,keep.id));
const reversed=structuredClone(clearance.features);Object.assign(reversed.at(-1).params,{ribA:keep.id,ribB:cut.id});
const refused=run(reversed);assert.ok(has(refused,'one connected piece'));
assert.deepEqual(slice(refused,keep.id),slice(uncut,keep.id),'a refused cut is atomic');
const far=structuredClone(clearance.features);far[2].params.px=200;assert.ok(has(run(far),'misses the selected rib'));
// Existing wall joints and newly generated rib slots protect their material
// against a following LED route; the cutter cannot silently sever a joint.
const led=assemblyMember('channel',a.features[0],a.features,a.next++);
Object.assign(led.params,{diameter:8,py:25,open:true});
assert.ok(has(run([...a.features,led]),'conflicts with a joint'));
console.log('  ok    one-rib clearance opening, actual slab clearance, unchanged mate, disconnected-cut refusal and LED joint protection');
console.log('OK    rib intersections');
