#!/usr/bin/env node
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
const server=await createServer({configFile:false,server:{middlewareMode:true,watch:null,hmr:false,ws:false},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom'});
try {
  const {useKerros}=await server.ssrLoadModule('/src/core/store.ts');
  const {parseProject,serializeProject}=await server.ssrLoadModule('/src/core/project.ts');
  const {runSliceJob,runNestJob,rehydrateNest}=await server.ssrLoadModule('/src/core/pipeline.ts');
  const {buildParts,sheetToDxf,manifestText,assemblyDocument}=await server.ssrLoadModule('/src/core/job.ts');
  const {writeDxfR12}=await server.ssrLoadModule('/src/core/dxf.ts');
  const {writePdf}=await server.ssrLoadModule('/src/core/pdf.ts');
  const state=()=>useKerros.getState();
  state().addShape('roundBox');
  const source=state().features[0];
  for (const [key,value] of Object.entries({sx:140,sy:120,sz:200,pz:100,r:4})) state().setParam(source.id,key,value);
  state().addAssembly('linear');
  const layout=state().features.find(f=>f.kind==='assembly:layout');
  assert.equal(state().mode,'stack');assert.equal(state().selectedId,layout.id);
  const ribs=state().features.filter(f=>f.kind==='assembly:rib');
  state().setAssemblyAngle(ribs[0].id,12,false);
  state().setAssemblyAngle(ribs[1].id,-7,false);
  state().setAssemblyAllFollow(true);
  const unchanged=structuredClone(state().features);
  state().setAssemblyAllFollow(false);assert.deepEqual(state().features,unchanged,'scope changes no geometry');
  state().setAssemblyAngle(ribs[0].id,20,true);
  assert.equal(state().features.find(f=>f.id===ribs[1].id).params.angle,1,'all follow preserves differences');
  state().setTransform(ribs[0].id,{px:3,py:2,pz:1});
  const kept=structuredClone(state().features.filter(f=>ribs.slice(0,5).some(r=>r.id===f.id)));
  state().setAssemblyCount(layout.id,'rib',5);
  assert.deepEqual(state().features.filter(f=>f.kind==='assembly:rib'),kept);
  const deleted=ribs.slice(5).map(f=>f.id);
  const watermark=state().nextFeatureNumber;
  const reduced=parseProject(serializeProject(state().projectData(),'0.29.0','2026-09-13T00:00:00Z'));
  assert.equal(reduced.nextFeatureNumber,watermark,'reopening preserves deleted ID reservations');
  state().applyProject(reduced.data,reduced.nextFeatureNumber);
  state().setAssemblyCount(layout.id,'rib',7);
  assert.ok(state().features.filter(f=>f.kind==='assembly:rib').every(f=>!deleted.includes(f.id)),'deleted IDs are never reused');
  state().addAssemblyMember(layout.id,'channel');
  const channel=state().features.at(-1);
  const beforePose=state().features;
  let poseNotifications=0;
  const unsubscribe=useKerros.subscribe(()=>poseNotifications++);
  const pose={px:7,py:24,pz:-3,yaw:21,elevation:17,roll:63};
  state().setAssemblyAllFollow(true);
  poseNotifications=0;
  state().setAssemblyChannelPose(channel.id,pose);
  assert.equal(poseNotifications,1,'a channel drag commits one complete pose');
  unsubscribe();
  for (const feature of state().features) {
    if (feature.id===channel.id) for (const [key,value] of Object.entries(pose)) assert.equal(feature.params[key],value);
    else assert.deepEqual(feature,beforePose.find(f=>f.id===feature.id),'channel edits never move ribs, even with All follow');
  }
  const validPose=state().features;
  state().setAssemblyChannelPose(channel.id,{yaw:NaN});assert.deepEqual(state().features,validPose);
  state().setAssemblyChannelPose(ribs[0].id,{yaw:45});assert.deepEqual(state().features,validPose);
  state().setParam(channel.id,'shape','strip');state().setParam(channel.id,'targetIds',ribs[0].id);
  state().addAssemblyMember(layout.id,'rib');
  const lastId=state().features.at(-1).id;
  state().setParam(channel.id,'targetIds',lastId);
  state().removeFeature(lastId);
  const lastWatermark=state().nextFeatureNumber;
  const pruned=parseProject(serializeProject(state().projectData(),'0.29.0','2026-09-13T00:00:00Z'));
  state().applyProject(pruned.data,pruned.nextFeatureNumber);
  state().addAssemblyMember(layout.id,'rib');
  assert.equal(state().features.at(-1).id,`f${lastWatermark}`);
  assert.notEqual(state().features.at(-1).id,lastId,'a dangling target cannot bind to a new part after reopening');
  state().removeFeature(state().features.at(-1).id);
  state().setParam(channel.id,'targetIds',ribs[0].id);
  const before=state().projectData();
  const saved=serializeProject(before,'0.29.0','2026-09-13T00:00:00Z');
  const opened=parseProject(saved);assert.ok(opened.data);assert.deepEqual(opened.data.features,before.features);
  state().applyProject(opened.data,opened.nextFeatureNumber);
  assert.deepEqual(state().projectData().features,before.features);
  console.log('  ok    store creation, linked angles, retained identities, atomic channel pose and project roundtrip');

  // A clean build exercises every output through the actual composition layer.
  state().removeFeature(layout.id);
  assert.ok(!state().features.some(f=>f.kind.startsWith('assembly:')),'deleting the layout removes its members');
  state().addAssembly('linear');
  const group=state().features.find(f=>f.kind==='assembly:layout');
  state().addAssemblyMember(group.id,'channel');
  const back=state().features.find(f=>f.kind==='assembly:backplate');
  state().setParam(back.id,'ownMaterial',true);state().setParam(back.id,'thickness',5);state().setParam(back.id,'kerf',.12);
  const job={features:state().features,thickness:3,kerf:.15,materialName:'Birch',spacerHeight:6,resolution:120,tolerance:.03,smoothing:1,minFeature:1,seed:7};
  const output=runSliceJob(job,new Map());
  assert.equal(output.set.assembly.cuttable,true,JSON.stringify(output.set.assembly.issues));
  const parts=buildParts(output.set,[]);
  assert.equal(parts.length,10);
  assert.equal(new Set(parts.map(p=>p.material)).size,2);
  for (const part of parts) assert.equal(part.id.split('-')[0],output.set.slices.find(s=>s.part.label===part.label).part.id);
  const options={sheetWidth:720,sheetHeight:400,gap:4,labelHeight:3,trueShape:false,cell:2};
  const pack=runNestJob({parts,options});
  const nested=rehydrateNest(pack,parts);assert.equal(nested.unplaced.length,0);
  assert.ok(nested.sheets.every(s=>s.parts.every(p=>p.material===s.material)));
  const docs=nested.sheets.map(sheetToDxf);
  for (const doc of docs) { const text=writeDxfR12(doc);assert.ok(text.includes('CUT'));assert.ok(!/NaN|Infinity/.test(text)); }
  const input={set:output.set,sheets:nested.sheets,spacers:[],machineName:'Test bed',materialName:'Birch',thickness:3,kerf:.15,spacerHeight:6,spacerAchieved:0,version:'0.29.0',projectName:'Upright assembly validation',ringThickness:3};
  const manifest=manifestText(input);
  for (const p of parts) assert.ok(manifest.includes(p.label),p.label);
  assert.ok(manifest.includes('LED CHANNELS')&&manifest.includes('JOINTS AND INSERTION'));
  const pages=assemblyDocument(input);assert.ok(pages.length>=4);
  assert.ok(pages.every(p=>p.polylines.every(line=>line.points.every(Number.isFinite))));
  const pdf=writePdf(pages);assert.ok(pdf.startsWith('%PDF'));
  if (process.env.KERROS_VALIDATION_ARTIFACTS) {
    writeFileSync(join(process.env.KERROS_VALIDATION_ARTIFACTS,'kerros-assembly-validation.pdf'),pdf,'binary');
    writeFileSync(join(process.env.KERROS_VALIDATION_ARTIFACTS,'kerros-assembly-validation.kerros.json'),serializeProject(state().projectData(),'0.29.0','2026-09-13T00:00:00Z'));
  }
  console.log('  ok    material separation, persistent labels, nesting, DXF, manifest and assembly PDF');

  const previous=globalThis.self, replies=[];
  globalThis.self={postMessage(message){replies.push(structuredClone(message));}};
  try { await server.ssrLoadModule('/src/ui/kerros.worker.ts');globalThis.self.onmessage({data:{kind:'slice',token:47,job}});const reply=replies.at(-1);assert.equal(reply.kind,'sliced');assert.equal(reply.token,47);assert.deepEqual(reply.output.set,output.set); }
  finally {globalThis.self=previous;}
  console.log('  ok    real worker transport returns the same complete assembly');
  console.log('OK    assembly state and exports');
} finally {await server.close();}
