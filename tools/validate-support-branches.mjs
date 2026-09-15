#!/usr/bin/env node
/** Real shared-sheet joints, coverage, adjustable density and manufacturing paths. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { runSliceJob } from '../src/core/pipeline.ts';
import { defaultParams, findModule } from '../src/core/sdf.ts';
import { indexProfile, indexedDistance } from '../src/core/profile2d.ts';
import { groupContours, minFeatureGap, traceSheet } from '../src/core/slice.ts';
import { supportCollision } from '../src/core/supportBranches.ts';
import { parseProject, serializeProject } from '../src/core/project.ts';

const shape=(id,kind,params)=>({id,kind,name:id,stage:'SHAPE',enabled:true,params:{...defaultParams(findModule(kind)),...params}});
const features=[shape('base','cone',{r1:60,r2:60,h:100,pz:-40}),
  shape('left','sphere',{r:45,px:-30,pz:25,op:'union'}),shape('right','sphere',{r:45,px:30,pz:25,op:'union'}),
  {id:'shell',kind:'shell',name:'Shell',stage:'CARVE',enabled:true,params:{t:8}},
  {id:'supports',kind:'verticalSupports',name:'Supports',stage:'RIG',enabled:true,params:{fit:'auto',count:3,branchCount:1,clearance:.2,angle:0}}];
const job={features,thickness:3,kerf:.15,spacerHeight:8,resolution:140,tolerance:.02,smoothing:0,minFeature:1,seed:1};
const run=(patch={})=>runSliceJob({...job,...patch},new Map()).set;
const errors=set=>set.verticalSupports?.issues.filter(i=>i.severity==='error')??[];
const field=(contours,reach=2)=>{const index=indexProfile({rings:contours.map(c=>c.points),fill:'holes'},1,.02,reach);return(x,y)=>indexedDistance(index,x,y)};
const kernel={distance:field,trace:traceSheet,thin:(s,n)=>minFeatureGap(s,n).tooThin};
const plain=run({features:features.slice(0,-1)}), minimal=run(), report=minimal.verticalSupports;
assert.deepEqual(errors(minimal),[]);assert.equal(report.parts.length,3);
assert.deepEqual(minimal.slices.map(s=>[s.index,s.z,s.zBottom]),plain.slices.map(s=>[s.index,s.z,s.zBottom]));
assert.equal(report.branches.junctions.length,1);const joint=report.branches.junctions[0];assert.equal(joint.contacts,3);
const trunk=report.branches.sections.find(s=>!s.parent),children=report.branches.sections.filter(s=>s.parent===trunk.id);
assert.equal(children.length,2);assert.ok(children.every(c=>c.firstLayer===trunk.lastLayer),'exactly one shared sheet at the section boundary');
assert.equal(joint.layer,trunk.lastLayer);
assert.equal(report.contacts.filter(c=>c.layer===joint.layer).length,3);
assert.equal(new Set(report.parts.map(s=>s.part.id)).size,report.parts.length);
assert.equal(report.branches.order.length,report.parts.length);
for(const section of report.branches.sections){
  const contacts=report.contacts.filter(c=>c.id.startsWith(section.id+'-support-'));
  for(const s of minimal.slices.filter(s=>s.index>=section.firstLayer&&s.index<=section.lastLayer))
    assert.equal(contacts.filter(c=>c.layer===s.index).length,report.branches.count,'each section covers every interior layer');
}
assert.ok(report.branches.excluded.length>0,'closed ends remain explicit');
for(const e of report.branches.excluded)assert.ok(!report.contacts.some(c=>c.layer===e.layer),'this fixture has closed end rows, not hidden interior gaps');
// Contact material is checked in the physical frame, on both sides of every
// opposing slot and through the full stock slab, not from metadata alone.
for(const part of report.parts){
  const p=part.part,spine=field(part.nominalContours);
  for(const contact of report.contacts.filter(c=>c.id===p.id)){
    const sheet=minimal.slices.find(s=>s.index===contact.layer),horizontal=field(sheet.nominalContours);
    const world=(u,v)=>[p.origin[0]+p.u[0]*u+p.n[0]*v,p.origin[1]+p.u[1]*u+p.n[1]*v];
    for(const z of [sheet.zBottom+.03,sheet.z,sheet.zBottom+job.thickness-.03]){
      assert.ok(spine(contact.split-.5,z)<0,'support retains the inner shoulder');
      assert.ok(spine(contact.split+.5,z)>0,'vertical notch clears the complete horizontal stock');
    }
    assert.ok(horizontal(...world(contact.split+.5,0))<0,'horizontal sheet retains the outer shoulder');
    for(const v of [-job.thickness/2,0,job.thickness/2])assert.ok(horizontal(...world(contact.split-.5,v))>0,'horizontal notch clears support thickness');
  }
}
const common=minimal.slices.find(s=>s.index===joint.layer);assert.equal(groupContours(common.nominalContours).length,1);
const centres=report.contacts.filter(c=>c.layer===joint.layer).map(c=>{const p=report.parts.find(s=>s.part.id===c.id).part;return[p.origin[0]+p.u[0]*c.split,p.origin[1]+p.u[1]*c.split]});
for(let i=0;i<centres.length;i++)for(let j=i+1;j<centres.length;j++)assert.ok(Math.hypot(centres[i][0]-centres[j][0],centres[i][1]-centres[j][1])>job.thickness+2*job.minFeature,'three distinct joint sites, not overlapping duplicates');
assert.equal(supportCollision(report.parts[0],structuredClone(report.parts[0]),kernel),true,'collision guard actually detects coincident stock');
console.log('  ok    one shared layer, three real joints, complete section coverage, closed ends and full-stock shoulders');

const denseFeatures=structuredClone(features);denseFeatures.at(-1).params.branchCount=3;
const dense=run({features:denseFeatures});assert.deepEqual(errors(dense),[]);assert.equal(dense.verticalSupports.parts.length,9);
assert.equal(dense.verticalSupports.branches.junctions[0].contacts,9);
assert.ok(dense.verticalSupports.parts.every(p=>p.part.thickness===job.thickness&&p.part.kerf===job.kerf));
assert.deepEqual(dense.verticalSupports.branches.sections.map(s=>[s.firstLayer,s.lastLayer]),report.branches.sections.map(s=>[s.firstLayer,s.lastLayer]));
const invalidFeatures=structuredClone(features);invalidFeatures.at(-1).params.branchCount=7;
const invalid=run({features:invalidFeatures});assert.equal(invalid.verticalSupports.parts.length,0);assert.ok(errors(invalid).some(i=>/1–6/.test(i.message)));
assert.deepEqual(invalid.slices,plain.slices,'refused branch layout leaves every original cut unchanged');
const thinFeatures=structuredClone(features);thinFeatures.find(f=>f.kind==='shell').params.t=2;
const thin=run({features:thinFeatures});assert.equal(thin.verticalSupports.parts.length,0);assert.ok(errors(thin).length>0,'thin walls are not made safe by reducing the requested count');
console.log('  ok    nine-joint option, unique cut parts, requested stock/count, explicit all-or-nothing refusals');

const shiftedFeatures=structuredClone(features);
for(const f of shiftedFeatures.filter(f=>f.stage==='SHAPE')){f.params.px=Number(f.params.px??0)+7;f.params.py=Number(f.params.py??0)-4;}
const shifted=run({features:shiftedFeatures,thickness:4,spacerHeight:8,twistPerLayer:.5});
assert.deepEqual(errors(shifted),[]);assert.ok(shifted.verticalSupports.parts.every(p=>p.part.thickness===4));
assert.notDeepEqual(shifted.verticalSupports.branches.sections.map(s=>s.centre),report.branches.sections.map(s=>s.centre));
for(const p of shifted.verticalSupports.parts)for(const c of shifted.verticalSupports.contacts.filter(c=>c.id===p.part.id)){
  const s=shifted.slices.find(s=>s.index===c.layer),a=-(s.index-1)*.5*Math.PI/180;
  const x=p.part.origin[0]+p.part.u[0]*(c.split-.5),y=p.part.origin[1]+p.part.u[1]*(c.split-.5);
  assert.ok(field(s.nominalContours)(x*Math.cos(a)-y*Math.sin(a),x*Math.sin(a)+y*Math.cos(a))>0,'actual sheet twist counter-rotates every branch notch');
}
const noKerf=run({kerf:0});assert.deepEqual(errors(noKerf),[]);
for(const p of minimal.verticalSupports.parts){const zero=noKerf.verticalSupports.parts.find(q=>q.part.id===p.part.id),nominal=field(zero.nominalContours);
  for(const c of p.contours)for(let i=0;i<c.points.length;i+=14)assert.ok(Math.abs(nominal(c.points[i],c.points[i+1])-job.kerf/2)<.04,'one in-plane kerf offset on support paths');}
console.log('  ok    changed stock, translated source, actual graded heights/twist and one kerf compensation');

const server=await createServer({configFile:false,server:{middlewareMode:true,watch:null,hmr:false,ws:false},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom'});
try{
  const {useKerros}=await server.ssrLoadModule('/src/core/store.ts');
  const {VerticalSupportsInspector}=await server.ssrLoadModule('/src/ui/Inspector.tsx');
  const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
  useKerros.getState().addShape('sphere');useKerros.getState().addVerticalSupports();
  assert.equal(useKerros.getState().features.find(f=>f.kind==='verticalSupports').params.branchCount,1);
  const data=useKerros.getState().projectData();data.features=denseFeatures;data.material.thickness=job.thickness;
  const saved=parseProject(serializeProject(data,'test'));assert.ok(saved.ok);assert.deepEqual(saved.warnings,[]);
  useKerros.getState().applyProject(saved.data,saved.nextFeatureNumber);
  assert.equal(useKerros.getState().features.at(-1).params.branchCount,3);
  const html=renderToStaticMarkup(createElement(VerticalSupportsInspector,{feature:denseFeatures.at(-1),slices:dense,fresh:true,mode:'stack'}));
  for(const label of ['Supports per branch','9 joints','Branch coverage','Insertion order'])assert.ok(html.includes(label),label);
  const stale=renderToStaticMarkup(createElement(VerticalSupportsInspector,{feature:denseFeatures.at(-1),slices:dense,fresh:false,mode:'stack'}));assert.ok(!stale.includes('Shared layer'));
  const {buildParts,sheetToDxf,manifestText,assemblyDocument}=await server.ssrLoadModule('/src/core/job.ts');
  const {nestByMaterial}=await server.ssrLoadModule('/src/core/nest.ts');const {writeDxfR12}=await server.ssrLoadModule('/src/core/dxf.ts');const {writePdf}=await server.ssrLoadModule('/src/core/pdf.ts');
  const parts=buildParts(dense,[]),nest=nestByMaterial(parts,{sheetWidth:720,sheetHeight:400,gap:4,labelHeight:3,trueShape:false,cell:2});assert.equal(nest.unplaced.length,0);
  assert.ok(dense.verticalSupports.parts.every(p=>parts.some(part=>part.id.startsWith(p.part.id))));
  for(const sheet of nest.sheets)assert.ok(!/NaN|Infinity/.test(writeDxfR12(sheetToDxf(sheet))));
  const input={set:dense,sheets:nest.sheets,spacers:[],machineName:'Test',materialName:'Test',thickness:job.thickness,kerf:job.kerf,spacerHeight:9,spacerAchieved:9,ringThickness:3,version:'test',projectName:'Branch joints'};
  const manifest=manifestText(input);assert.ok(manifest.includes('9 joints'));assert.ok(manifest.includes('Insertion order'));assert.ok(writePdf(assemblyDocument(input)).startsWith('%PDF'));
  const previous=globalThis.self,replies=[];globalThis.self={postMessage:r=>replies.push(structuredClone(r))};
  try{await server.ssrLoadModule('/src/ui/kerros.worker.ts');globalThis.self.onmessage({data:{kind:'slice',token:1,job:{...job,features:useKerros.getState().features}}});assert.deepEqual(replies.at(-1).output.set,dense,'saved project and real worker preserve every branch part and contact');}finally{globalThis.self=previous;}
  console.log('  ok    reachable count/coverage controls, persistence, stale status, worker parity, nesting, DXF, manifest and PDF');
}finally{await server.close();}
console.log('OK    branched stack supports and shared-layer joints');
