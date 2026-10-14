import * as THREE from 'three/webgpu';

/** Fixed browser cameras; copied unchanged into the baseline for matched evidence. */
export const QA_VIEWS = [
  {id:'driveway-house',label:'Driveway toward house',eye:[6.05155,1.36,13],target:[6.05155,5.1,0]},
  {id:'driveway-out',label:'Driveway outward',eye:[6.05155,1.36,13],target:[6.05,2,50]},
  {id:'street',label:'Along Bonito Lane',eye:[6.05,1.36,23.89],target:[55,2,24]},
  {id:'yard-crew',label:'Front yard with Crew',eye:[-1.8,1.36,15],target:[4,.45,10]},
  {id:'side-yard',label:'Side yard',eye:[-3.6,1.36,-6],target:[-17,2,-26]},
  {id:'living-out',label:'Living room looking outside',eye:[9,4.62,-4.3],target:[8.7,4,20]},
  {id:'porch',label:'Second floor porch',eye:[2.1,4.52,-3.9],target:[-6,3,25]},
  {id:'balcony',label:'Rear-side deck',eye:[3.4,7.78,-11.95],target:[-25,5,-26]},
  {id:'roof-front',label:'Roof deck toward street',eye:[2.45,11.42,-8.25],target:[2.45,5,70]},
  {id:'roof-left',label:'Roof deck left',eye:[2.45,11.42,-8.25],target:[-70,5,-8.25]},
  {id:'roof-back',label:'Roof deck rear',eye:[2.45,11.42,-8.25],target:[2.45,5,-80]},
  {id:'roof-right',label:'Roof deck right',eye:[2.45,11.42,-8.25],target:[80,5,-8.25]},
  {id:'neighbor',label:'Nearby neighbor',eye:[14,1.36,13],target:[21,3,-1]},
  {id:'grass-edge',label:'Grass and driveway edge',eye:[3.2,.55,9],target:[2.4,-.27,5]},
  {id:'vehicle',label:'Tesla close',eye:[3.8,1.3,8],target:[6.8,.6,4]},
  {id:'crew-close',label:'Crew close',eye:[.25,.65,15.5],target:[2,.25,13]},
] as const;
type Preset = typeof QA_VIEWS[number];

export function installVisualQA(options:{
  scene:THREE.Scene; camera:THREE.PerspectiveCamera; renderer:THREE.WebGPURenderer;
  move:(eye:number[])=>void; metrics:()=>Record<string,unknown>; crewPreview:()=>void;
}) {
  const {scene,camera,renderer}=options;
  const host=document.createElement('details');host.id='visual-qa';
  host.style.cssText='position:fixed;z-index:100;left:12px;top:88px;max-width:440px;max-height:70vh;overflow:auto;background:#f7f7f0e8;color:#20302b;padding:8px;font:12px system-ui;border-radius:6px';
  host.innerHTML='<summary>Visual QA</summary><label>Camera <select id="qa-camera"><option value="free">Free movement</option></select></label> <button id="qa-measure">Measure 240 frames</button><output id="qa-status">Idle</output><pre id="qa-result" style="max-width:420px;white-space:pre-wrap"></pre>';
  document.body.append(host);
  const select=host.querySelector('select')!;
  for(const p of QA_VIEWS)select.add(new Option(p.label,p.id));
  let preset:Preset|undefined;
  let measuring=false,warmup=0;const samples:number[]=[];const calls:number[]=[];const triangles:number[]=[];
  const status=host.querySelector('output')!,result=host.querySelector('pre')!;
  select.addEventListener('change',()=>{
    preset=QA_VIEWS.find(p=>p.id===select.value);measuring=false;status.textContent='Idle';
    if(preset){options.move([...preset.eye]);options.crewPreview();camera.fov=65;camera.updateProjectionMatrix();}
  });
  host.querySelector('button')!.addEventListener('click',()=>{warmup=60;measuring=true;samples.length=calls.length=triangles.length=0;status.textContent='Measuring';});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&measuring){measuring=false;status.textContent='Interrupted — keep this tab visible and measure again';}});
  function inventory(){
    const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>();let objects=0,meshes=0;const groups:Record<string,{meshes:number;shadowCasters:number;triangles:number}>={};
    scene.traverse(o=>{objects++;if(!(o as THREE.Mesh).isMesh)return;meshes++;const m=o as THREE.Mesh;let ancestor:THREE.Object3D=o;while(ancestor.parent&&ancestor.parent!==scene)ancestor=ancestor.parent;const key=ancestor.name||'unnamed';const group=groups[key]??={meshes:0,shadowCasters:0,triangles:0};group.meshes++;if(m.castShadow)group.shadowCasters++;group.triangles+=(m.geometry.index?.count??m.geometry.attributes.position?.count??0)/3*((m as THREE.InstancedMesh).isInstancedMesh?(m as THREE.InstancedMesh).count:1);geometries.add(m.geometry);for(const mat of Array.isArray(m.material)?m.material:[m.material]){materials.add(mat);for(const v of Object.values(mat))if(v instanceof THREE.Texture)textures.add(v);}});
    let geometryBufferBytes=0;
    for(const g of geometries){for(const a of Object.values(g.attributes))geometryBufferBytes+=a.array.byteLength;geometryBufferBytes+=g.index?.array.byteLength||0;}
    return {objects,meshes,groups,uniqueGeometries:geometries.size,uniqueMaterials:materials.size,materialTextures:textures.size,geometryBufferBytes,geometryMemoryNote:'CPU attribute/index bytes, not GPU allocation; instance and morph buffers excluded',rendererResources:{...renderer.info.memory}};
  }
  return {
    apply(){if(preset){camera.position.fromArray(preset.eye);camera.lookAt(new THREE.Vector3().fromArray(preset.target));}},
    frame(ms:number){
      if(!measuring||document.hidden)return;
      if(warmup-->0)return;
      samples.push(ms);calls.push(renderer.info.render.drawCalls);triangles.push(renderer.info.render.triangles);
      if(samples.length<240)return;
      measuring=false;const sorted=[...samples].sort((a,b)=>a-b);const mean=(v:number[])=>v.reduce((a,b)=>a+b,0)/v.length;
      const resources=(performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(r=>/\/(models|data|environments)\//.test(r.name)).map(r=>({path:new URL(r.name).pathname,transferBytes:r.transferSize,decodedBytes:r.decodedBodySize,durationMs:r.duration}));
      const report={capturedAt:new Date().toISOString(),view:preset?.id||'free',camera:{eye:camera.position.toArray(),quaternion:camera.quaternion.toArray(),fov:camera.fov},viewport:{width:innerWidth,height:innerHeight,dpr:renderer.getPixelRatio()},userAgent:navigator.userAgent,quality:document.getElementById('quality')?.textContent,sampleFrames:samples.length,warmupFrames:60,meanFrameMs:mean(samples),p95FrameMs:sorted[Math.floor(sorted.length*.95)],fps:1000/mean(samples),meanDrawCalls:mean(calls),meanTriangles:mean(triangles),inventory:inventory(),runtime:options.metrics(),resources,assetDecodedBytes:resources.reduce((n,r)=>n+r.decodedBytes,0),assetTransferBytes:resources.reduce((n,r)=>n+r.transferBytes,0)};
      result.textContent=JSON.stringify(report,null,2);status.textContent='Complete';
    },
  };
}
