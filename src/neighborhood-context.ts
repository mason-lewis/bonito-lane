import type * as THREE from 'three/webgpu';
import { assetUrl } from './asset-url.ts';
import type {Physics} from './physics';
import type {Vec3} from './schema';

export interface NeighborhoodSelection {
  contextLoadBoundary:{min:number[];max:number[]};
  contextModel:string;contextData:string;surveyCameraCount:number;
}
/** Coordinates in this authoring sidecar remain Blender Z-up. */
export interface ContextCollider {id:string;center:Vec3;halfExtents:Vec3}
export function contextCollider(c:ContextCollider){
  return {id:c.id,center:[c.center[0],c.center[2],-c.center[1]] as Vec3,
    halfExtents:[c.halfExtents[0],c.halfExtents[2],c.halfExtents[1]] as Vec3,phase:'neighborhood' as const};
}
export function needsNeighborhoodContext(position:Vec3,boundary:NeighborhoodSelection['contextLoadBoundary']) {
  const [x,,z]=position;const y=-z;
  return x<boundary.min[0]||x>boundary.max[0]||y<boundary.min[1]||y>boundary.max[1];
}
export function createNeighborhoodContext(selection:NeighborhoodSelection|undefined,physics:Physics,loadModel:(path:string,label:string)=>Promise<THREE.Group>,onError:(message:string)=>void){
  let state:'not-requested'|'loading'|'loaded'|'failed'='not-requested';
  let pending:Promise<void>|undefined,model:THREE.Group|undefined,retryAfter=0;
  let colliderCount=0,visible=true;
  const load=()=>{
    if(!selection||state==='loaded')return Promise.resolve();
    if(pending)return pending;
    state='loading';
    pending=(async()=>{
      try{
        const response=await fetch(assetUrl(selection.contextData));if(!response.ok)throw Error('Wider neighborhood metadata could not load.');
        const sidecar=await response.json() as {colliders:ContextCollider[]};
        model=await loadModel(selection.contextModel,'Wider neighborhood');
        model.visible=visible;
        // Collisions arrive with their matching visible shells, only once.
        for(const collider of sidecar.colliders)physics.add(contextCollider(collider));
        colliderCount=sidecar.colliders.length;state='loaded';
      }catch(error){state='failed';retryAfter=performance.now()+10000;onError(error instanceof Error?error.message:String(error));}
      finally{pending=undefined;}
    })();
    return pending;
  };
  return {
    load,
    update(position:Vec3){if(selection&&state!=='loaded'&&state!=='loading'&&performance.now()>=retryAfter&&needsNeighborhoodContext(position,selection.contextLoadBoundary))void load();},
    setVisible(value:boolean){visible=value;if(model)model.visible=value;},
    get diagnostics(){return {state,colliderCount,source:selection?.contextModel,surveyCameraCount:selection?.surveyCameraCount};},
  };
}
