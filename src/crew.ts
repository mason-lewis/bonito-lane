import * as THREE from 'three/webgpu';
import { assetUrl } from './asset-url';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {CrewNavigation,type CrewYard} from './crew-navigation';
import {CrewBehavior} from './crew-behavior';
import type {Physics} from './physics';
export interface CrewScene { update(dt:number):void;setVisible(value:boolean):void;previewClip(name:string):void;dispose():void; readonly diagnostics:Record<string,unknown> }
export async function createCrew(scene:THREE.Scene,physics:Physics):Promise<CrewScene>{
  const [gltf,response]=await Promise.all([new GLTFLoader().loadAsync(assetUrl('/models/crew.glb')),fetch(assetUrl('/data/crew-yard.json'))]);
  if(!response.ok)throw Error('Crew yard metadata is unavailable.');
  const yard=await response.json() as CrewYard;
  const nav=new CrewNavigation(yard,p=>physics.crewClear(p[0],p[1],yard.radius,yard.groundY),p=>physics.terrainSurface(p[0],p[1],yard.groundY));
  const start=nav.nearest([2,13]);if(!start)throw Error('Crew has no reachable yard surface.');
  const root=new THREE.Group();root.name='Crew roaming root';root.add(gltf.scene);scene.add(root);
  gltf.scene.traverse(o=>{if((o as THREE.Mesh).isMesh){o.castShadow=true;o.receiveShadow=true;o.frustumCulled=false;}});
  const mixer=new THREE.AnimationMixer(gltf.scene),actions=new Map<string,THREE.AnimationAction>();
  for(const name of ['Idle','Walk','Sniff','LookAround']){
    const clip=gltf.animations.find(c=>c.name===name);if(!clip)throw Error(`Crew clip ${name} missing from GLB.`);
    actions.set(name,mixer.clipAction(clip));
  }
  const idle=actions.get('Idle')!.play(),walk=actions.get('Walk')!.play();walk.setEffectiveWeight(0);
  const behavior=new CrewBehavior(nav,start);
  let active=idle,walkWeight=0,enabled=true,accumulator=0,preview:string|null=null;
  function step(dt:number){
    if(!preview)behavior.step(dt);else behavior.elapsed+=dt;
    const {speed:velocity,position,heading,state}=behavior;
    const nominal=behavior.nominalSpeed;
    const desired=actions.get((preview||state)==='Walk'?'Idle':preview||state)!;
    if(desired!==active){desired.reset().play();active.crossFadeTo(desired,.45,false);active=desired;}
    const targetWeight=preview==='Walk'?1:velocity/nominal;walkWeight+=Math.max(-dt*2.5,Math.min(dt*2.5,targetWeight-walkWeight));
    walk.setEffectiveWeight(walkWeight);walk.setEffectiveTimeScale(preview==='Walk'?1:walkWeight>.001?velocity/(nominal*walkWeight):0);
    // Idle is the standing basis during locomotion. Other clips crossfade via mixer.
    if(active===idle)idle.setEffectiveWeight(1-walkWeight);
    mixer.update(dt);
    const ground=nav.surface(position);if(!ground)return;
    root.position.set(position[0],ground.y+.006,position[1]);
    // Align with sampled support normal, without sudden pitch changes. The yard
    // is currently flat; the same sampling supports a modest continuous slope.
    const up=new THREE.Vector3(ground.nx,ground.ny,ground.nz).normalize();
    const align=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),up);
    const yaw=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),heading);
    root.quaternion.slerp(align.multiply(yaw),1-Math.exp(-dt*10));
  }
  root.position.set(start[0],nav.surface(start)!.y+.006,start[1]);
  return{
    update(dt){if(!enabled)return;accumulator+=Math.min(dt,.1);while(accumulator>=1/60){step(1/60);accumulator-=1/60;}},
    previewClip(name){if(!actions.has(name))throw Error(`Unknown Crew clip ${name}`);preview=name;behavior.path=[];behavior.speed=0;behavior.state=name as typeof behavior.state;},
    setVisible(value){enabled=value;root.visible=value;accumulator=0;},
    get diagnostics(){return {state:behavior.state,position:[...root.position.toArray()],heading:behavior.heading,speed:behavior.speed,walkWeight,elapsed:behavior.elapsed,cycles:behavior.cycles,blocked:behavior.blocked,distance:behavior.distance,path:behavior.path.map(p=>[...p]),reachableCells:nav.cells.length,clips:gltf.animations.map(c=>({name:c.name,duration:c.duration})),asset:'/models/crew.glb'};},
    dispose(){mixer.stopAllAction();mixer.uncacheRoot(gltf.scene);root.removeFromParent();const skeletons=new Set<THREE.Skeleton>(),geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>();gltf.scene.traverse(o=>{const mesh=o as THREE.Mesh;if(!mesh.isMesh)return;if((mesh as THREE.SkinnedMesh).isSkinnedMesh)skeletons.add((mesh as THREE.SkinnedMesh).skeleton);geometries.add(mesh.geometry);for(const m of Array.isArray(mesh.material)?mesh.material:[mesh.material]){materials.add(m);for(const v of Object.values(m))if(v instanceof THREE.Texture)textures.add(v);}});skeletons.forEach(s=>s.dispose());geometries.forEach(g=>g.dispose());textures.forEach(t=>t.dispose());materials.forEach(m=>m.dispose());},
  };
}
