#!/usr/bin/env node
/** Real horizontal-stack cross laps, assembly frames, storage and export wiring. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { runSliceJob } from '../src/core/pipeline.ts';
import { defaultParams, findModule } from '../src/core/sdf.ts';
import { indexProfile, indexedDistance } from '../src/core/profile2d.ts';
import { parseProject, serializeProject } from '../src/core/project.ts';
import { buildVerticalSupports } from '../src/core/verticalSupports.ts';
import { traceSheet, minFeatureGap } from '../src/core/slice.ts';
const body = { id:'f1', kind:'cone', stage:'SHAPE', name:'Body', enabled:true,
  params:{...defaultParams(findModule('cone')), r1:60,r2:60,h:45,op:'union'} };
const cavity = {...structuredClone(body),id:'f2',name:'Cavity',params:{...body.params,r1:48,r2:48,h:80,op:'subtract'}};
const support = {id:'f3',kind:'verticalSupports',stage:'RIG',name:'Supports',enabled:true,params:{count:3,depth:12,engagement:4,clearance:.2}};
const job = {features:[body,cavity,support],thickness:3,kerf:.15,spacerHeight:6,resolution:100,tolerance:.03,smoothing:0,minFeature:1.5,seed:1};
const run = (features = job.features, patch={}) => runSliceJob({...job,features,...patch},new Map());
const errors = r => r.set.verticalSupports?.issues.filter(i=>i.severity==='error') ?? [];
const field = contours => {const i=indexProfile({rings:contours.map(c=>c.points),fill:'holes'},1,.02,20);return (x,y)=>indexedDistance(i,x,y);};
const result=run(), set=result.set;
assert.deepEqual(errors(result),[]);
assert.equal(set.verticalSupports.parts.length,support.params.count);
assert.equal(set.verticalSupports.contacts.length,set.slices.length*support.params.count);
const plain=run([body,cavity]);
assert.equal(plain.set.verticalSupports,undefined);
assert.deepEqual(run([body,cavity,{...support,enabled:false}]).set,plain.set,'disabled is exact legacy geometry');
assert.deepEqual(set.slices.map(s=>[s.index,s.z,s.zBottom]),plain.set.slices.map(s=>[s.index,s.z,s.zBottom]));
for(const plate of set.verticalSupports.parts){
  const p=plate.part, d=field(plate.nominalContours), angle=set.verticalSupports.contacts.find(c=>c.id===p.id).angle*Math.PI/180;
  assert.deepEqual(p.v,[0,0,1]);assert.ok(Math.abs(p.u[0]*p.n[0]+p.u[1]*p.n[1])<1e-9);
  for(const contact of set.verticalSupports.contacts.filter(c=>c.id===p.id)){
    const slice=set.slices.find(s=>s.index===contact.layer), sheet=field(slice.nominalContours);
    for(const z of [slice.zBottom+.02,slice.z,slice.zBottom+job.thickness-.02]){
      assert.ok(d(contact.split-.5,z)<0,'spine retains its inner half');
      assert.ok(d(contact.split+.5,z)>0,'outer half has a slot through the complete sheet slab');
    }
    assert.ok(d(contact.split+.5,slice.zBottom-.5)<0,'shoulder holds the layer height');
    for(const side of [-job.thickness/2,0,job.thickness/2]){
      const world=(u,v)=>[Math.cos(angle)*u-Math.sin(angle)*v,Math.sin(angle)*u+Math.cos(angle)*v];
      assert.ok(sheet(...world(contact.split-.5,side))>0,'horizontal slot clears the full spine thickness');
    }
    assert.ok(sheet(Math.cos(angle)*(contact.split+.5),Math.sin(angle)*(contact.split+.5))<0,'horizontal sheet retains the outer half');
  }
}
console.log('  ok    complementary full-thickness slots, height shoulders, frames, all layer contacts and unchanged numbering');
const zero=run(undefined,{kerf:0});
const mismatch=buildVerticalSupports(plain.set,{...zero.set,slices:zero.set.slices.slice(1)},job.features,
 {...job,layerIndices:plain.set.slices.map(s=>s.index)},()=>0,
 {trace:traceSheet,distance:field,thin:(s,t)=>minFeatureGap(s,t).tooThin});
assert.ok(mismatch.verticalSupports.issues.some(i=>i.message.includes('which layers')),'nominal and cut layers must share their identity');
const ext=c=>[Math.min(...c.flatMap(c=>c.points.filter((_,i)=>i%2===0))),Math.max(...c.flatMap(c=>c.points.filter((_,i)=>i%2===0)))];
const cut=ext(set.verticalSupports.parts[0].contours), nominal=ext(zero.set.verticalSupports.parts[0].contours);
assert.ok(Math.abs((nominal[0]-cut[0])-job.kerf/2)<.025);
assert.ok(Math.abs((cut[1]-nominal[1])-job.kerf/2)<.025);
const graded=run(undefined,{spacerHeightTop:12,spacerThickness:1,twistPerLayer:17});assert.deepEqual(errors(graded),[]);
assert.notDeepEqual(graded.set.slices.map(s=>s.z),set.slices.map(s=>s.z));
for(const contact of graded.set.verticalSupports.contacts){
 const slice=graded.set.slices.find(s=>s.index===contact.layer), d=field(slice.nominalContours),a=(contact.angle-(slice.index-1)*17)*Math.PI/180;
 assert.ok(d(Math.cos(a)*(contact.split-.5),Math.sin(a)*(contact.split-.5))>0,'cut slot counter-rotates with layer twist');
}
console.log('  ok    kerf applied once, graded actual layer heights and twist counter-rotation');
const sphere={...body,kind:'sphere',params:{...defaultParams(findModule('sphere')),r:60,px:7,py:-5,op:'union'}};
const hollowSphere={...cavity,kind:'sphere',params:{...sphere.params,r:48,op:'subtract'}};
const sphereLayers=run([sphere,hollowSphere]).set.slices.filter(s=>s.contours.some(c=>c.isHole));
const middle=sphereLayers.slice(1,-1);
const curved=run([sphere,hollowSphere,{...support,params:{...support.params,engagement:6,angle:29,px:7,py:-5,firstLayer:middle[0].index,lastLayer:middle.at(-1).index}}]);
assert.deepEqual(errors(curved),[]);
assert.ok(new Set(curved.set.verticalSupports.contacts.map(c=>c.split.toFixed(1))).size>1,'spines follow the changing cavity');
assert.deepEqual(curved.set.verticalSupports.parts[0].part.origin,[7,-5,0]);
console.log('  ok    curved source, translated centre and conservative radial insertion corridor');
const bad=(params,pattern)=>assert.ok(errors(run([body,cavity,{...support,params:{...support.params,...params}}])).some(i=>pattern.test(i.message)),String(pattern));
bad({depth:46},/centre|insertion/);bad({engagement:15},/wall is too narrow/);bad({count:0},/1–12/);bad({firstLayer:2,lastLayer:2},/at least two/);
bad({px:90,angle:180,count:1},/outside its cavity/);
assert.ok(errors(run([body,support])).some(i=>i.message.includes('centre is closed')));
assert.ok(errors(run(undefined,{spacerHeight:0})).some(i=>i.message.includes('gap')));
assert.ok(errors(run([body,cavity,{...support,params:{...support.params,clearance:.02}}],{thickness:.2})).some(i=>i.message.includes('span is too large')));
const cropped=run([body,cavity,{...support,params:{...support.params,firstLayer:2,lastLayer:4}}]);assert.deepEqual(errors(cropped),[]);
assert.ok(cropped.set.verticalSupports.issues.some(i=>i.severity==='warning'&&i.message.includes('outside')));
const rod={id:'f4',kind:'rod',stage:'RIG',name:'Rod',enabled:true,params:{size:'M5',px:40,py:0,pz:0,length:80}};
assert.ok(errors(run([body,cavity,support,rod])).some(i=>i.message.includes('Rod')));
console.log('  ok    closed centres, crowded insertion, thin walls, short ranges, touching sheets and rod collisions refuse explicitly');
// The user's shelled sphere has closed end discs: Automatic must work without
// guessed layer numbers, even if the saved Manual centre and dimensions are bad.
const shell={id:'f2',kind:'shell',stage:'CARVE',name:'Shell',enabled:true,params:{t:6}};
const autoSupport={...support,params:{...support.params,fit:'auto',px:900,py:-700,depth:400,engagement:500,firstLayer:1,lastLayer:1}};
const automatic=run([sphere,shell,autoSupport]), autoSet=automatic.set, fit=autoSet.verticalSupports.fit;
assert.deepEqual(errors(automatic),[]);
assert.equal(autoSet.verticalSupports.parts.length,autoSupport.params.count);
assert.ok(fit.centre.every((v,i)=>Math.abs(v-[sphere.params.px,sphere.params.py][i])<.03),'centre follows the translated cavity');
const expectedLayers=autoSet.slices.filter(s=>s.index>=fit.firstLayer&&s.index<=fit.lastLayer);
assert.ok(expectedLayers.length>autoSet.slices.length/2);
assert.equal(autoSet.verticalSupports.contacts.length,expectedLayers.length*autoSupport.params.count);
assert.deepEqual(fit.excluded.map(row=>row.layer),autoSet.slices.filter(s=>!expectedLayers.includes(s)).map(s=>s.index));
assert.ok(fit.excluded.length>0,'natural closed ends are reported');
assert.ok(fit.depth[0]<fit.depth[1]&&fit.engagement[0]<fit.engagement[1],'local dimensions adapt to the curvature');
for(const excluded of fit.excluded)assert.ok(autoSet.verticalSupports.issues.some(i=>i.message.includes(excluded.reason)));
// Compare the finished nominal solids, across every stock slab and every spine.
// A shoulder must not grow through a neighbouring ring when the profile changes.
for(const plate of autoSet.verticalSupports.parts){
 const spine=field(plate.nominalContours), [u0,u1]=ext(plate.nominalContours), p=plate.part;
 for(const sheet of expectedLayers){
  const material=field(sheet.nominalContours);
  for(const z of [sheet.zBottom+.03,sheet.z,sheet.zBottom+job.thickness-.03])for(let u=u0;u<=u1;u+=.5){
   if(spine(u,z)>-.03)continue;
   for(const v of [-job.thickness/2,0,job.thickness/2])
    assert.ok(material(p.origin[0]+p.u[0]*u+p.n[0]*v,p.origin[1]+p.u[1]*u+p.n[1]*v)>=-.03,'automatic spine clears each finished sheet through its full thickness');
  }
 }
}
const resized=run([{...sphere,params:{...sphere.params,r:40,px:-11,py:13}},shell,
 {...autoSupport,params:{...autoSupport.params,count:4,angle:31}}],{spacerHeight:3,minFeature:1});
assert.deepEqual(errors(resized),[]);
assert.equal(resized.set.verticalSupports.parts.length,4);
assert.notDeepEqual(resized.set.verticalSupports.fit,fit);
assert.ok(resized.set.verticalSupports.fit.centre.every((v,i)=>Math.abs(v-[-11,13][i])<.03));
assert.ok(resized.set.verticalSupports.contacts.some(c=>c.angle===31));
const interruptedSource={...body,id:'f4',params:{...body.params,r1:55,r2:55,h:3,pz:plain.set.slices[2].z}};
const interrupted=run([body,cavity,interruptedSource,autoSupport]);
assert.ok(errors(interrupted).some(i=>/interior layers are never skipped/.test(i.message)));
assert.equal(interrupted.set.verticalSupports.parts.length,0);
assert.ok(errors(run([sphere,autoSupport])).some(i=>/no cavity/.test(i.message)));
assert.ok(errors(run([body,{...cavity,params:{...cavity.params,r1:56,r2:56}},autoSupport])).some(i=>/wall is too thin/.test(i.message)));
assert.deepEqual(run([body,cavity,{...support,params:{...support.params,fit:'manual'}}]).set,set,'absent fit preserves the legacy manual geometry');
assert.deepEqual(run([sphere,shell,{...autoSupport,enabled:false}]).set,run([sphere,shell]).set);
console.log('  ok    automatic shelled sphere, closed-end report, local fitting, all slab clearances, live centre/size/count/angle, dense layers and interior refusal');
const server=await createServer({configFile:false,server:{middlewareMode:true,watch:null,hmr:false,ws:false},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom'});
try{
 const {useKerros}=await server.ssrLoadModule('/src/core/store.ts');
 const {buildParts,sheetToDxf,manifestText,assemblyDocument}=await server.ssrLoadModule('/src/core/job.ts');
 const {nestByMaterial}=await server.ssrLoadModule('/src/core/nest.ts');
 const {writeDxfR12}=await server.ssrLoadModule('/src/core/dxf.ts');
 const {writePdf}=await server.ssrLoadModule('/src/core/pdf.ts');
 const {VerticalSupportsInspector}=await server.ssrLoadModule('/src/ui/Inspector.tsx');
 const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
 const state=()=>useKerros.getState();
 state().addShape('cone'); state().addVerticalSupports();
 assert.equal(state().mode,'stack');assert.equal(state().panel,'inspector');
 assert.equal(state().features.find(f=>f.kind==='verticalSupports').params.fit,'auto');
 const selected=state().selectedId;state().addVerticalSupports();assert.equal(state().selectedId,selected);assert.equal(state().features.filter(f=>f.kind==='verticalSupports').length,1);
 state().setParam(selected,'angle',27.5);
 const saved=parseProject(serializeProject(state().projectData(),'0.35.0'));assert.ok(saved.ok);assert.deepEqual(saved.warnings,[]);
 state().applyProject(saved.data,saved.nextFeatureNumber);assert.equal(state().features.find(f=>f.id===selected).params.angle,27.5);
 assert.equal(state().features.find(f=>f.id===selected).params.fit,'auto');
 state().selectFeature(selected);
 const html=renderToStaticMarkup(createElement(VerticalSupportsInspector,{feature:support,slices:set,fresh:true}));
 for(const text of ['Vertical supports','Depth into cavity','Joint clearance','layer joints'])assert.ok(html.includes(text),text);
 const autoHtml=renderToStaticMarkup(createElement(VerticalSupportsInspector,{feature:autoSupport,slices:autoSet,fresh:true}));
 for(const text of ['Automatic','Auto-fitted to layers','Fitted dimensions','no vertical support joints'])assert.ok(autoHtml.includes(text),text);
 assert.ok(!autoHtml.includes('Depth into cavity'),'automatic dimensions are derived, not dead editable controls');
 const staleHtml=renderToStaticMarkup(createElement(VerticalSupportsInspector,{feature:autoSupport,slices:autoSet,fresh:false}));
 assert.ok(!staleHtml.includes('Auto-fitted to layers'),'old automatic success is hidden while calculating');
 const parts=buildParts(set,[]), vertical=parts.filter(p=>p.label.startsWith('V'));
 assert.equal(vertical.length,support.params.count);assert.ok(vertical.every(p=>p.layer===undefined));
 const nested=nestByMaterial(parts,{sheetWidth:720,sheetHeight:400,gap:4,labelHeight:3,trueShape:false,cell:2});assert.equal(nested.unplaced.length,0);
 for(const sheet of nested.sheets)assert.ok(!/NaN|Infinity/.test(writeDxfR12(sheetToDxf(sheet))));
 const input={set,sheets:nested.sheets,spacers:[],machineName:'Test',materialName:'Birch',thickness:3,kerf:.15,spacerHeight:6,spacerAchieved:6,version:'0.35.0',projectName:'Stack supports',ringThickness:3};
 assert.match(manifestText(input),/VERTICAL STACK SUPPORTS/);for(const plate of set.verticalSupports.parts)assert.ok(manifestText(input).includes(plate.part.id));
 assert.ok(assemblyDocument(input).length>assemblyDocument({...input,set:plain.set}).length);assert.ok(writePdf(assemblyDocument(input)).startsWith('%PDF'));
 const autoParts=buildParts(autoSet,[]), autoNested=nestByMaterial(autoParts,{sheetWidth:720,sheetHeight:400,gap:4,labelHeight:3,trueShape:false,cell:2});
 assert.equal(autoNested.unplaced.length,0);
 assert.equal(autoParts.filter(p=>p.label.startsWith('V')).length,autoSupport.params.count);
 for(const sheet of autoNested.sheets)assert.ok(!/NaN|Infinity/.test(writeDxfR12(sheetToDxf(sheet))));
 assert.match(manifestText({...input,set:autoSet,sheets:autoNested.sheets}),/Automatic fit: layers/);
 assert.ok(writePdf(assemblyDocument({...input,set:autoSet,sheets:autoNested.sheets})).startsWith('%PDF'));
 const oldSelf=globalThis.self,replies=[];globalThis.self={postMessage(m){replies.push(structuredClone(m));}};
 try{await server.ssrLoadModule('/src/ui/kerros.worker.ts');globalThis.self.onmessage({data:{kind:'slice',token:1,job}});assert.deepEqual(replies.at(-1).output.set,set);globalThis.self.onmessage({data:{kind:'slice',token:2,job:{...job,features:[sphere,shell,autoSupport]}}});assert.deepEqual(replies.at(-1).output.set,autoSet);}finally{globalThis.self=oldSelf;}
 console.log('  ok    reachable inspector, persistent settings, real worker, separate cut parts, nesting, DXF, manifest and PDF');
}finally{await server.close();}
console.log('OK    vertical stack supports');
