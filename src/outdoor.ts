/** Blender-authored lawn and planting beds, instanced with portable TSL wind. */
import * as THREE from 'three/webgpu';
import { assetUrl } from './asset-url';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {attribute, cameraPosition, color, float, positionGeometry, positionLocal, positionWorld, sin, smoothstep, texture, uniform, vec3} from 'three/tsl';

export const OUTDOOR_HAZE = '#d3dfdf';
type PlantPoint = [number,number,number,number,number,number];
interface OutdoorData {
  groundY:number;prototypeHeightM?:number;grassTufts:PlantPoint[];
  lawnHeightM?:number;lawnTufts?:PlantPoint[];provenance:string;
}
export interface OutdoorScene {
  update(dt:number,time:number):void;
  setQuality(low:boolean):void;
  setVisible(visible:boolean):void;
  dispose():void;
  readonly stats:{grassTufts:number;lawnTufts:number;sedgeTufts:number;grassBatches:number;cloudBanks:number;source:string};
}

export async function createOutdoor(scene:THREE.Scene,camera:THREE.Camera,maxBatchInstances=1000):Promise<OutdoorScene> {
  const loader=new GLTFLoader();
  const [sedge, lawn, response] = await Promise.all([
    loader.loadAsync(assetUrl('/models/coastal-grass.glb')),
    loader.loadAsync(assetUrl('/models/lawn-grass.glb')),
    fetch(assetUrl('/data/outdoor.json')),
  ]);
  if(!response.ok)throw new Error('Outdoor planting metadata could not load.');
  const data=await response.json() as OutdoorData;
  const root=new THREE.Group();root.name='Blender lawns and coastal planting';scene.add(root);
  const clock=uniform(0);
  const grass:THREE.InstancedMesh[]=[];
  const materials:THREE.MeshStandardNodeMaterial[]=[];
  const lawnStart=uniform(8),lawnEnd=uniform(16),sedgeStart=uniform(48),sedgeEnd=uniform(65);
  const matrix=new THREE.Matrix4(),rotation=new THREE.Quaternion(),scale=new THREE.Vector3(),origin=new THREE.Vector3(),up=new THREE.Vector3(0,1,0);

  // Exported standard PBR maps remain authoritative. A subtle nonrepeating
  // world-space multiplier adds broad lawn variation across tile boundaries.
  const groundMaterials=new Map<THREE.Material,THREE.MeshStandardNodeMaterial>();
  const groundMeshes:{mesh:THREE.Mesh;material:THREE.Material|THREE.Material[]}[]=[];
  scene.traverse(object=>{
    const mesh=object as THREE.Mesh;if(!mesh.isMesh)return;
    const original=Array.isArray(mesh.material)?mesh.material:[mesh.material];
    if(!original.some(material=>material.name==='sand-grass'))return;
    groundMeshes.push({mesh,material:mesh.material});
    const replaced=original.map(source=>{
      if(source.name!=='sand-grass')return source;
      if(groundMaterials.has(source))return groundMaterials.get(source)!;
      const standard=source as THREE.MeshStandardMaterial;
      const material=new THREE.MeshStandardNodeMaterial({map:standard.map,normalMap:standard.normalMap,roughnessMap:standard.roughnessMap,roughness:standard.roughness,metalness:0,color:standard.color,side:standard.side});
      material.name='Maintained lawn PBR with broad variation';material.normalScale.copy(standard.normalScale);
      const x=positionWorld.x,z=positionWorld.z;
      const broad=sin(x.mul(.109).add(sin(z.mul(.067)).mul(2.4))).mul(sin(z.mul(.089).sub(x.mul(.031))));
      const medium=sin(x.mul(.43).add(z.mul(.21))).mul(sin(z.mul(.37).sub(x.mul(.17))));
      const variation=float(1).add(broad.mul(.075)).add(medium.mul(.025));
      material.colorNode=(standard.map?texture(standard.map):color(standard.color)).mul(variation);
      groundMaterials.set(source,material);materials.push(material);return material;
    });
    mesh.material=Array.isArray(mesh.material)?replaced:replaced[0];
  });

  for(const kind of [
    {name:'Lawn',asset:lawn,points:data.lawnTufts??[],height:data.lawnHeightM??.085,start:lawnStart,end:lawnEnd,wind:.003,cellSize:8},
    {name:'Sedge bed',asset:sedge,points:data.grassTufts,height:data.prototypeHeightM??.62,start:sedgeStart,end:sedgeEnd,wind:.022,cellSize:12},
  ]){
    let prototype:THREE.BufferGeometry|undefined;
    kind.asset.scene.updateMatrixWorld(true);
    kind.asset.scene.traverse(object=>{if(!prototype&&(object as THREE.Mesh).isMesh)prototype=(object as THREE.Mesh).geometry.clone().applyMatrix4(object.matrixWorld);});
    if(!prototype)throw new Error(`Blender ${kind.name} asset contains no mesh.`);
    const material=new THREE.MeshStandardNodeMaterial({roughness:.94,metalness:0,side:THREE.DoubleSide,vertexColors:true});
    material.name=`${kind.name} shared wind material`;materials.push(material);
    const tip=positionGeometry.y.div(kind.height).clamp(0,1);
    const phase=attribute('plantPhase');
    const breeze=sin(clock.mul(1.25).add(phase)).mul(kind.wind).add(sin(clock.mul(.55).add(phase.mul(.31))).mul(kind.wind*.5));
    // Per-root world distance shrinks blades continuously into the textured
    // turf before a batch is culled. Moving/rotating does not expose LOD rings.
    const plantRoot=attribute('plantRoot');
    const fade=float(1).sub(smoothstep(kind.start,kind.end,cameraPosition.distance(plantRoot)));
    // r180 applies instanceMatrix before positionNode. Subtract the translated
    // root before shrinking, or the entire patch slides toward the world origin.
    material.positionNode=plantRoot.add(positionLocal.sub(plantRoot).add(vec3(breeze,0,breeze.mul(.38)).mul(tip.pow(2))).mul(fade));
    material.colorNode=color('#ffffff').mul(attribute('grassTint'));
    const cells=new Map<string,PlantPoint[]>();
    for(const point of kind.points){const key=`${Math.floor(point[0]/kind.cellSize)}:${Math.floor(point[2]/kind.cellSize)}`;const cell=cells.get(key)||[];cell.push(point);cells.set(key,cell);}
    // Three r180 stores small instance-matrix arrays in a uniform buffer.
    // Explicit WebGL uses at most 256 mat4s to fit a 16 KiB uniform-block limit.
    // The WebGPU default keeps the original spatial batches unchanged.
    for(const [key,cellPoints] of cells){
     for(let offset=0;offset<cellPoints.length;offset+=maxBatchInstances){
      const points=cellPoints.slice(offset,offset+maxBatchInstances);
      const geometry=prototype.clone(),tint=new Float32Array(points.length),phases=new Float32Array(points.length),roots=new Float32Array(points.length*3);
      const mesh=new THREE.InstancedMesh(geometry,material,points.length);mesh.name=`${kind.name} ${key}${offset?` part ${offset/maxBatchInstances+1}`:''}`;
      points.forEach((p,i)=>{
        rotation.setFromAxisAngle(up,p[4]);scale.setScalar(p[3]);origin.set(p[0],p[1],p[2]);matrix.compose(origin,rotation,scale);mesh.setMatrixAt(i,matrix);
        tint[i]=p[5]??1;phases[i]=p[0]*.52+p[2]*.38;roots.set(p.slice(0,3),i*3);
      });
      geometry.setAttribute('grassTint',new THREE.InstancedBufferAttribute(tint,1));
      geometry.setAttribute('plantPhase',new THREE.InstancedBufferAttribute(phases,1));
      geometry.setAttribute('plantRoot',new THREE.InstancedBufferAttribute(roots,3));
      mesh.instanceMatrix.needsUpdate=true;
      mesh.receiveShadow=true;
      // Very short lawn blades need no shadow-map pass. Taller beds retain
      // their contact shadows at normal quality.
      mesh.castShadow=kind.name!=='Lawn';mesh.computeBoundingBox();mesh.computeBoundingSphere();mesh.boundingSphere!.radius+=kind.wind*1.6;
      mesh.userData.fullCount=points.length;mesh.userData.lawn=kind.name==='Lawn';
      root.add(mesh);grass.push(mesh);
     }
    }
    prototype.dispose();
  }
  let low=false,enabled=true,cullClock=1;
  const stats={grassTufts:data.grassTufts.length+(data.lawnTufts?.length??0),lawnTufts:data.lawnTufts?.length??0,sedgeTufts:data.grassTufts.length,grassBatches:grass.length,cloudBanks:0,source:data.provenance};
  return {
    stats,
    update(dt,time){
      clock.value=time;cullClock+=dt;
      if(cullClock>.2){
        cullClock=0;
        for(const mesh of grass){
          const sphere=mesh.boundingSphere!;
          const distance=camera.position.distanceTo(sphere.center)-sphere.radius;
          mesh.visible=enabled&&distance<(mesh.userData.lawn?lawnEnd.value:sedgeEnd.value);
        }
      }
    },
    setQuality(value){
      low=value;lawnStart.value=low?6:8;lawnEnd.value=low?11:16;sedgeStart.value=low?28:48;sedgeEnd.value=low?38:65;
      for(const mesh of grass){mesh.count=Math.floor(mesh.userData.fullCount*(low?.60:1));mesh.castShadow=!low&&!mesh.userData.lawn;}cullClock=1;
    },
    setVisible(value){enabled=value;root.visible=value;cullClock=1;},
    dispose(){
      root.removeFromParent();for(const mesh of grass)mesh.geometry.dispose();
      for(const entry of groundMeshes)entry.mesh.material=entry.material;
      materials.forEach(material=>material.dispose());
      for(const asset of [lawn,sedge])asset.scene.traverse(object=>{
        if((object as THREE.Mesh).isMesh){const mesh=object as THREE.Mesh;mesh.geometry.dispose();for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material])material.dispose();}
      });
    },
  };
}
