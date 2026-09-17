#!/usr/bin/env node
/** Closed support sockets use real cuts, cap insertion and the full export path. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { runSliceJob, profileVolume } from '../src/core/pipeline.ts';
import { assemblyFeatures, assemblyMember } from '../src/core/assemblyFeatures.ts';
import { sheetLocal, sheetWorld } from '../src/core/assembly.ts';
import { indexProfile, indexedDistance } from '../src/core/profile2d.ts';

const nodes=points=>points.map(point=>({point,incoming:[0,0],outgoing:[0,0],smooth:false}));
const radius=60,height=200;
const body={id:'f1',kind:'profile',stage:'SHAPE',name:'Socket body',enabled:true,
  params:{profileMode:'radial',axisX:0,op:'union',k:0,round:0},
  sketch:{base:[nodes([[0,-height/2],[radius,-height/2],[radius,height/2],[0,height/2]])],keys:[],nextKey:1}};
const volume=profileVolume(body),created=assemblyFeatures('radial',2,{min:volume.min,max:volume.max});
const original=[body,...created.features];
const supportIds=created.features.filter(f=>f.kind==='assembly:support').map(f=>f.id),topId=supportIds[1],bottomId=supportIds[0];
const options={thickness:3,kerf:.15,materialName:'Test',spacerHeight:6,resolution:120,tolerance:.025,smoothing:0,minFeature:1,seed:1};
const run=(features,patch={})=>runSliceJob({...options,...patch,features},new Map()).set;
const errors=set=>set.assembly.issues.filter(i=>i.severity==='error');
const feature=(features,id)=>features.find(f=>f.id===id);
const part=(set,id)=>set.slices.find(s=>s.part.id===id);
const near=(a,b,t=.035)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b} (tolerance ${t})`);
const distance=slice=>{const index=indexProfile({rings:slice.nominalContours.map(c=>c.points),fill:'holes'},1,.1,300);return(x,y)=>indexedDistance(index,x,y);};
const capped=structuredClone(original);
Object.assign(feature(capped,topId).params,{jointStyle:'sockets',socketSide:'top',socketWidth:8,socketRelief:.5,pz:80,outerDiameter:180,innerDiameter:0});
const set=run(capped);assert.deepEqual(errors(set),[]);
const top=part(set,topId),ribSlices=set.slices.filter(s=>s.part.kind==='rib');
assert.equal(top.nominalContours.filter(c=>c.isHole).length,ribSlices.length,'one enclosed socket for each rib');
assert.equal(top.nominalContours.filter(c=>!c.isHole).length,1);
assert.equal(set.assembly.joints.length,ribSlices.length*2);
assert.ok(part(set,bottomId).nominalContours.some(c=>c.isHole),'the other support retains its centre opening');
const capDistance=distance(top),outsideRadius=Number(feature(capped,topId).params.outerDiameter)/2;
const tabCentres=new Map();
for(let angle=0;angle<Math.PI*2;angle+=.015)assert.ok(capDistance((outsideRadius-1)*Math.cos(angle),(outsideRadius-1)*Math.sin(angle))<0,'the full outer rim is intact');
for(const rib of ribSlices){
  const d=distance(rib),z=sheetLocal(rib.part,top.part.origin)[1],tip=z+top.part.thickness/2;
  const maxY=Math.max(...rib.nominalContours.flatMap(c=>c.points.filter((_,i)=>i%2===1)));near(maxY,tip);
  const contact=set.assembly.joints.find(j=>j.parts.includes(rib.part.id)&&j.parts.includes(topId));assert.match(contact.instruction,/from above along -Z/);
  const xs=rib.nominalContours.flatMap(c=>c.points.filter((_,i)=>i%2===0));
  const hits=[];for(let x=Math.min(...xs);x<=Math.max(...xs);x+=.1)if(d(x,z)<0)hits.push(x);
  near(hits.at(-1)-hits[0],feature(capped,topId).params.socketWidth,.15);
  const mid=(hits[0]+hits.at(-1))/2,world=sheetWorld(rib.part,mid,z);
  tabCentres.set(rib.part.id,world);
  const socket=sheetLocal(top.part,world);assert.ok(capDistance(socket[0],socket[1])>0,'the actual tab centre lies inside its enclosed socket');
  assert.ok(d(mid,tip+1)>0,'no original rib material remains beyond the flush tab');
}
assert.ok(set.assembly.issues.some(i=>/After the ribs.*closed-socket/.test(i.message)));
const reverted=structuredClone(capped);feature(reverted,topId).params.jointStyle='slots';
const legacySame=structuredClone(reverted);delete feature(legacySame,topId).params.jointStyle;
assert.deepEqual(run(reverted),run(legacySame),'missing style and explicit Cross slots retain identical legacy geometry');
console.log('  ok    complete enclosed sockets, intact rim, fitted flush tabs, mixed cross slots and cap-last sequence');

const both=structuredClone(capped);Object.assign(feature(both,bottomId).params,{jointStyle:'sockets',socketSide:'bottom',socketWidth:8,socketRelief:.5,pz:-80});
const paired=run(both);assert.deepEqual(errors(paired),[]);assert.equal(part(paired,bottomId).nominalContours.filter(c=>c.isHole).length,ribSlices.length+1);
assert.ok(paired.assembly.joints.some(j=>/from below along \+Z/.test(j.instruction)));
const mixed=structuredClone(capped);Object.assign(feature(mixed,topId).params,{ownMaterial:true,thickness:5,kerf:.2});
const ribId=ribSlices[0].part.id;Object.assign(feature(mixed,ribId).params,{ownMaterial:true,thickness:4,kerf:.12,angle:9,px:1});
const mixedSet=run(mixed);assert.deepEqual(errors(mixedSet),[]);
const mixedTop=part(mixedSet,topId),nominalHole=mixedTop.nominalContours.filter(c=>c.isHole),cutHole=mixedTop.contours.filter(c=>c.isHole);
assert.equal(nominalHole.length,cutHole.length);
const box=contour=>{const xs=contour.points.filter((_,i)=>i%2===0),ys=contour.points.filter((_,i)=>i%2===1);return{cx:(Math.min(...xs)+Math.max(...xs))/2,cy:(Math.min(...ys)+Math.max(...ys))/2,w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)};};
const aligned=nominalHole.find(c=>Math.abs(box(c).cx)<1&&box(c).cy>0),alignedBox=box(aligned);
const cutAligned=cutHole.reduce((a,b)=>Math.hypot(box(a).cx-alignedBox.cx,box(a).cy-alignedBox.cy)<Math.hypot(box(b).cx-alignedBox.cx,box(b).cy-alignedBox.cy)?a:b);
near(alignedBox.w-box(cutAligned).w,mixedTop.part.kerf,.05);
const shifted=structuredClone(capped);Object.assign(feature(shifted,created.id).params,{angle:31,px:17,py:-11,pz:5});
assert.deepEqual(run(shifted).slices.map(s=>s.contours),set.slices.map(s=>s.contours));
const curved=structuredClone(capped);curved[0].sketch.base=[nodes([[0,-100],[60,-100],[42,-25],[48,35],[55,100],[0,100]])];
const curvedSet=run(curved);assert.deepEqual(errors(curvedSet),[]);assert.notDeepEqual(part(curvedSet,topId).contours,top.contours,'socket positions follow edited rib shoulders');
const linearBody={id:'f1',kind:'roundBox',stage:'SHAPE',name:'Linear body',enabled:true,params:{op:'union',sx:140,sy:120,sz:200,r:0}};
const linear=assemblyFeatures('linear',2,{min:[-70,-60,-100],max:[70,60,100]});
const linearFeatures=[linearBody,...linear.features.filter(f=>f.kind!=='assembly:backplate')];
for(const side of ['top','bottom']){
  const cap=assemblyMember('support',linear.features[0],linearFeatures,linear.next++);
  Object.assign(cap.params,{jointStyle:'sockets',socketSide:side,pz:side==='top'?80:-80,outerDiameter:200,innerDiameter:0});linearFeatures.push(cap);
}
const linearSet=run(linearFeatures);assert.deepEqual(errors(linearSet),[]);assert.equal(linearSet.assembly.joints.length,18);
console.log('  ok    top/bottom caps, ring centre preserved, mixed stock, moved/rotated rib, kerf, rigid transforms, curved source edits and linear layouts');

const badWidth=structuredClone(capped);feature(badWidth,topId).params.socketWidth=90;
const widthSet=run(badWidth);assert.ok(errors(widthSet).some(i=>/No 90 mm tab/.test(i.message)));assert.equal(widthSet.assembly.joints.filter(j=>j.parts.includes(topId)).length,0);
assert.ok(!widthSet.assembly.issues.some(i=>/install closed-socket end plates in this order/.test(i.message)),'an unfitted cap must not claim an insertion order');
const missing=structuredClone(capped);feature(missing,ribId).params.pz=-300;
assert.ok(errors(run(missing)).some(i=>i.ids.includes(topId)&&/of 12 enabled ribs could be fitted/.test(i.message)));
const duplicate=structuredClone(capped),extra=assemblyMember('support',created.features[0],duplicate,created.next);
Object.assign(extra.params,{...feature(duplicate,topId).params,pz:85});duplicate.push(extra);
assert.ok(errors(run(duplicate)).some(i=>/at most one/.test(i.message)));
const tooClose=structuredClone(capped);feature(tooClose,bottomId).params.pz=feature(tooClose,topId).params.pz-2;
assert.ok(errors(run(tooClose)).some(i=>/damage an existing tab/.test(i.message)||/No usable cross-slot/.test(i.message)));
const obstructed=structuredClone(capped),obstacle=assemblyMember('plate',created.features[0],obstructed,created.next);
Object.assign(obstacle.params,{plateX:0,plateY:0,plateZ:120,plateRx:0,plateWidth:200,plateHeight:200,ownMaterial:true,thickness:.2,kerf:0});obstructed.push(obstacle);
assert.ok(errors(run(obstructed)).some(i=>i.ids.includes(obstacle.id)&&/end plate cannot slide/.test(i.message)),'a thin parallel obstacle cannot fall between sweep samples');
const damaged=structuredClone(capped),channel=assemblyMember('channel',created.features[0],damaged,created.next),tabCentre=tabCentres.get(ribId),ribFrame=part(set,ribId).part;
Object.assign(channel.params,{diameter:.5,clearance:0,px:tabCentre[0],py:tabCentre[1],pz:tabCentre[2],yaw:Math.atan2(ribFrame.n[1],ribFrame.n[0])*180/Math.PI,elevation:0,targetIds:ribId});damaged.push(channel);
const protectedSet=run(damaged);assert.ok(errors(protectedSet).some(i=>i.ids.includes(channel.id)&&/joint/.test(i.message)));
assert.deepEqual(part(protectedSet,ribId).contours,part(set,ribId).contours,'a channel cannot drill away a cap tab');
console.log('  ok    oversized tabs, missing contact, duplicate ends, joint conflicts and blocked insertion refuse explicitly');

// Read tab widths from the actual cut edges, not from the fitter's plans.
const tabBands=(rib,cap)=>{
  const z=sheetLocal(rib.part,cap.part.origin)[1],crossings=[];
  for(const c of rib.nominalContours)for(let i=0;i<c.points.length;i+=2){
    const j=(i+2)%c.points.length,[x,y]=c.points.slice(i,i+2),[xx,yy]=c.points.slice(j,j+2);
    if((y>z)!==(yy>z))crossings.push(x+(xx-x)*(z-y)/(yy-y));
  }
  crossings.sort((a,b)=>a-b);assert.equal(crossings.length%2,0);
  return crossings.filter((_,i)=>i%2===0).map((x,i)=>[x,crossings[i*2+1]]);
};
const square=structuredClone(mixed);
Object.assign(feature(square,topId).params,{socketSizing:'stock',socketCount:'auto',socketRelief:0});
const squareSet=run(square);assert.deepEqual(errors(squareSet),[]);
const squareCap=part(squareSet,topId),squareDistance=distance(squareCap);
let totalTabs=0;
for(const rib of squareSet.slices.filter(s=>s.part.kind==='rib')){
  const bands=tabBands(rib,squareCap),d=distance(rib),z=sheetLocal(rib.part,squareCap.part.origin)[1];
  assert.ok(bands.length>=1&&bands.length<=4);totalTabs+=bands.length;
  for(const [a,b] of bands){
    near(b-a,rib.part.thickness,.05);
    assert.ok(d((a+b)/2,z+squareCap.part.thickness/2+.2)>0,'tabs stop at the outer cap face');
    assert.ok(d((a+b)/2,z+squareCap.part.thickness/2-.2)<0,'tabs reach through the actual cap stock');
    for(const x of [a+.05,(a+b)/2,b-.05])for(const n of [-rib.part.thickness/2,0,rib.part.thickness/2]){
      const q=sheetLocal(squareCap.part,sheetWorld(rib.part,x,z,n));
      assert.ok(squareDistance(q[0],q[1])>0,'every tab fits inside its actual enclosed socket');
    }
  }
  for(let i=1;i<bands.length;i++)assert.ok(bands[i][0]-bands[i-1][1]>options.minFeature,'separate tabs leave an intact bridge');
  const joint=squareSet.assembly.joints.find(j=>j.parts.includes(topId)&&j.parts.includes(rib.part.id));
  assert.ok(joint.instruction.includes(`${rib.part.thickness} mm square tab`));
}
assert.ok(totalTabs>ribSlices.length,'wide ribs get multiple tabs');
assert.equal(squareCap.nominalContours.filter(c=>c.isHole).length,totalTabs);
assert.ok(squareSet.assembly.issues.some(i=>i.message.includes(`(${totalTabs} tabs total)`)));
const fixed=structuredClone(capped);Object.assign(feature(fixed,topId).params,{socketSizing:'stock',socketCount:'2'});
const fixedSet=run(fixed);assert.deepEqual(errors(fixedSet),[]);
assert.equal(part(fixedSet,topId).nominalContours.filter(c=>c.isHole).length,ribSlices.length*2);
const wide=structuredClone(fixed);feature(wide,topId).params.socketCount='auto';feature(wide,created.id).params.ribDepth=40;
const wideSet=run(wide);assert.deepEqual(errors(wideSet),[]);
assert.equal(part(wideSet,topId).nominalContours.filter(c=>c.isHole).length,ribSlices.length*4);
// A tapered tip visibly overlaps the cap, yet a cross slot cannot fit there.
const peak=structuredClone(capped);peak[0].sketch.base=[nodes([[0,-100],[60,-100],[68,90],[50,100],[32,90],[0,90]])];
Object.assign(feature(peak,topId).params,{jointStyle:'slots',pz:99});
assert.ok(errors(run(peak)).some(i=>/No usable cross-slot.*Closed sockets/.test(i.message)));
Object.assign(feature(peak,topId).params,{jointStyle:'sockets',socketSizing:'stock',socketCount:'auto'});
const peakSet=run(peak);assert.deepEqual(errors(peakSet),[]);
assert.equal(part(peakSet,topId).nominalContours.filter(c=>c.isHole).length,ribSlices.length,'narrow shoulders automatically retain one tab');
feature(peak,topId).params.socketCount='4';
const refusedCount=run(peak);assert.ok(errors(refusedCount).some(i=>/Requested 4 tabs.*only [1-3] fit/.test(i.message)));
assert.equal(refusedCount.assembly.joints.filter(j=>j.parts.includes(topId)).length,0,'an exact count never silently falls back');
assert.equal(part(refusedCount,topId).nominalContours.filter(c=>c.isHole).length,0,'a failed cap applies no partial sockets');
const squareDamage=structuredClone(square),multiChannel=structuredClone(channel),squareRib=part(squareSet,ribId),lastBand=tabBands(squareRib,squareCap).at(-1);
const lastCentre=sheetWorld(squareRib.part,(lastBand[0]+lastBand[1])/2,sheetLocal(squareRib.part,squareCap.part.origin)[1]);
Object.assign(multiChannel.params,{px:lastCentre[0],py:lastCentre[1],pz:lastCentre[2],yaw:Math.atan2(squareRib.part.n[1],squareRib.part.n[0])*180/Math.PI});squareDamage.push(multiChannel);
assert.ok(errors(run(squareDamage)).some(i=>i.ids.includes(multiChannel.id)&&/joint/.test(i.message)),'every additional tab is protected');
console.log('  ok    square stock-sized tabs, mixed thickness, automatic 1/2/4 fitting, exact counts, shallow tips and multiple protected joints');

const server=await createServer({configFile:false,server:{middlewareMode:true,watch:null,hmr:false,ws:false},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom'});
try{
  const {useKerros}=await server.ssrLoadModule('/src/core/store.ts');
  const {parseProject,serializeProject}=await server.ssrLoadModule('/src/core/project.ts');
  const {AssemblyInspector}=await server.ssrLoadModule('/src/ui/AssemblyInspector.tsx');
  const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
  const state=()=>useKerros.getState(),data={...state().projectData(),features:capped,nextFeatureNumber:created.next};
  const saved=parseProject(serializeProject(data,'test','2026-09-17'));assert.equal(saved.ok,true);assert.deepEqual(saved.warnings,[]);
  state().applyProject(saved.data,saved.nextFeatureNumber);assert.deepEqual(state().features,capped);assert.deepEqual(run(state().features),set);
  const inspector=renderToStaticMarkup(createElement(AssemblyInspector,{feature:feature(capped,topId),set,pending:false}));
  for(const text of ['Joint type','Cross slots','Closed sockets','Install from','Tab width','Socket corner relief','trims ribs above'])assert.ok(inspector.includes(text),text);
  const savedSquare=parseProject(serializeProject({...data,features:square},'test','2026-09-17'));assert.equal(savedSquare.ok,true);assert.deepEqual(savedSquare.data.features,square);
  state().applyProject(savedSquare.data,savedSquare.nextFeatureNumber);
  const squareInspector=renderToStaticMarkup(createElement(AssemblyInspector,{feature:feature(square,topId),set:squareSet,pending:false}));
  for(const text of ['Tab size','Match rib thickness','Tabs per rib','Automatic (1–4)','Square tabs in plan'])assert.ok(squareInspector.includes(text),text);
  assert.ok(!squareInspector.includes('Tab width</span>'),'inactive custom width is hidden for stock-sized tabs');
  const {buildParts,sheetToDxf,manifestText,assemblyDocument}=await server.ssrLoadModule('/src/core/job.ts');
  const {nestByMaterial}=await server.ssrLoadModule('/src/core/nest.ts');
  const {writeDxfR12}=await server.ssrLoadModule('/src/core/dxf.ts');
  const {writePdf}=await server.ssrLoadModule('/src/core/pdf.ts');
  const parts=buildParts(squareSet,[]),nested=nestByMaterial(parts,{sheetWidth:720,sheetHeight:400,gap:4,labelHeight:3,trueShape:false,cell:2});
  assert.equal(parts.length,squareSet.slices.length);assert.equal(nested.unplaced.length,0);
  for(const sheet of nested.sheets)assert.ok(!/NaN|Infinity/.test(writeDxfR12(sheetToDxf(sheet))));
  const input={set:squareSet,sheets:nested.sheets,spacers:[],machineName:'Test',materialName:'Test',thickness:3,kerf:.15,spacerHeight:6,spacerAchieved:6,ringThickness:3,version:'test',projectName:'Closed sockets'};
  assert.match(manifestText(input),/fit S\d+ from above along -Z/);
  assert.match(manifestText(input),/2 3 mm square tabs/);
  const pdf=writePdf(assemblyDocument(input));assert.ok(pdf.startsWith('%PDF'));
  const changedInstructions=structuredClone(input);changedInstructions.set.assembly.joints.find(j=>j.parts.includes(topId)).instruction='Different assembly instruction';
  assert.notEqual(writePdf(assemblyDocument(changedInstructions)),pdf,'PDF consumes the actual cap instructions');
  const oldSelf=globalThis.self,replies=[];globalThis.self={postMessage(reply){replies.push(structuredClone(reply));}};
  try{await server.ssrLoadModule('/src/ui/kerros.worker.ts');globalThis.self.onmessage({data:{kind:'slice',token:1,job:{...options,features:square}}});assert.deepEqual(replies.at(-1).output.set,squareSet);}finally{globalThis.self=oldSelf;}
  console.log('  ok    durable per-support mode, reachable controls, worker parity, nesting, DXF, manifest and PDF instructions');
}finally{await server.close();}
console.log('OK    closed support sockets and end-plate insertion');
